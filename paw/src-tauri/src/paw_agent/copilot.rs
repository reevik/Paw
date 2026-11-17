//! GitHub Copilot for Paw Agent, on the user's Copilot subscription.
//!
//! Paw signs in to GitHub itself with GitHub's device flow: Settings shows a
//! code, the browser opens github.com/login/device, and the user approves
//! there. The GitHub token it gets is kept in Paw's Keychain item.
//!
//! Without that sign-in Paw falls back to Copilot CLI's: the GitHub token
//! `copilot` keeps in its "copilot-cli" Keychain item for the account it
//! last signed in with (macOS may ask once whether Paw may read it). It's
//! read when a session starts and kept in memory only.
//!
//! Either token goes straight to Copilot's API, as Copilot CLI sends its own:
//! `api.github.com/copilot_internal/user` names the account's endpoint
//! (individual, business, enterprise), and the requests carry the editor
//! headers of Rig's Copilot dialect. The sign-in uses the GitHub app id VS
//! Code's Copilot uses, as other third-party clients do: GitHub offers no
//! sign-in of this kind to other apps, and it may stop accepting it.

use rig_core::driver::DynModel;
use rig_core::operation::Completion;
use rig_core::providers::copilot::{model_listing::Models, DIALECT};
use rig_core::providers::openai::OpenAIConfig;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::keychain;

pub const PROVIDER: &str = "copilot";
/// Suggested until Paw's sign-in can list the account's models.
pub const MODELS: &[&str] = &["claude-sonnet-4.6", "claude-opus-4.7", "gpt-5.5", "gpt-5.3-codex", "gemini-3.1-pro-preview"];

/// Paw's Keychain items: the GitHub token and the login it belongs to.
const TOKEN_ITEM: &str = "copilot-github-token";
const LOGIN_ITEM: &str = "copilot-login";
/// Copilot CLI's Keychain service; the account is `<host>:<login>`.
const CLI_SERVICE: &str = "copilot-cli";
/// The GitHub Copilot's API serves (api.github.com).
const GITHUB: &str = "https://github.com";
const GITHUB_API: &str = "https://api.github.com";
/// The GitHub OAuth app VS Code's Copilot signs in with.
const CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";
const USER_AGENT: &str = "GitHubCopilotChat/0.35.0";

pub const NOT_SIGNED_IN: &str = "Paw Agent isn't signed in to GitHub Copilot. Sign in with GitHub in Settings › Agents › Paw Agent \
(or sign in to Copilot CLI: run `copilot`, then /login).";

static HTTP: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(reqwest::Client::new);

pub(super) fn http() -> &'static reqwest::Client {
    &HTTP
}

/// The user's home folder (Copilot CLI's config lives under it).
pub fn user_home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| "/".into())
}

// ---------------------------------------------------------------------------
// Copilot CLI's sign-in
// ---------------------------------------------------------------------------

/// The account Copilot CLI last signed in with (`~/.copilot/config.json`,
/// JSON with `//` comments): `(host, login)`.
fn cli_user(home: &Path) -> Option<(String, String)> {
    let text = std::fs::read_to_string(home.join(".copilot/config.json")).ok()?;
    let json: String = text.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    let v: Value = serde_json::from_str(&json).ok()?;
    let u = v.get("lastLoggedInUser")?;
    let field = |k: &str| u.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    Some((field("host")?, field("login")?))
}

fn security(args: &[&str]) -> Option<std::process::Output> {
    std::process::Command::new("/usr/bin/security").args(args).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output().ok()
}

/// Copilot CLI's Keychain account, when it's on github.com.
fn cli_account(home: &Path) -> Option<(String, String)> {
    let (host, login) = cli_user(home)?;
    (host.trim_end_matches('/') == GITHUB).then(|| (format!("{host}:{login}"), login))
}

/// Copilot CLI's sign-in Paw can use: its login, when its Keychain item is
/// there (no secret read).
fn cli_login(home: &Path) -> Option<String> {
    let (account, login) = cli_account(home)?;
    security(&["find-generic-password", "-s", CLI_SERVICE, "-a", &account]).filter(|o| o.status.success())?;
    Some(login)
}

/// Copilot CLI's GitHub token (macOS may ask whether Paw may read it).
fn cli_token(home: &Path) -> Option<String> {
    let (account, _) = cli_account(home)?;
    let out = security(&["find-generic-password", "-s", CLI_SERVICE, "-a", &account, "-w"])?;
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !token.is_empty()).then_some(token)
}

// ---------------------------------------------------------------------------
// Status and the token a session uses
// ---------------------------------------------------------------------------

/// What Settings shows (never a token).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Status {
    /// Paw's own sign-in, and the GitHub login it's for.
    pub signed_in: bool,
    pub login: Option<String>,
    /// Copilot CLI's sign-in (its login), used when Paw has none.
    pub cli: Option<String>,
}

/// Signed in, and as whom: without reading the Keychain's secrets (no prompt).
pub fn status(home: &Path) -> Status {
    let signed_in = keychain::has_item(TOKEN_ITEM);
    Status { signed_in, login: signed_in.then(|| keychain::note(LOGIN_ITEM)).flatten(), cli: cli_login(home) }
}

/// The GitHub token a session uses, and whether it's Copilot CLI's.
pub struct Source {
    token: String,
    cli: bool,
}

/// Paw's sign-in, else Copilot CLI's. Blocking: it may read Copilot CLI's
/// Keychain item.
pub fn source(home: &Path) -> Result<Source, String> {
    if let Some(token) = keychain::item(TOKEN_ITEM) {
        // A sign-in from before the login was kept outside the Keychain: keep it now.
        if keychain::note(LOGIN_ITEM).is_none() {
            if let Some(login) = keychain::item(LOGIN_ITEM) {
                keychain::set_note(LOGIN_ITEM, Some(&login));
            }
        }
        return Ok(Source { token, cli: false });
    }
    if cli_login(home).is_some() {
        return cli_token(home).map(|token| Source { token, cli: true }).ok_or_else(|| {
            "Couldn't read Copilot CLI's sign-in from the Keychain (macOS asks whether Paw may). \
Allow it, or sign in with GitHub in Settings › Agents › Paw Agent."
                .to_string()
        });
    }
    Err(NOT_SIGNED_IN.into())
}

/// The API root of the account's Copilot (`endpoints.api`), or why there is none.
async fn endpoint(token: &str, cli: bool) -> Result<String, String> {
    let fix = if cli {
        "Copilot CLI's sign-in couldn't be used — sign in with GitHub in Settings › Agents › Paw Agent."
    } else {
        "Sign in again in Settings › Agents › Paw Agent."
    };
    let reply = http()
        .get(format!("{GITHUB_API}/copilot_internal/user"))
        .header("Authorization", format!("token {token}"))
        .header("Accept", "application/json")
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach GitHub: {e}"))?;
    let status = reply.status().as_u16();
    let body = reply.text().await.unwrap_or_default();
    match status {
        200 => {}
        401 => return Err(format!("GitHub didn't accept the Copilot sign-in. {fix}")),
        403 | 404 => return Err("This GitHub account has no GitHub Copilot.".into()),
        s => return Err(format!("GitHub answered {s} when asked for the account's Copilot. {fix}")),
    }
    let v: Value = serde_json::from_str(&body).map_err(|e| format!("GitHub's Copilot answer couldn't be read: {e}"))?;
    if v.get("chat_enabled").and_then(Value::as_bool) == Some(false) {
        return Err("Copilot Chat is turned off for this GitHub account (its organization's policy).".into());
    }
    Ok(v.pointer("/endpoints/api").and_then(Value::as_str).filter(|s| s.starts_with("https://")).unwrap_or("https://api.githubcopilot.com").to_string())
}

fn config(token: &str, api: String) -> OpenAIConfig {
    OpenAIConfig::with_key(&DIALECT, token).with_base_url(api)
}

/// `model` on the account's Copilot.
pub async fn model(source: Source, model: &str) -> Result<DynModel<Completion>, String> {
    let api = endpoint(&source.token, source.cli).await?;
    Ok(config(&source.token, api).client().completion(model).into())
}

/// The chat models Paw's sign-in offers. None without Paw's sign-in (Copilot
/// CLI's isn't read just to list models) or when the list can't be had.
pub async fn list_models() -> Option<Vec<String>> {
    let token = keychain::item(TOKEN_ITEM)?;
    let api = endpoint(&token, false).await.ok()?;
    let list = rig_core::driver::Model::new(Models::new(config(&token, api)), rig_reqwest::shared()).list().await.ok()?;
    let mut ids: Vec<String> = list.iter().filter(|m| m.r#type.as_deref().is_none_or(|t| t == "chat")).map(|m| m.id.clone()).collect();
    ids.dedup();
    (!ids.is_empty()).then_some(ids)
}

// ---------------------------------------------------------------------------
// Signing in and out
// ---------------------------------------------------------------------------

/// The code to enter, and where.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceCode {
    pub uri: String,
    pub code: String,
}

async fn post_form(url: &str, form: &[(&str, &str)]) -> Result<Value, String> {
    let body: String = form.iter().map(|(k, v)| format!("{k}={}", urlencode(v))).collect::<Vec<_>>().join("&");
    let reply = http()
        .post(url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("User-Agent", USER_AGENT)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach GitHub: {e}"))?;
    let text = reply.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|_| format!("GitHub's answer couldn't be read: {}", text.chars().take(200).collect::<String>()))
}

pub(super) fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".into(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The GitHub login a token belongs to.
async fn github_login(token: &str) -> Option<String> {
    let reply = http()
        .get(format!("{GITHUB_API}/user"))
        .header("Authorization", format!("token {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .ok()?;
    let v: Value = serde_json::from_str(&reply.text().await.ok()?).ok()?;
    v.get("login")?.as_str().map(String::from)
}

/// Run GitHub's device flow: `show` gets the code to enter and where. Once
/// the user has approved Paw and the account turns out to have Copilot, the
/// token replaces Paw's earlier sign-in. Answers the GitHub login.
pub async fn sign_in(show: impl Fn(DeviceCode)) -> Result<String, String> {
    let device = post_form(&format!("{GITHUB}/login/device/code"), &[("client_id", CLIENT_ID), ("scope", "read:user")]).await?;
    let field = |k: &str| device.get(k).and_then(Value::as_str).map(String::from);
    let (Some(device_code), Some(code), Some(uri)) = (field("device_code"), field("user_code"), field("verification_uri")) else {
        return Err(format!("GitHub didn't start the sign-in: {device}"));
    };
    show(DeviceCode { uri, code });
    let deadline = Instant::now() + Duration::from_secs(device.get("expires_in").and_then(Value::as_u64).unwrap_or(900));
    let mut wait = device.get("interval").and_then(Value::as_u64).unwrap_or(5).max(1);
    let token = loop {
        if Instant::now() >= deadline {
            return Err("The sign-in code expired before it was approved. Try again.".into());
        }
        tokio::time::sleep(Duration::from_secs(wait)).await;
        let reply = post_form(
            &format!("{GITHUB}/login/oauth/access_token"),
            &[("client_id", CLIENT_ID), ("device_code", &device_code), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code")],
        )
        .await?;
        if let Some(t) = reply.get("access_token").and_then(Value::as_str).filter(|t| !t.is_empty()) {
            break t.to_string();
        }
        match reply.get("error").and_then(Value::as_str) {
            Some("authorization_pending") => {}
            Some("slow_down") => wait = reply.get("interval").and_then(Value::as_u64).unwrap_or(wait + 5),
            Some("access_denied") => return Err("The sign-in was declined on GitHub.".into()),
            Some("expired_token") => return Err("The sign-in code expired before it was approved. Try again.".into()),
            Some(e) => return Err(format!("GitHub refused the sign-in: {e}")),
            None => return Err(format!("GitHub's answer had no token: {reply}")),
        }
    };
    endpoint(&token, false).await?;
    let login = github_login(&token).await.unwrap_or_default();
    keychain::set_item(TOKEN_ITEM, &token)?;
    keychain::set_item(LOGIN_ITEM, &login)?;
    keychain::set_note(LOGIN_ITEM, Some(&login));
    Ok(login)
}

pub fn sign_out() -> Result<(), String> {
    keychain::delete_item(TOKEN_ITEM)?;
    keychain::set_note(LOGIN_ITEM, None);
    keychain::delete_item(LOGIN_ITEM)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_account_is_the_last_github_com_login() {
        let home = std::env::temp_dir().join(format!("paw-copilot-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".copilot")).unwrap();
        let cfg = home.join(".copilot/config.json");
        std::fs::write(&cfg, "// managed by copilot\n{\"lastLoggedInUser\":{\"host\":\"https://github.com\",\"login\":\"octo\"},\"loggedInUsers\":[]}").unwrap();
        assert_eq!(cli_account(&home), Some(("https://github.com:octo".into(), "octo".into())));
        // GitHub Enterprise Server: its tokens don't reach api.github.com.
        std::fs::write(&cfg, r#"{"lastLoggedInUser":{"host":"https://ghe.example.com","login":"octo"}}"#).unwrap();
        assert_eq!(cli_account(&home), None);
        std::fs::write(&cfg, "{}").unwrap();
        assert_eq!(cli_account(&home), None);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn form_values_are_encoded() {
        assert_eq!(urlencode("urn:ietf:params:oauth:grant-type:device_code"), "urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
        assert_eq!(urlencode("read:user a"), "read%3Auser+a");
    }
}

#[cfg(test)]
mod this_mac {
    /// A real Copilot reply with whatever sign-in this Mac has (macOS may ask
    /// about Copilot CLI's Keychain item):
    /// `cargo test copilot::this_mac -- --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn reply_from_copilot() {
        let home = super::user_home();
        println!("status: {:?}", super::status(&home));
        let source = super::source(&home).expect("a sign-in");
        println!("using: {}", if source.cli { "Copilot CLI's sign-in" } else { "Paw's sign-in" });
        let model = super::model(source, "gpt-4.1").await.expect("a model");
        let agent = rig_agent::AgentBuilder::new(model).build();
        let reply = agent.prompt("Reply with the single word: pong").await.expect("a reply");
        println!("reply: {reply}");
        assert!(reply.output().to_ascii_lowercase().contains("pong"));
    }
}
