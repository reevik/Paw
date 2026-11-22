//! Where Paw Agent gets an Anthropic credential.
//!
//! Besides a key the user gives Paw (kept in Paw's own Keychain item) and
//! Paw's own Claude sign-in (see `claude`), Paw looks where other tools keep
//! one: the login shell's `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`,
//! Claude Code (the `env` block and `apiKeyHelper` in
//! `~/.claude/settings.json`, a Console key in `~/.claude.json` or in its
//! "Claude Code" Keychain item, its claude.ai sign-in) and opencode
//! (`~/.local/share/opencode/auth.json`). opencode's claude.ai sign-in is
//! listed but not used.
//!
//! Listing never returns a secret. A key is read only when a session starts,
//! from the source the user picked (or the first usable one), so a key that
//! changes there is picked up without copying it anywhere. A sign-in's token
//! is read when a request needs one.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// One place a credential was found.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KeySource {
    /// Stable id, saved as the agent's `key_source`.
    pub id: String,
    pub label: String,
    /// Where exactly, in words (empty when the label says it all).
    pub detail: String,
    pub usable: bool,
    /// A claude.ai sign-in (Settings shows these apart from keys).
    pub sign_in: bool,
    /// Why it can't be used, or what using it involves.
    pub note: String,
}

impl KeySource {
    /// "label (detail)", or the label alone.
    pub fn name(&self) -> String {
        if self.detail.is_empty() {
            self.label.clone()
        } else {
            format!("{} ({})", self.label, self.detail)
        }
    }
}

/// What a request is authorized with.
#[derive(Clone, PartialEq)]
pub enum Secret {
    /// An API key, sent as `x-api-key`.
    ApiKey(String),
    /// A gateway's auth token, sent as `Authorization: Bearer`.
    Bearer(String),
    /// A claude.ai sign-in: the Claude plan's models, its token read per request.
    Claude(super::claude::Login),
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the secret.
        match self {
            Secret::ApiKey(k) => write!(f, "ApiKey(<{} chars>)", k.len()),
            Secret::Bearer(t) => write!(f, "Bearer(<{} chars>)", t.len()),
            Secret::Claude(login) => write!(f, "Claude({login:?})"),
        }
    }
}

/// A credential read from a source.
#[derive(Debug, Clone, PartialEq)]
pub struct Credential {
    pub secret: Secret,
    /// The address that goes with it (`ANTHROPIC_BASE_URL` beside it), if any.
    pub base_url: Option<String>,
    pub source: String,
}

/// What the scan looks at; tests swap in a fake machine.
pub trait Probe {
    fn home(&self) -> PathBuf;
    /// ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL as the
    /// login shell sets them (empty: unset).
    fn shell_vars(&self) -> [String; 3];
    /// Whether a generic-password item of this service exists (no secret read).
    fn keychain_has(&self, service: &str) -> bool;
    /// The secret of another app's generic-password item (macOS may ask).
    fn keychain_read(&self, service: &str) -> Option<String>;
    /// Paw's own key.
    fn paw_key(&self) -> Option<String>;
    /// Is Paw's own key saved? (Without reading it: no prompt.)
    fn paw_key_saved(&self) -> bool {
        self.paw_key().is_some()
    }
    /// Paw's own Claude sign-in: the account's email ("" when unknown).
    fn paw_claude(&self) -> Option<String>;
    /// Run Claude Code's `apiKeyHelper` command; its output is the key.
    fn run_helper(&self, command: &str) -> Option<String>;
}

pub const PAW: &str = "paw";
pub const PAW_CLAUDE: &str = "paw-claude";
const CLAUDE_CODE_KEYCHAIN: &str = "Claude Code";

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = v;
    for k in path {
        cur = cur.get(*k)?;
    }
    cur.as_str().map(str::trim).filter(|s| !s.is_empty())
}

fn nonempty(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// A source, found or not, and how to read it.
struct Found {
    source: KeySource,
    read: Box<dyn Fn(&dyn Probe) -> Option<Credential>>,
}

impl Found {
    /// This source as a claude.ai sign-in rather than a key.
    fn sign_in(mut self) -> Self {
        self.source.sign_in = true;
        self
    }
}

fn found(id: &str, label: &str, detail: impl Into<String>, note: &str, read: impl Fn(&dyn Probe) -> Option<Credential> + 'static) -> Found {
    Found {
        source: KeySource { id: id.into(), label: label.into(), detail: detail.into(), usable: true, sign_in: false, note: note.into() },
        read: Box::new(read),
    }
}

fn not_usable(id: &str, label: &str, detail: &str, note: &str) -> Found {
    Found {
        source: KeySource { id: id.into(), label: label.into(), detail: detail.into(), usable: false, sign_in: false, note: note.into() },
        read: Box::new(|_| None),
    }
}

fn cred(secret: Secret, base_url: Option<String>, source: &str) -> Credential {
    Credential { secret, base_url, source: source.into() }
}

/// " (email)", when there is one.
fn account(email: &str) -> String {
    if email.is_empty() {
        String::new()
    } else {
        format!(" ({email})")
    }
}

/// Every source on this machine, in the order "Automatic" tries them.
fn scan(p: &dyn Probe) -> Vec<Found> {
    let mut out = vec![];
    let home = p.home();

    if let Some(email) = p.paw_claude() {
        out.push(
            found(PAW_CLAUDE, &format!("Paw Sign-in{}", account(&email)), "", "", |_| {
                Some(cred(Secret::Claude(super::claude::Login::Paw), None, PAW_CLAUDE))
            })
            .sign_in(),
        );
    }
    if p.paw_key_saved() {
        out.push(found(PAW, "Paw's own key", "Saved in Settings (your Keychain)", "", |p| {
            p.paw_key().map(|k| cred(Secret::ApiKey(k), None, PAW))
        }));
    }

    let [api_key, auth_token, base] = p.shell_vars();
    let shell_base = nonempty(&base);
    if !api_key.trim().is_empty() {
        out.push(found("shell-api-key", "Login shell", "ANTHROPIC_API_KEY", "", |p| {
            let [k, _, b] = p.shell_vars();
            nonempty(&k).map(|k| cred(Secret::ApiKey(k), nonempty(&b), "shell-api-key"))
        }));
    }
    if !auth_token.trim().is_empty() {
        out.push(found("shell-auth-token", "Login shell", "ANTHROPIC_AUTH_TOKEN (sent as a bearer token)", "", |p| {
            let [_, t, b] = p.shell_vars();
            nonempty(&t).map(|t| cred(Secret::Bearer(t), nonempty(&b), "shell-auth-token"))
        }));
    }

    // Claude Code
    let settings_path = home.join(".claude/settings.json");
    if let Some(settings) = read_json(&settings_path) {
        let env_base = str_at(&settings, &["env", "ANTHROPIC_BASE_URL"]).map(String::from).or(shell_base.clone());
        if str_at(&settings, &["env", "ANTHROPIC_API_KEY"]).is_some() {
            let (path, b) = (settings_path.clone(), env_base.clone());
            out.push(found("claude-code-env-key", "Claude Code", "ANTHROPIC_API_KEY in ~/.claude/settings.json", "", move |_| {
                let s = read_json(&path)?;
                str_at(&s, &["env", "ANTHROPIC_API_KEY"]).map(|k| cred(Secret::ApiKey(k.into()), b.clone(), "claude-code-env-key"))
            }));
        }
        if str_at(&settings, &["env", "ANTHROPIC_AUTH_TOKEN"]).is_some() {
            let (path, b) = (settings_path.clone(), env_base.clone());
            out.push(found("claude-code-env-token", "Claude Code", "ANTHROPIC_AUTH_TOKEN in ~/.claude/settings.json (bearer token)", "", move |_| {
                let s = read_json(&path)?;
                str_at(&s, &["env", "ANTHROPIC_AUTH_TOKEN"]).map(|t| cred(Secret::Bearer(t.into()), b.clone(), "claude-code-env-token"))
            }));
        }
        if str_at(&settings, &["apiKeyHelper"]).is_some() {
            let (path, b) = (settings_path.clone(), env_base);
            out.push(found(
                "claude-code-helper",
                "Claude Code",
                "apiKeyHelper in ~/.claude/settings.json",
                "Paw runs your apiKeyHelper command when a session starts, as Claude Code does.",
                move |p| {
                    let s = read_json(&path)?;
                    let cmd = str_at(&s, &["apiKeyHelper"])?;
                    p.run_helper(cmd).and_then(|k| nonempty(&k)).map(|k| cred(Secret::ApiKey(k), b.clone(), "claude-code-helper"))
                },
            ));
        }
    }
    let state_path = home.join(".claude.json");
    let state = read_json(&state_path);
    if state.as_ref().and_then(|s| str_at(s, &["primaryApiKey"])).is_some() {
        let (path, b) = (state_path.clone(), shell_base.clone());
        out.push(found("claude-code-console-key", "Claude Code", "Console API key in ~/.claude.json", "", move |_| {
            let s = read_json(&path)?;
            str_at(&s, &["primaryApiKey"]).map(|k| cred(Secret::ApiKey(k.into()), b.clone(), "claude-code-console-key"))
        }));
    }
    if p.keychain_has(CLAUDE_CODE_KEYCHAIN) {
        let b = shell_base.clone();
        out.push(found(
            "claude-code-keychain",
            "Claude Code",
            "Console API key in the \"Claude Code\" Keychain item",
            "macOS asks once whether Paw may read it.",
            move |p| p.keychain_read(CLAUDE_CODE_KEYCHAIN).and_then(|k| nonempty(&k)).map(|k| cred(Secret::ApiKey(k), b.clone(), "claude-code-keychain")),
        ));
    }

    // opencode
    let oc_path = home.join(".local/share/opencode/auth.json");
    if let Some(oc) = read_json(&oc_path) {
        match oc.get("anthropic").and_then(|a| a.get("type")).and_then(Value::as_str) {
            Some("api") => {
                let path = oc_path.clone();
                out.push(found("opencode", "opencode", "Anthropic API key in ~/.local/share/opencode/auth.json", "", move |_| {
                    let s = read_json(&path)?;
                    str_at(&s, &["anthropic", "key"]).map(|k| cred(Secret::ApiKey(k.into()), None, "opencode"))
                }));
            }
            Some(_) => out.push(
                not_usable(
                    "opencode-login",
                    "opencode's Sign-in",
                    "",
                    "Paw doesn't use opencode's sign-in. Sign in with Claude in Paw, or use Claude Code's sign-in.",
                )
                .sign_in(),
            ),
            None => {}
        }
    }

    // Claude Code's claude.ai sign-in: its token, read per request.
    if p.keychain_has(super::claude::CLAUDE_CODE_ITEM) {
        let email = state.as_ref().and_then(|s| str_at(s, &["oauthAccount", "emailAddress"])).unwrap_or_default();
        out.push(
            found(
                "claude-code-login",
                &format!("Claude Code's Sign-in{}", account(email)),
                "",
                "macOS asks once whether Paw may read it. Paw uses it while Claude Code keeps it renewed (it renews when you use claude).",
                |_| Some(cred(Secret::Claude(super::claude::Login::ClaudeCode), None, "claude-code-login")),
            )
            .sign_in(),
        );
    }
    // Trying a first start: only what was connected in this Paw.
    if crate::paths::outside_hidden() {
        out.retain(|f| f.source.id == PAW || f.source.id == PAW_CLAUDE);
    }
    out
}

/// The sources found on this machine (no secrets).
pub fn list(p: &dyn Probe) -> Vec<KeySource> {
    scan(p).into_iter().map(|f| f.source).collect()
}

/// The credential for `choice` ("" or "auto": the first usable source).
pub fn resolve(p: &dyn Probe, choice: &str) -> Result<Credential, String> {
    let all = scan(p);
    let auto = choice.is_empty() || choice == "auto";
    if !auto {
        let f = all.iter().find(|f| f.source.id == choice).ok_or_else(|| {
            format!("The key source Paw Agent is set to use ({choice}) isn't there any more. Pick another in Settings › Agents › Paw Agent.")
        })?;
        if !f.source.usable {
            return Err(f.source.note.clone());
        }
        return (f.read)(p).ok_or_else(|| format!("Couldn't read the key from {}.", f.source.name()));
    }
    for f in all.iter().filter(|f| f.source.usable) {
        if let Some(c) = (f.read)(p) {
            return Ok(c);
        }
    }
    Err("No Anthropic API key or Claude sign-in found. Sign in with Claude or add a key in Settings › Agents › Paw Agent, \
or set ANTHROPIC_API_KEY in your shell."
        .into())
}

/// This Mac.
pub struct System;

impl Probe for System {
    fn home(&self) -> PathBuf {
        std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
    }

    fn shell_vars(&self) -> [String; 3] {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let out = std::process::Command::new(shell)
            .args(["-lc", r#"printf '%s\0%s\0%s' "$ANTHROPIC_API_KEY" "$ANTHROPIC_AUTH_TOKEN" "$ANTHROPIC_BASE_URL""#])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output();
        let text = out.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
        let mut parts = text.split('\0').map(|s| s.trim().to_string());
        [parts.next().unwrap_or_default(), parts.next().unwrap_or_default(), parts.next().unwrap_or_default()]
    }

    fn keychain_has(&self, service: &str) -> bool {
        // Without -w only the attributes come back: no secret, no prompt.
        std::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", service])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    fn keychain_read(&self, service: &str) -> Option<String> {
        let out = std::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", service, "-w"])
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn paw_key(&self) -> Option<String> {
        super::keychain::get("anthropic")
    }

    fn paw_key_saved(&self) -> bool {
        super::keychain::has("anthropic")
    }

    fn paw_claude(&self) -> Option<String> {
        let st = super::claude::status();
        st.signed_in.then(|| st.login.unwrap_or_default())
    }

    fn run_helper(&self, command: &str) -> Option<String> {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let out = crate::registry::run_with_env(&shell, &["-lc", command], &[], std::time::Duration::from_secs(20))?;
        nonempty(out.lines().last().unwrap_or(""))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[derive(Default)]
    struct Fake {
        home: PathBuf,
        vars: [String; 3],
        keychain: Vec<(&'static str, &'static str)>,
        paw: Option<String>,
        paw_claude: Option<String>,
        helper: Option<String>,
    }

    impl Probe for Fake {
        fn home(&self) -> PathBuf {
            self.home.clone()
        }
        fn shell_vars(&self) -> [String; 3] {
            self.vars.clone()
        }
        fn keychain_has(&self, service: &str) -> bool {
            self.keychain.iter().any(|(s, _)| *s == service)
        }
        fn keychain_read(&self, service: &str) -> Option<String> {
            self.keychain.iter().find(|(s, _)| *s == service).map(|(_, v)| v.to_string())
        }
        fn paw_key(&self) -> Option<String> {
            self.paw.clone()
        }
        fn paw_claude(&self) -> Option<String> {
            self.paw_claude.clone()
        }
        fn run_helper(&self, _command: &str) -> Option<String> {
            self.helper.clone()
        }
    }

    fn home(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("paw-keys-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".claude")).unwrap();
        std::fs::create_dir_all(d.join(".local/share/opencode")).unwrap();
        d
    }

    fn ids(p: &dyn Probe) -> Vec<(String, bool)> {
        list(p).into_iter().map(|s| (s.id, s.usable)).collect()
    }

    fn key(k: &str) -> Secret {
        Secret::ApiKey(k.into())
    }

    #[test]
    fn claude_sign_ins_are_used_and_paws_comes_first() {
        use crate::paw_agent::claude::{Login, CLAUDE_CODE_ITEM};
        // Claude Code signed in with claude.ai, no key anywhere.
        let h = home("sub");
        std::fs::write(h.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"me@example.com"}}"#).unwrap();
        let mut p = Fake { home: h.clone(), keychain: vec![(CLAUDE_CODE_ITEM, "{\"claudeAiOauth\":{}}")], ..Default::default() };
        assert_eq!(ids(&p), [("claude-code-login".to_string(), true)]);
        assert_eq!(list(&p)[0].name(), "Claude Code's Sign-in (me@example.com)");
        assert_eq!(resolve(&p, "").unwrap().secret, Secret::Claude(Login::ClaudeCode));
        // Paw's own sign-in goes first, before Paw's own key.
        p.paw = Some("sk-paw".into());
        p.paw_claude = Some(String::new());
        assert_eq!(ids(&p).iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), [PAW_CLAUDE, PAW, "claude-code-login"]);
        assert_eq!(resolve(&p, "").unwrap().secret, Secret::Claude(Login::Paw));
        assert_eq!(resolve(&p, PAW).unwrap().secret, key("sk-paw"));
        std::fs::remove_dir_all(h).ok();
    }

    #[test]
    fn finds_keys_in_order_and_reads_the_chosen_one() {
        let h = home("all");
        std::fs::write(
            h.join(".claude/settings.json"),
            r#"{"env":{"ANTHROPIC_API_KEY":"sk-settings","ANTHROPIC_BASE_URL":"https://gw.example"},"apiKeyHelper":"echo x"}"#,
        )
        .unwrap();
        std::fs::write(h.join(".claude.json"), r#"{"primaryApiKey":"sk-primary","oauthAccount":null}"#).unwrap();
        std::fs::write(h.join(".local/share/opencode/auth.json"), r#"{"anthropic":{"type":"api","key":"sk-oc"}}"#).unwrap();
        let p = Fake {
            home: h.clone(),
            vars: ["sk-shell".into(), "tok-shell".into(), "https://shell.example".into()],
            keychain: vec![(CLAUDE_CODE_KEYCHAIN, "sk-keychain")],
            paw: Some("sk-paw".into()),
            helper: Some("sk-helper".into()),
            ..Default::default()
        };
        let found: Vec<String> = ids(&p).into_iter().map(|(id, u)| { assert!(u, "{id}"); id }).collect();
        assert_eq!(
            found,
            ["paw", "shell-api-key", "shell-auth-token", "claude-code-env-key", "claude-code-helper", "claude-code-console-key", "claude-code-keychain", "opencode"]
        );
        // Automatic: Paw's own key first.
        assert_eq!(resolve(&p, "").unwrap(), cred(key("sk-paw"), None, PAW));
        let c = resolve(&p, "shell-auth-token").unwrap();
        assert_eq!((c.secret, c.base_url.as_deref()), (Secret::Bearer("tok-shell".into()), Some("https://shell.example")));
        // Claude Code's settings carry their own address.
        let c = resolve(&p, "claude-code-env-key").unwrap();
        assert_eq!((c.secret, c.base_url.as_deref()), (key("sk-settings"), Some("https://gw.example")));
        assert_eq!(resolve(&p, "claude-code-helper").unwrap().secret, key("sk-helper"));
        assert_eq!(resolve(&p, "claude-code-console-key").unwrap().secret, key("sk-primary"));
        assert_eq!(resolve(&p, "claude-code-keychain").unwrap().secret, key("sk-keychain"));
        assert_eq!(resolve(&p, "opencode").unwrap().secret, key("sk-oc"));
        assert!(resolve(&p, "gone").unwrap_err().contains("isn't there any more"));
        // Listing never carries a secret.
        let listed = serde_json::to_string(&list(&p)).unwrap();
        for s in ["sk-paw", "sk-shell", "tok-shell", "sk-settings", "sk-primary", "sk-keychain", "sk-oc", "sk-helper"] {
            assert!(!listed.contains(s), "{s} leaked into the list");
        }
        // Nor does a credential's debug output.
        assert!(!format!("{:?}", resolve(&p, "").unwrap()).contains("sk-paw"));
        std::fs::remove_dir_all(h).ok();
    }

    #[test]
    fn automatic_skips_sources_that_fail_to_read() {
        let h = home("skip");
        std::fs::write(h.join(".claude/settings.json"), r#"{"apiKeyHelper":"false"}"#).unwrap();
        std::fs::write(h.join(".local/share/opencode/auth.json"), r#"{"anthropic":{"type":"oauth","access":"x"}}"#).unwrap();
        let p = Fake { home: h.clone(), vars: [String::new(), String::new(), String::new()], helper: None, ..Default::default() };
        let all: HashSet<(String, bool)> = ids(&p).into_iter().collect();
        assert!(all.contains(&("claude-code-helper".into(), true)));
        assert!(all.contains(&("opencode-login".into(), false)));
        assert!(resolve(&p, "opencode-login").unwrap_err().contains("Sign in with Claude"));
        let err = resolve(&p, "").unwrap_err();
        assert!(err.contains("No Anthropic API key or Claude sign-in found"), "{err}");
        std::fs::remove_dir_all(h).ok();
    }
}

#[cfg(test)]
mod this_mac {
    /// The real scan, printed (labels only): `cargo test this_mac -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn list_this_mac() {
        for s in super::list(&super::System) {
            println!("{} | {} | {} | usable={} | {}", s.id, s.label, s.detail, s.usable, s.note);
        }
        println!("automatic: {:?}", super::resolve(&super::System, "").map(|c| c.source));
    }
}
