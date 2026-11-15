//! Where Paw Agent gets an Anthropic credential.
//!
//! Besides a key the user gives Paw (kept in Paw's own Keychain item),
//! Paw looks where other tools keep one: the login shell's
//! `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, Claude Code (the `env` block
//! and `apiKeyHelper` in `~/.claude/settings.json`, a Console key in
//! `~/.claude.json` or in its "Claude Code" Keychain item) and opencode
//! (`~/.local/share/opencode/auth.json`).
//!
//! A claude.ai sign-in (Claude Code's "Claude Code-credentials" item, an
//! opencode OAuth login) is listed but never used: it is a subscription
//! credential for that app, not an API key.
//!
//! Listing never returns a secret. A key is read only when a session starts,
//! from the source the user picked (or the first usable one), so a key that
//! changes there is picked up without copying it anywhere.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// One place a credential was found.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KeySource {
    /// Stable id, saved as the agent's `key_source`.
    pub id: String,
    pub label: String,
    /// Where exactly, in words.
    pub detail: String,
    pub usable: bool,
    /// Why it can't be used, or what using it involves.
    pub note: String,
}

/// A credential read from a source.
#[derive(Clone, PartialEq)]
pub struct Credential {
    pub secret: String,
    /// Sent as `Authorization: Bearer` (a gateway's auth token) rather than `x-api-key`.
    pub bearer: bool,
    /// The address that goes with it (`ANTHROPIC_BASE_URL` beside it), if any.
    pub base_url: Option<String>,
    pub source: String,
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the secret.
        f.debug_struct("Credential")
            .field("secret", &format!("<{} chars>", self.secret.len()))
            .field("bearer", &self.bearer)
            .field("base_url", &self.base_url)
            .field("source", &self.source)
            .finish()
    }
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
    /// Run Claude Code's `apiKeyHelper` command; its output is the key.
    fn run_helper(&self, command: &str) -> Option<String>;
}

pub const PAW: &str = "paw";
const CLAUDE_CODE_KEYCHAIN: &str = "Claude Code";
const CLAUDE_CODE_LOGIN: &str = "Claude Code-credentials";
const SUBSCRIPTION_NOTE: &str = "A claude.ai sign-in works only in Claude Code. Paw Agent needs an API key from console.anthropic.com.";

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

fn found(id: &str, label: &str, detail: impl Into<String>, note: &str, read: impl Fn(&dyn Probe) -> Option<Credential> + 'static) -> Found {
    Found {
        source: KeySource { id: id.into(), label: label.into(), detail: detail.into(), usable: true, note: note.into() },
        read: Box::new(read),
    }
}

fn not_usable(id: &str, label: &str, detail: &str, note: &str) -> Found {
    Found {
        source: KeySource { id: id.into(), label: label.into(), detail: detail.into(), usable: false, note: note.into() },
        read: Box::new(|_| None),
    }
}

fn cred(secret: String, bearer: bool, base_url: Option<String>, source: &str) -> Credential {
    Credential { secret, bearer, base_url, source: source.into() }
}

/// Every source on this machine, in the order "Automatic" tries them.
fn scan(p: &dyn Probe) -> Vec<Found> {
    let mut out = vec![];
    let home = p.home();

    if p.paw_key().is_some() {
        out.push(found(PAW, "Paw's own key", "Saved in Settings (your Keychain)", "", |p| {
            p.paw_key().map(|k| cred(k, false, None, PAW))
        }));
    }

    let [api_key, auth_token, base] = p.shell_vars();
    let shell_base = nonempty(&base);
    if !api_key.trim().is_empty() {
        out.push(found("shell-api-key", "Login shell", "ANTHROPIC_API_KEY", "", |p| {
            let [k, _, b] = p.shell_vars();
            nonempty(&k).map(|k| cred(k, false, nonempty(&b), "shell-api-key"))
        }));
    }
    if !auth_token.trim().is_empty() {
        out.push(found("shell-auth-token", "Login shell", "ANTHROPIC_AUTH_TOKEN (sent as a bearer token)", "", |p| {
            let [_, t, b] = p.shell_vars();
            nonempty(&t).map(|t| cred(t, true, nonempty(&b), "shell-auth-token"))
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
                str_at(&s, &["env", "ANTHROPIC_API_KEY"]).map(|k| cred(k.into(), false, b.clone(), "claude-code-env-key"))
            }));
        }
        if str_at(&settings, &["env", "ANTHROPIC_AUTH_TOKEN"]).is_some() {
            let (path, b) = (settings_path.clone(), env_base.clone());
            out.push(found("claude-code-env-token", "Claude Code", "ANTHROPIC_AUTH_TOKEN in ~/.claude/settings.json (bearer token)", "", move |_| {
                let s = read_json(&path)?;
                str_at(&s, &["env", "ANTHROPIC_AUTH_TOKEN"]).map(|t| cred(t.into(), true, b.clone(), "claude-code-env-token"))
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
                    p.run_helper(cmd).and_then(|k| nonempty(&k)).map(|k| cred(k, false, b.clone(), "claude-code-helper"))
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
            str_at(&s, &["primaryApiKey"]).map(|k| cred(k.into(), false, b.clone(), "claude-code-console-key"))
        }));
    }
    if p.keychain_has(CLAUDE_CODE_KEYCHAIN) {
        let b = shell_base.clone();
        out.push(found(
            "claude-code-keychain",
            "Claude Code",
            "Console API key in the \"Claude Code\" Keychain item",
            "macOS asks once whether Paw may read it.",
            move |p| p.keychain_read(CLAUDE_CODE_KEYCHAIN).and_then(|k| nonempty(&k)).map(|k| cred(k, false, b.clone(), "claude-code-keychain")),
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
                    str_at(&s, &["anthropic", "key"]).map(|k| cred(k.into(), false, None, "opencode"))
                }));
            }
            Some(_) => out.push(not_usable("opencode-login", "opencode", "Signed in with a claude.ai account", SUBSCRIPTION_NOTE)),
            None => {}
        }
    }

    // Subscription sign-ins: shown, never used.
    let claude_ai = p.keychain_has(CLAUDE_CODE_LOGIN) || state.as_ref().is_some_and(|s| s.get("oauthAccount").is_some_and(|a| !a.is_null()));
    if claude_ai {
        out.push(not_usable("claude-code-login", "Claude Code", "Signed in with a claude.ai account", SUBSCRIPTION_NOTE));
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
        return (f.read)(p).ok_or_else(|| format!("Couldn't read the key from {} ({}).", f.source.label, f.source.detail));
    }
    for f in all.iter().filter(|f| f.source.usable) {
        if let Some(c) = (f.read)(p) {
            return Ok(c);
        }
    }
    let mut msg = String::from("No Anthropic API key found. Add one in Settings › Agents › Paw Agent (it's kept in your Keychain), or set ANTHROPIC_API_KEY in your shell.");
    if all.iter().any(|f| !f.source.usable) {
        msg.push(' ');
        msg.push_str(SUBSCRIPTION_NOTE);
    }
    Err(msg)
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

    #[test]
    fn subscription_only_is_listed_but_not_used() {
        // This Mac today: Claude Code signed in with claude.ai, no key anywhere.
        let h = home("sub");
        std::fs::write(h.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"x"}}"#).unwrap();
        let p = Fake { home: h.clone(), keychain: vec![(CLAUDE_CODE_LOGIN, "{\"claudeAiOauth\":{}}")], ..Default::default() };
        assert_eq!(ids(&p), [("claude-code-login".to_string(), false)]);
        let err = resolve(&p, "").unwrap_err();
        assert!(err.contains("console.anthropic.com"), "{err}");
        assert!(resolve(&p, "claude-code-login").is_err());
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
        };
        let found: Vec<String> = ids(&p).into_iter().map(|(id, u)| { assert!(u, "{id}"); id }).collect();
        assert_eq!(
            found,
            ["paw", "shell-api-key", "shell-auth-token", "claude-code-env-key", "claude-code-helper", "claude-code-console-key", "claude-code-keychain", "opencode"]
        );
        // Automatic: Paw's own key first.
        assert_eq!(resolve(&p, "").unwrap(), cred("sk-paw".into(), false, None, PAW));
        let c = resolve(&p, "shell-auth-token").unwrap();
        assert_eq!((c.secret.as_str(), c.bearer, c.base_url.as_deref()), ("tok-shell", true, Some("https://shell.example")));
        // Claude Code's settings carry their own address.
        let c = resolve(&p, "claude-code-env-key").unwrap();
        assert_eq!((c.secret.as_str(), c.base_url.as_deref()), ("sk-settings", Some("https://gw.example")));
        assert_eq!(resolve(&p, "claude-code-helper").unwrap().secret, "sk-helper");
        assert_eq!(resolve(&p, "claude-code-console-key").unwrap().secret, "sk-primary");
        assert_eq!(resolve(&p, "claude-code-keychain").unwrap().secret, "sk-keychain");
        assert_eq!(resolve(&p, "opencode").unwrap().secret, "sk-oc");
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
        let err = resolve(&p, "").unwrap_err();
        assert!(err.contains("No Anthropic API key found") && err.contains("claude.ai"), "{err}");
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
