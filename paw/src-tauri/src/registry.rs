//! Agent registry: which agent CLIs Paw knows about, whether they're installed,
//! which models they offer, and how to turn (prompt, model) into a command line.
//!
//! - `AgentConfig` is user-editable and persisted to `settings.json` in the app
//!   config dir.
//! - `Detection` is computed at runtime (PATH lookup, `--version`, model discovery)
//!   and cached in memory.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    /// Executable name looked up on the login-shell PATH (or an absolute path).
    pub binary: String,
    /// Command template. Placeholders: {bin} {prompt} {model} {permission}.
    /// `[[ ... ]]` marks an optional segment, dropped when a placeholder in it is empty.
    pub template: String,
    /// "claude-stream-json": prompt + follow-ups go to stdin as stream-json.
    /// "text": prompt is substituted into the command; stdin is raw text.
    pub io: String,
    pub enabled: bool,
    pub builtin: bool,
    #[serde(default)]
    pub default_model: Option<String>,
    /// Models the user added by hand (merged with discovered ones).
    #[serde(default)]
    pub custom_models: Vec<String>,
    /// How a tab keeps its conversation across prompts and restarts:
    /// "session" — the agent's own sessions: `{session}` in the template and
    ///             `session_pattern` to find the id in the agent's output;
    /// "replay"  — Paw keeps the turns and sends them along with each prompt;
    /// "none"    — every prompt stands alone.
    #[serde(default)]
    pub continuity: String,
    /// Regex with one capture group that finds the session id in the output.
    #[serde(default)]
    pub session_pattern: String,
    /// Paw's approval levels (ask, edits, auto, plan, full) → this agent's value for
    /// `{permission}`. A missing level is one the agent can't express.
    #[serde(default)]
    pub approvals: std::collections::BTreeMap<String, String>,
    /// How to allow one specific action at launch, `{rule}` being the action
    /// (e.g. `--allowedTools {rule}`). Empty: the agent has no per-action allow.
    #[serde(default)]
    pub allow_template: String,
    /// How the agent loads skills from a folder Paw prepares, `{skills}` being
    /// that folder (e.g. `--plugin-dir {skills}`). Empty: Paw tells the agent
    /// about external skills in the conversation instead (`skills_delivery`).
    /// None only in settings saved before this existed.
    #[serde(default)]
    pub skills_template: Option<String>,
    /// For agents without `skills_template`: "index" — a list of skills with
    /// the path of each SKILL.md (agents that can read files); "inline" — the
    /// skills' text itself (agents that can't open files).
    #[serde(default)]
    pub skills_delivery: String,
    /// Paw Agent only: "ollama" or "anthropic".
    #[serde(default)]
    pub provider: String,
    /// Paw Agent only: the provider's address (empty: its default).
    #[serde(default)]
    pub base_url: String,
    /// Paw Agent only: where the Anthropic key comes from (empty: automatic).
    #[serde(default)]
    pub key_source: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct General {
    pub default_cwd: String,
    pub only_installed: bool,
    /// Agent opened by ⌘T. Falls back to the first installed, enabled agent.
    pub default_agent: Option<String>,
    /// How many shell commands to remember (0 disables history).
    pub history_size: usize,
    /// Where typed lines go in new tabs: "auto", "shell" or "agent".
    pub input_mode: String,
    /// Approval level for new tabs: "ask", "edits", "auto", "plan" or "full".
    pub approval: String,
    /// Send shell commands run in a tab (and their output) along with the next prompt.
    pub share_shell: bool,
    /// Closed sessions kept in ~/.paw/session (the oldest go first); 0 keeps all.
    pub max_sessions: usize,
}

impl Default for General {
    fn default() -> Self {
        Self {
            default_cwd: "~".into(),
            only_installed: true,
            default_agent: Some("claude".into()),
            history_size: 1000,
            input_mode: "auto".into(),
            approval: "edits".into(),
            share_shell: true,
            max_sessions: 50,
        }
    }
}

/// Terminal themes: one for light mode and one for dark mode (Paw follows the
/// system appearance). Theme definitions live in the UI; custom and imported
/// ones are stored here as opaque JSON.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Appearance {
    pub light: String,
    pub dark: String,
    /// Paint program output colors (ANSI) with the theme's 16-color palette.
    pub light_extended: bool,
    pub dark_extended: bool,
    pub custom: Vec<serde_json::Value>,
    /// "system", "light" or "dark" — forces the appearance of Paw's windows.
    pub mode: String,
    /// Terminal background opacity, 0.3 … 1.0 (lower shows the frosted desktop).
    pub opacity: f64,
    /// Font for the transcript, prompt and terminal view; empty: the system's monospace.
    pub font_family: String,
    /// Its size in px (⌘+ / ⌘− / ⌘0 change it).
    pub font_size: f64,
    /// Line spacing of the transcript, as a multiple of the size.
    pub line_height: f64,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            light: "paw-light".into(),
            dark: "paw-dark".into(),
            light_extended: true,
            dark_extended: true,
            custom: vec![],
            mode: "system".into(),
            opacity: 0.94,
            font_family: String::new(),
            font_size: 12.5,
            line_height: 1.6,
        }
    }
}

/// An action the user chose to always allow for one agent in one folder.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AllowRule {
    pub agent: String,
    pub folder: String,
    /// The agent's own rule text, e.g. `Bash(npm test)`.
    pub rule: String,
    /// What the user saw, e.g. `$ npm test`.
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Settings {
    #[serde(default)]
    pub general: General,
    #[serde(default)]
    pub agents: Vec<AgentConfig>,
    #[serde(default)]
    pub appearance: Appearance,
    #[serde(default)]
    pub allow_rules: Vec<AllowRule>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Detection {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub models: Vec<String>,
    /// Human-readable description of where `models` came from.
    pub models_source: String,
    /// The model the CLI itself is configured to use, if we could read it.
    pub configured_model: Option<String>,
}

#[derive(Default)]
pub struct Registry {
    settings: Mutex<Option<Settings>>,
    detections: Mutex<HashMap<String, Detection>>,
    scanning: Mutex<bool>,
}

// ---------------------------------------------------------------------------
// Built-in catalog
// ---------------------------------------------------------------------------

fn builtin(id: &str, name: &str, binary: &str, template: &str, io: &str) -> AgentConfig {
    builtin_with(id, name, binary, template, io, "replay", "")
}

fn builtin_with(id: &str, name: &str, binary: &str, template: &str, io: &str, continuity: &str, pattern: &str) -> AgentConfig {
    AgentConfig {
        id: id.into(),
        name: name.into(),
        binary: binary.into(),
        template: template.into(),
        io: io.into(),
        enabled: true,
        builtin: true,
        default_model: None,
        custom_models: vec![],
        continuity: continuity.into(),
        session_pattern: pattern.into(),
        approvals: Default::default(),
        allow_template: String::new(),
        skills_template: Some(String::new()),
        skills_delivery: "index".into(),
        provider: String::new(),
        base_url: String::new(),
        key_source: String::new(),
    }
}

/// Init event Paw Agent (and Claude Code) print first; group 1 is the session id.
const INIT_SESSION_PATTERN: &str = r#"^\{"type":"system","subtype":"init".*?"session_id":"([0-9a-fA-F-]{8,})""#;

/// Paw's own agent: runs inside Paw (io "paw"), no binary or template.
fn paw_agent() -> AgentConfig {
    let mut a = builtin_with("paw", "Paw Agent", "", "", "paw", "session", INIT_SESSION_PATTERN)
        .with_approvals(&[("ask", "ask"), ("edits", "edits"), ("auto", "auto"), ("plan", "plan"), ("full", "full")]);
    a.provider = "ollama".into();
    a
}

impl AgentConfig {
    fn with_approvals(mut self, levels: &[(&str, &str)]) -> Self {
        self.approvals = levels.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        self
    }

    fn with_allow(mut self, template: &str) -> Self {
        self.allow_template = template.into();
        self
    }

    fn with_skills(mut self, template: &str) -> Self {
        self.skills_template = Some(template.into());
        self
    }

    /// The agent can't open files: send skills' text, not their paths.
    fn skills_inline(mut self) -> Self {
        self.skills_delivery = "inline".into();
        self
    }
}

pub fn catalog() -> Vec<AgentConfig> {
    vec![
        builtin_with(
            "claude",
            "Claude Code",
            "claude",
            "{bin} -p --input-format stream-json --output-format stream-json --verbose [[--permission-mode {permission}]] [[--model {model}]] [[--resume {session}]]",
            "claude-stream-json",
            "session",
            INIT_SESSION_PATTERN,
        )
        // Claude Code's --permission-mode choices for Paw's approval levels.
        .with_approvals(&[("ask", "manual"), ("edits", "acceptEdits"), ("auto", "auto"), ("plan", "plan"), ("full", "bypassPermissions")])
        .with_allow("--allowedTools {rule}")
        // External skills: a plugin folder Paw keeps (skills/ links to each one).
        .with_skills("--plugin-dir {skills}"),
        // Codex prints "session id: <uuid>" (stderr) and resumes with `exec resume <id>`.
        builtin_with(
            "codex",
            "Codex CLI",
            "codex",
            "{bin} exec --skip-git-repo-check [[-m {model}]] [[resume {session}]] {prompt}",
            "text",
            "session",
            r"session id:\s*([0-9a-fA-F-]{36})",
        ),
        builtin("gemini", "Gemini CLI", "gemini", "{bin} [[-m {model}]] -p {prompt}", "text"),
        builtin("opencode", "opencode", "opencode", "{bin} run [[-m {model}]] {prompt}", "text"),
        builtin(
            "aider",
            "Aider",
            "aider",
            "{bin} --no-pretty --yes-always --no-check-update [[--model {model}]] --message {prompt}",
            "text",
        )
        .skills_inline(),
        builtin("cursor-agent", "Cursor Agent", "cursor-agent", "{bin} -p [[--model {model}]] {prompt}", "text"),
        builtin("qwen", "Qwen Code", "qwen", "{bin} [[-m {model}]] -p {prompt}", "text"),
        builtin("goose", "Goose", "goose", "{bin} run -t {prompt}", "text"),
        // GitHub Copilot CLI, on the user's Copilot subscription. `-p` runs one
        // prompt and ends with a `copilot --resume=SESSION-ID` hint.
        // Without a permission flag, actions that need approval are declined
        // (Paw's "ask"); deny rules beat allows, so plan mode holds.
        builtin_with(
            "copilot",
            "GitHub Copilot CLI",
            "copilot",
            "{bin} -p {prompt} --no-color --no-auto-update [[--model {model}]] [[{permission}]] [[--resume={session}]]",
            "text",
            "session",
            r"copilot --resume=([0-9a-fA-F-]{8,})",
        )
        .with_approvals(&[("edits", "--allow-tool=write"), ("plan", "--deny-tool=shell,write"), ("full", "--allow-all-tools")])
        // Skills' text goes in the prompt: reading files outside the folder needs approval.
        .skills_inline(),
        paw_agent(),
    ]
}

/// Models we suggest when a CLI has no way to list them. Users can add more.
fn suggested_models(id: &str) -> &'static [&'static str] {
    match id {
        "claude" => &[
            "opus",
            "sonnet",
            "haiku",
            "fable",
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "claude-haiku-5-5",
            "claude-fable-5-2",
        ],
        "codex" => &["gpt-5-codex", "gpt-5"],
        // From GitHub's docs; `auto` lets Copilot choose. `copilot` lists more in /model.
        "copilot" => &["auto", "claude-haiku-4.5", "gpt-5.3-codex"],
        "gemini" | "qwen" => &[],
        "aider" => &["sonnet", "opus", "gpt-5"],
        _ => &[],
    }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    crate::paths::config_dir(&app).map(|d| d.join("settings.json"))
}

/// Templates earlier versions of Paw shipped. A saved built-in agent whose
/// template is still one of these gets the current default; edited ones are kept.
const OLD_TEMPLATES: &[(&str, &str)] = &[
    ("claude", "{bin} -p --input-format stream-json --output-format stream-json --verbose [[--permission-mode {permission}]] [[--model {model}]]"),
    ("codex", "{bin} exec [[-m {model}]] {prompt}"),
    ("gemini", "{bin} [[-m {model}]] -p {prompt}"),
    ("opencode", "{bin} run [[-m {model}]] {prompt}"),
    ("aider", "{bin} --no-pretty --yes-always --no-check-update [[--model {model}]] --message {prompt}"),
    ("cursor-agent", "{bin} -p [[--model {model}]] {prompt}"),
    ("qwen", "{bin} [[-m {model}]] -p {prompt}"),
    ("goose", "{bin} run -t {prompt}"),
];

/// Levels added to the catalog after an agent was saved (auto). They are
/// added only while the agent's other levels are still the catalog's, so a
/// mapping the user wrote stays as it is.
fn add_new_levels(a: &mut AgentConfig, def: &AgentConfig) {
    const NEW: &[&str] = &["auto"];
    let untouched = a.approvals.iter().all(|(k, v)| def.approvals.get(k) == Some(v));
    if !untouched {
        return;
    }
    for l in NEW {
        if let (false, Some(v)) = (a.approvals.contains_key(*l), def.approvals.get(*l)) {
            a.approvals.insert(l.to_string(), v.clone());
        }
    }
}

/// Bring saved built-in agents up to the current catalog without losing edits.
fn migrate_agents(agents: &mut [AgentConfig]) {
    let cat = catalog();
    for a in agents.iter_mut().filter(|a| a.builtin) {
        let Some(def) = cat.iter().find(|b| b.id == a.id) else { continue };
        let pristine = a.template == def.template || OLD_TEMPLATES.iter().any(|(id, t)| *id == a.id && *t == a.template);
        if pristine {
            a.template = def.template.clone();
            a.io = def.io.clone();
            a.continuity = def.continuity.clone();
            a.session_pattern = def.session_pattern.clone();
        }
        if a.approvals.is_empty() {
            a.approvals = def.approvals.clone();
        }
        add_new_levels(a, def);
        if a.allow_template.is_empty() {
            a.allow_template = def.allow_template.clone();
        }
        if a.skills_template.is_none() {
            a.skills_template = def.skills_template.clone();
        }
        if a.skills_delivery.is_empty() {
            a.skills_delivery = def.skills_delivery.clone();
        }
        if a.io == "paw" {
            a.continuity = def.continuity.clone();
            a.session_pattern = def.session_pattern.clone();
            if a.provider.is_empty() {
                a.provider = def.provider.clone();
            }
            continue;
        }
        if !pristine && a.continuity.is_empty() {
            // Edited template: keep it, and fall back to Paw's own history.
            a.continuity = if a.template.contains("{session}") { def.continuity.clone() } else { "replay".into() };
            if a.session_pattern.is_empty() {
                a.session_pattern = def.session_pattern.clone();
            }
        }
    }
    for a in agents.iter_mut().filter(|a| !a.builtin && a.continuity.is_empty()) {
        a.continuity = "replay".into();
    }
    for a in agents.iter_mut().filter(|a| !a.builtin) {
        a.skills_template.get_or_insert_with(String::new);
        if a.skills_delivery.is_empty() {
            a.skills_delivery = "index".into();
        }
    }
}

/// Settings saved before the app was renamed (Hive → Paw): its built-in
/// themes and its own agent had "hive" in their ids.
fn rename_from_hive(s: &mut Settings) {
    for id in [&mut s.appearance.light, &mut s.appearance.dark] {
        if let Some(rest) = id.strip_prefix("hive-") {
            *id = format!("paw-{rest}");
        }
    }
    for a in s.agents.iter_mut().filter(|a| a.builtin && a.id == "hive") {
        a.id = "paw".into();
        a.io = "paw".into();
        if a.name == "Hive Agent" {
            a.name = "Paw Agent".into();
        }
        if a.key_source == "hive" {
            a.key_source = "paw".into();
        }
    }
    if s.general.default_agent.as_deref() == Some("hive") {
        s.general.default_agent = Some("paw".into());
    }
}

/// Built-in agents Paw no longer ships. Ollama runs inside Paw Agent now, so
/// the old `ollama run` agent goes, and Paw Agent takes over as the default.
const RETIRED: &[&str] = &["ollama"];
fn drop_retired_agents(s: &mut Settings) {
    s.agents.retain(|a| !(a.builtin && RETIRED.contains(&a.id.as_str())));
    if s.general.default_agent.as_deref().is_some_and(|d| RETIRED.contains(&d)) {
        s.general.default_agent = Some("paw".into());
    }
}

fn load(app: &AppHandle) -> Settings {
    let mut s: Settings = settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    rename_from_hive(&mut s);
    drop_retired_agents(&mut s);
    migrate_agents(&mut s.agents);
    // Add built-ins that are missing (new catalog entries, or a fresh install).
    for b in catalog() {
        if !s.agents.iter().any(|a| a.id == b.id) {
            s.agents.push(b);
        }
    }
    s
}

fn persist(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let p = settings_path(app).ok_or("No config directory")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| e.to_string())
}

impl Registry {
    pub fn settings(&self, app: &AppHandle) -> Settings {
        let mut guard = self.settings.lock().unwrap();
        guard.get_or_insert_with(|| load(app)).clone()
    }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// PATH as seen by the user's login shell (GUI apps get a minimal one).
static LOGIN_PATH: OnceLock<String> = OnceLock::new();

pub fn login_path() -> &'static str {
    LOGIN_PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        run_timeout(&shell, &["-lc", "printf %s \"$PATH\""], Duration::from_secs(8))
            .filter(|p| !p.trim().is_empty())
            .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
    })
}

/// Run a program with a timeout; returns stdout (falls back to stderr) on exit.
fn run_timeout(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        // Children (e.g. node-based CLIs) need the login-shell PATH to find their
        // interpreters. While computing login_path itself, inherit our own PATH.
        .env("PATH", LOGIN_PATH.get().cloned().unwrap_or_else(|| std::env::var("PATH").unwrap_or_default()))
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let mut err = child.stderr.take()?;
    let t_out = thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let t_err = thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(_) => return None,
        }
    }
    let o = t_out.join().unwrap_or_default();
    let e = t_err.join().unwrap_or_default();
    Some(if o.trim().is_empty() { e } else { o })
}

/// Run a program found on the login PATH with extra environment variables.
pub fn run_with_env(binary: &str, args: &[&str], env: &[(&str, &str)], timeout: Duration) -> Option<String> {
    let path = which(binary)?;
    let mut cmd = Command::new(&path);
    cmd.args(args)
        .env("PATH", login_path())
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        if !v.is_empty() {
            cmd.env(k, v);
        }
    }
    let mut child = cmd.spawn().ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(30)),
            Err(_) => return None,
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out)
}

/// Paw Agent: built in, so always available. Its models are the
/// provider's: Ollama's that can call tools, or Anthropic's.
fn detect_paw(cfg: &AgentConfig) -> Detection {
    let mut d = Detection { installed: true, version: Some("built-in".into()), ..Default::default() };
    if cfg.provider == "anthropic" {
        d.models = crate::paw_agent::ANTHROPIC_MODELS.iter().map(|m| m.to_string()).collect();
        let sources = crate::paw_agent::keys::list(&crate::paw_agent::keys::System);
        let chosen = sources.iter().find(|s| s.usable && (cfg.key_source.is_empty() || s.id == cfg.key_source));
        d.models_source = match chosen {
            Some(s) => format!("Anthropic API · key from {} ({})", s.label, s.detail),
            None => "Anthropic API · no usable API key found yet".into(),
        };
        return d;
    }
    let host = if cfg.base_url.trim().is_empty() { crate::paw_agent::DEFAULT_OLLAMA_URL } else { cfg.base_url.trim() };
    let Some(list) = run_with_env("ollama", &["list"], &[("OLLAMA_HOST", host)], Duration::from_secs(15)) else {
        d.models_source = "Ollama not found — install it, or switch Paw Agent to Anthropic in Settings".into();
        return d;
    };
    let names: Vec<String> = list.lines().skip(1).filter_map(|l| l.split_whitespace().next()).map(String::from).collect();
    let host = host.to_string();
    let checks: Vec<_> = names
        .into_iter()
        .map(|m| {
            let host = host.clone();
            thread::spawn(move || {
                let tools = crate::paw_agent::ollama_supports_tools(&host, &m);
                (m, tools)
            })
        })
        .collect();
    let (mut with, mut without) = (vec![], vec![]);
    for h in checks {
        if let Ok((m, tools)) = h.join() {
            if tools == Some(false) { without.push(m) } else { with.push(m) }
        }
    }
    d.models = with;
    d.models_source = if without.is_empty() {
        "ollama list (models with tool support)".into()
    } else {
        format!("ollama list (models with tool support; left out: {})", without.join(", "))
    };
    d
}

fn which(binary: &str) -> Option<String> {
    if binary.contains('/') {
        let p = expand_home(binary);
        return p.is_file().then(|| p.display().to_string());
    }
    for dir in login_path().split(':') {
        let p = PathBuf::from(dir).join(binary);
        if let Ok(meta) = std::fs::metadata(&p) {
            use std::os::unix::fs::PermissionsExt;
            if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                return Some(p.display().to_string());
            }
        }
    }
    None
}

fn expand_home(p: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    match p.strip_prefix("~/") {
        Some(rest) => PathBuf::from(home).join(rest),
        None if p == "~" => PathBuf::from(home),
        None => PathBuf::from(p),
    }
}

fn read_home(rel: &str) -> Option<String> {
    std::fs::read_to_string(expand_home(&format!("~/{rel}"))).ok()
}

/// `model = "..."` from a simple TOML file (top-level key only).
fn toml_model(text: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            break; // stop at first table; only top-level keys matter
        }
        if let Some(rest) = line.strip_prefix("model") {
            let rest = rest.trim_start();
            if let Some(v) = rest.strip_prefix('=') {
                return Some(v.trim().trim_matches('"').to_string()).filter(|s| !s.is_empty());
            }
        }
    }
    None
}

fn json_model(text: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    match v.get("model")? {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Object(o) => o.get("name").and_then(|n| n.as_str()).map(String::from),
        _ => None,
    }
}

fn discover_models(id: &str, path: &str) -> (Vec<String>, String, Option<String>) {
    let long = Duration::from_secs(15);
    let lines = |s: String| -> Vec<String> {
        s.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect()
    };
    match id {
        "opencode" => {
            if let Some(out) = run_timeout(path, &["models"], long) {
                let models: Vec<String> = lines(out).into_iter().filter(|l| l.contains('/')).collect();
                if !models.is_empty() {
                    return (models, "opencode models".into(), None);
                }
            }
            (vec![], "opencode models (failed)".into(), None)
        }
        _ => {
            let configured = match id {
                "claude" => read_home(".claude/settings.json").and_then(|t| json_model(&t)),
                "codex" => read_home(".codex/config.toml").and_then(|t| toml_model(&t)),
                "gemini" => read_home(".gemini/settings.json").and_then(|t| json_model(&t)),
                "qwen" => read_home(".qwen/settings.json").and_then(|t| json_model(&t)),
                "copilot" => read_home(".copilot/settings.json").and_then(|t| json_model(&t)),
                "aider" => read_home(".aider.conf.yml").and_then(|t| {
                    t.lines()
                        .find_map(|l| l.trim().strip_prefix("model:").map(|v| v.trim().trim_matches('"').to_string()))
                }),
                _ => None,
            };
            let mut models: Vec<String> = suggested_models(id).iter().map(|s| s.to_string()).collect();
            if let Some(c) = &configured {
                if !models.contains(c) {
                    models.insert(0, c.clone());
                }
            }
            let src = if models.is_empty() {
                "no model list available — add models by hand".into()
            } else {
                "built-in suggestions".into()
            };
            (models, src, configured)
        }
    }
}

fn detect_one(cfg: &AgentConfig) -> Detection {
    if cfg.io == "paw" {
        return detect_paw(cfg);
    }
    let Some(path) = which(&cfg.binary) else {
        return Detection { models_source: "not installed".into(), ..Default::default() };
    };
    let version = run_timeout(&path, &["--version"], Duration::from_secs(8))
        .and_then(|s| s.lines().map(str::trim).find(|l| !l.is_empty()).map(String::from));
    let (models, models_source, configured_model) = discover_models(&cfg.id, &path);
    Detection { installed: true, path: Some(path), version, models, models_source, configured_model }
}

fn scan(agents: &[AgentConfig]) -> HashMap<String, Detection> {
    login_path(); // resolve once before fanning out
    let handles: Vec<_> = agents
        .iter()
        .cloned()
        .map(|a| thread::spawn(move || (a.id.clone(), detect_one(&a))))
        .collect();
    handles.into_iter().filter_map(|h| h.join().ok()).collect()
}

/// Kick off a background scan; emits `agents:detected` with the result map.
pub fn start_scan(app: AppHandle) {
    let reg = app.state::<Registry>();
    {
        let mut s = reg.scanning.lock().unwrap();
        if *s {
            return;
        }
        *s = true;
    }
    let agents = reg.settings(&app).agents;
    thread::spawn(move || {
        let result = scan(&agents);
        let reg = app.state::<Registry>();
        *reg.detections.lock().unwrap() = result.clone();
        *reg.scanning.lock().unwrap() = false;
        let _ = app.emit("agents:detected", result);
    });
}

// ---------------------------------------------------------------------------
// Command templates
// ---------------------------------------------------------------------------

pub fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:=@+,".contains(c)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Expand placeholders in `seg`. Errs with the key name if a placeholder was empty.
fn expand(seg: &str, vals: &HashMap<&str, String>) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = seg;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let Some(j) = after.find('}') else {
            out.push_str(&rest[i..]);
            return Ok(out);
        };
        let key = &after[..j];
        match vals.get(key) {
            Some(v) if !v.is_empty() => out.push_str(&shell_quote(v)),
            Some(_) => return Err(key.to_string()),
            None => {
                // Unknown placeholder: keep literally.
                out.push('{');
                out.push_str(key);
                out.push('}');
            }
        }
        rest = &after[j + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

pub fn render(template: &str, vals: &HashMap<&str, String>) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(i) = rest.find("[[") {
        out.push_str(&expand(&rest[..i], vals).map_err(missing)?);
        let after = &rest[i + 2..];
        let j = after.find("]]").ok_or("Unclosed [[ in template")?;
        if let Ok(s) = expand(&after[..j], vals) {
            out.push_str(&s);
        }
        rest = &after[j + 2..];
    }
    out.push_str(&expand(rest, vals).map_err(missing)?);
    Ok(collapse_spaces_outside_quotes(&out))
}

/// Tidy runs of whitespace left by dropped `[[ … ]]` segments — but only
/// outside single quotes, so multi-line prompts keep their line breaks.
fn collapse_spaces_outside_quotes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut quoted = false;
    let mut pending_space = false;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if quoted {
            out.push(c);
            if c == '\'' {
                quoted = false;
            }
            continue;
        }
        if c.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(c);
        if c == '\\' {
            // `\'` (how a quote is written inside '…'): the next char is literal.
            if let Some(n) = chars.next() {
                out.push(n);
            }
        } else if c == '\'' {
            quoted = true;
        }
    }
    out
}

fn missing(key: String) -> String {
    match key.as_str() {
        "model" => "This agent needs a model — pick one.".into(),
        "prompt" => "Describe the task first.".into(),
        k => format!("Missing value for {{{k}}}"),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(app: AppHandle, reg: State<'_, Registry>) -> Settings {
    reg.settings(&app)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, reg: State<'_, Registry>, settings: Settings) -> Result<(), String> {
    persist(&app, &settings)?;
    *reg.settings.lock().unwrap() = Some(settings.clone());
    apply_window_theme(&app, &settings.appearance.mode);
    let _ = app.emit("settings:changed", settings);
    Ok(())
}

/// The macOS appearance for a mode: None follows the system.
pub fn window_theme(mode: &str) -> Option<tauri::Theme> {
    match mode {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    }
}

/// Force (or release) light/dark on every Paw window. The webviews' CSS
/// `prefers-color-scheme` and the vibrancy material follow it.
pub fn apply_window_theme(app: &AppHandle, mode: &str) {
    for w in app.webview_windows().values() {
        let _ = w.set_theme(window_theme(mode));
    }
}

/// Return cached detections (and start a scan if none yet / `rescan`).
#[tauri::command]
pub fn get_detections(app: AppHandle, reg: State<'_, Registry>, rescan: Option<bool>) -> HashMap<String, Detection> {
    let cached = reg.detections.lock().unwrap().clone();
    if rescan.unwrap_or(false) || cached.is_empty() {
        start_scan(app);
    }
    cached
}

#[tauri::command]
pub fn is_scanning(reg: State<'_, Registry>) -> bool {
    *reg.scanning.lock().unwrap()
}

/// Build the command line for an agent definition.
#[tauri::command]
pub fn render_command(
    reg: State<'_, Registry>,
    agent: AgentConfig,
    prompt: Option<String>,
    model: Option<String>,
    permission: Option<String>,
    session: Option<String>,
) -> Result<String, String> {
    let bin = reg
        .detections
        .lock()
        .unwrap()
        .get(&agent.id)
        .and_then(|d| d.path.clone())
        .unwrap_or_else(|| agent.binary.clone());
    let mut vals = HashMap::new();
    vals.insert("bin", bin);
    vals.insert("prompt", prompt.unwrap_or_default());
    vals.insert("model", model.unwrap_or_default());
    vals.insert("permission", permission.unwrap_or_default());
    vals.insert("session", session.unwrap_or_default());
    render(&agent.template, &vals)
}

#[tauri::command]
pub fn reset_agent(id: String) -> Option<AgentConfig> {
    catalog().into_iter().find(|a| a.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vals(p: &str, m: &str) -> HashMap<&'static str, String> {
        HashMap::from([
            ("bin", "/usr/bin/codex".to_string()),
            ("prompt", p.to_string()),
            ("model", m.to_string()),
            ("permission", String::new()),
            ("session", String::new()),
        ])
    }

    #[test]
    fn optional_segments() {
        let t = "{bin} exec [[-m {model}]] {prompt}";
        assert_eq!(render(t, &vals("fix it", "")).unwrap(), "/usr/bin/codex exec 'fix it'");
        assert_eq!(render(t, &vals("fix it", "gpt-5")).unwrap(), "/usr/bin/codex exec -m gpt-5 'fix it'");
        assert_eq!(render(t, &vals("it's", "")).unwrap(), r"/usr/bin/codex exec 'it'\''s'");
    }

    #[test]
    fn session_segment() {
        let mut v = vals("hi", "");
        let t = "{bin} exec [[resume {session}]] {prompt}";
        assert_eq!(render(t, &v).unwrap(), "/usr/bin/codex exec hi");
        v.insert("session", "0199a-b".into());
        assert_eq!(render(t, &v).unwrap(), "/usr/bin/codex exec resume 0199a-b hi");
    }

    #[test]
    fn workspace_tabs_live_in_session_folders() {
        let home = std::env::temp_dir().join(format!("paw-ws-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let id = "5b0c1d2e-aaaa-bbbb-cccc-0123456789ab";
        let ws = serde_json::json!({ "version": 1, "active": 0, "tabs": [
            { "id": id, "agent": "claude", "lines": [{ "stream": "stdin", "text": "hi" }] },
            { "agent": "paw", "cwd": "~" },
        ]});
        save_workspace_in(&home, ws.clone()).unwrap();
        let saved = read_json(&home.join("workspace.json")).unwrap();
        assert_eq!(saved["tabs"][0], serde_json::json!({ "id": id }), "only a reference in workspace.json");
        assert_eq!(read_json(&home.join("session").join(id).join("session.json")).unwrap()["agent"], "claude");
        assert_eq!(load_workspace_in(&home), ws, "loads back the same");
        // A tab whose folder is gone is dropped.
        std::fs::remove_dir_all(home.join("session")).unwrap();
        assert_eq!(load_workspace_in(&home)["tabs"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn auto_level_reaches_saved_agents() {
        let cat = catalog();
        let claude = cat.iter().find(|a| a.id == "claude").unwrap();
        assert_eq!(claude.approvals.get("auto").map(String::as_str), Some("auto"));
        // Saved before auto existed: it's added.
        let mut old = claude.clone();
        old.approvals.remove("auto");
        // Edited by the user: left alone.
        let mut edited = claude.clone();
        edited.approvals.remove("auto");
        edited.approvals.insert("edits".into(), "--my-edits".into());
        let mut agents = vec![old, edited];
        migrate_agents(&mut agents);
        assert_eq!(agents[0].approvals.get("auto").map(String::as_str), Some("auto"));
        assert!(!agents[1].approvals.contains_key("auto"));
        assert!(paw_agent().approvals.contains_key("auto"));
    }

    #[test]
    fn migrates_pristine_templates_only() {
        let mut old = catalog();
        for a in old.iter_mut() {
            if let Some((_, t)) = OLD_TEMPLATES.iter().find(|(id, _)| *id == a.id) {
                a.template = t.to_string();
            }
            a.continuity.clear();
            a.session_pattern.clear();
        }
        old[1].template = "{bin} exec --my-flag {prompt}".into(); // user-edited codex
        migrate_agents(&mut old);
        let cat = catalog();
        assert_eq!(old[0].template, cat[0].template);
        assert_eq!(old[0].continuity, "session");
        assert_eq!(old[1].template, "{bin} exec --my-flag {prompt}");
        assert_eq!(old[1].continuity, "replay");
        assert_eq!(old[0].approvals.get("edits").map(String::as_str), Some("acceptEdits"));
        assert!(old[1].approvals.is_empty());
        assert_eq!(old[0].allow_template, "--allowedTools {rule}");
    }

    #[test]
    fn keeps_newlines_inside_quotes() {
        let t = "{bin}   exec [[-m {model}]]   {prompt}";
        assert_eq!(render(t, &vals("line one\nline  two", "")).unwrap(), "/usr/bin/codex exec 'line one\nline  two'");
        assert_eq!(render(t, &vals("it's\nok", "")).unwrap(), "/usr/bin/codex exec 'it'\\''s\nok'");
    }

    #[test]
    fn paw_agent_in_catalog_and_migrated() {
        let h = catalog().into_iter().find(|a| a.id == "paw").expect("Paw Agent in the catalog");
        assert_eq!((h.io.as_str(), h.continuity.as_str(), h.provider.as_str()), ("paw", "session", "ollama"));
        assert_eq!(h.approvals.get("edits").map(String::as_str), Some("edits"));
        // Settings saved by this version, read back; and a damaged entry gets its defaults again.
        let json = serde_json::to_string(&h).unwrap();
        let mut saved: AgentConfig = serde_json::from_str(&json).unwrap();
        saved.continuity.clear();
        saved.provider.clear();
        let mut v = vec![saved];
        migrate_agents(&mut v);
        assert_eq!((v[0].continuity.as_str(), v[0].provider.as_str()), ("session", "ollama"));
        assert!(v[0].session_pattern.contains("session_id"));
        // Settings from before Paw Agent existed still load (no provider/base_url fields).
        let old = r#"{"id":"x","name":"X","binary":"x","template":"{bin} {prompt}","io":"text","enabled":true,"builtin":false}"#;
        let a: AgentConfig = serde_json::from_str(old).unwrap();
        assert_eq!((a.provider.as_str(), a.base_url.as_str()), ("", ""));
    }

    #[test]
    fn settings_from_hive_carry_over() {
        let mut h = catalog().into_iter().find(|a| a.id == "paw").unwrap();
        (h.id, h.io, h.name, h.key_source) = ("hive".into(), "hive".into(), "Hive Agent".into(), "hive".into());
        let mut s = Settings::default();
        s.agents = vec![h];
        s.appearance.light = "hive-light".into();
        s.appearance.dark = "dracula".into();
        s.general.default_agent = Some("hive".into());
        rename_from_hive(&mut s);
    drop_retired_agents(&mut s);
        let a = &s.agents[0];
        assert_eq!((a.id.as_str(), a.io.as_str(), a.name.as_str(), a.key_source.as_str()), ("paw", "paw", "Paw Agent", "paw"));
        assert_eq!((s.appearance.light.as_str(), s.appearance.dark.as_str()), ("paw-light", "dracula"));
        assert_eq!(s.general.default_agent.as_deref(), Some("paw"));
    }

    #[test]
    fn ollama_agent_is_retired() {
        assert!(!catalog().iter().any(|a| a.id == "ollama"));
        let mut s = Settings::default();
        let mut builtin = catalog().into_iter().find(|a| a.id == "claude").unwrap();
        builtin.id = "ollama".into();
        let mut mine = builtin.clone();
        (mine.id, mine.builtin) = ("my-ollama".into(), false);
        s.agents = vec![builtin, mine];
        s.general.default_agent = Some("ollama".into());
        drop_retired_agents(&mut s);
        assert_eq!(s.agents.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["my-ollama"], "an agent you made yourself stays");
        assert_eq!(s.general.default_agent.as_deref(), Some("paw"));
    }

    #[test]
    fn copilot_cli_commands() {
        let c = catalog().into_iter().find(|a| a.id == "copilot").expect("Copilot CLI in the catalog");
        assert_eq!((c.io.as_str(), c.continuity.as_str(), c.skills_delivery.as_str()), ("text", "session", "inline"));
        let mut v = HashMap::from([
            ("bin", "/opt/homebrew/bin/copilot".to_string()),
            ("prompt", "fix the tests".to_string()),
            ("model", String::new()),
            ("permission", String::new()),
            ("session", String::new()),
        ]);
        // A first prompt at "ask": no permission flag, so approvals are declined.
        assert_eq!(render(&c.template, &v).unwrap(), "/opt/homebrew/bin/copilot -p 'fix the tests' --no-color --no-auto-update");
        // A follow-up at "plan", with a model, continuing the session.
        v.insert("model", "gpt-5.3-codex".into());
        v.insert("permission", c.approvals["plan"].clone());
        v.insert("session", "8f301db2-a3ad-41fe-8280-e01ae850076a".into());
        assert_eq!(
            render(&c.template, &v).unwrap(),
            "/opt/homebrew/bin/copilot -p 'fix the tests' --no-color --no-auto-update --model gpt-5.3-codex \
--deny-tool=shell,write --resume=8f301db2-a3ad-41fe-8280-e01ae850076a"
        );
        v.insert("permission", c.approvals["edits"].clone());
        assert!(render(&c.template, &v).unwrap().contains(" --allow-tool=write "));
        assert!(!c.approvals.contains_key("ask"));
        // The session id comes from the exit summary's resume hint.
        let line = "Resume this session with: copilot --resume=8f301db2-a3ad-41fe-8280-e01ae850076a";
        let id = line.split("copilot --resume=").nth(1).unwrap();
        assert!(c.session_pattern.contains("copilot --resume=") && id.len() == 36);
    }

    #[test]
    fn required_model() {
        assert!(render("{bin} run {model} {prompt}", &vals("hi", "")).is_err());
    }

    #[test]
    fn toml_parse() {
        assert_eq!(toml_model("model = \"o3\"\n[x]\nmodel=\"no\"").as_deref(), Some("o3"));
        assert_eq!(toml_model("model_provider = \"x\""), None);
    }
}

#[cfg(test)]
mod scan_tests {
    /// Real detection against this machine: `cargo test -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn scan_this_machine() {
        let mut r: Vec<_> = super::scan(&super::catalog()).into_iter().collect();
        r.sort_by(|a, b| a.0.cmp(&b.0));
        for (id, d) in r {
            println!("{id:13} installed={} version={:?} models={} via {:?} cfg={:?}",
                d.installed, d.version, d.models.len(), d.models_source, d.configured_model);
            if !d.models.is_empty() { println!("              {:?}", &d.models[..d.models.len().min(6)]); }
        }
    }
}

// ---------------------------------------------------------------------------
// Workspace: the open tabs, restored on the next launch
// ---------------------------------------------------------------------------


// workspace.json lists the tabs by id; each tab's state (agent, folder,
// transcript, task…) is in its session folder, `session/<id>/session.json`.
// Tabs saved before session folders had their state inline; they still load.

#[tauri::command]
pub fn load_workspace(app: AppHandle) -> serde_json::Value {
    crate::paths::config_dir(&app).map(|h| load_workspace_in(&h)).unwrap_or(serde_json::Value::Null)
}

#[tauri::command]
pub fn save_workspace(app: AppHandle, workspace: serde_json::Value) -> Result<(), String> {
    let home = crate::paths::config_dir(&app).ok_or("No config directory")?;
    save_workspace_in(&home, workspace)
}

fn read_json(p: &Path) -> Option<serde_json::Value> {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok())
}

/// Write-then-rename so a crash mid-save never leaves a truncated file.
fn write_json(p: &Path, v: &serde_json::Value) -> Result<(), String> {
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| e.to_string())
}

/// A tab in workspace.json that only names its session folder.
fn tab_ref(t: &serde_json::Value) -> Option<&str> {
    let o = t.as_object()?;
    (o.len() == 1).then(|| o.get("id")?.as_str()).flatten()
}

pub fn load_workspace_in(home: &Path) -> serde_json::Value {
    let mut ws = read_json(&home.join("workspace.json")).unwrap_or(serde_json::Value::Null);
    if let Some(tabs) = ws.get_mut("tabs").and_then(|t| t.as_array_mut()) {
        let loaded: Vec<serde_json::Value> = tabs
            .iter()
            .filter_map(|t| match tab_ref(t) {
                Some(id) => crate::paths::session_dir_in(home, id).and_then(|d| read_json(&d.join("session.json"))),
                None => Some(t.clone()),
            })
            .collect();
        *tabs = loaded;
    }
    ws
}

pub fn save_workspace_in(home: &Path, mut workspace: serde_json::Value) -> Result<(), String> {
    if let Some(tabs) = workspace.get_mut("tabs").and_then(|t| t.as_array_mut()) {
        for t in tabs.iter_mut() {
            let Some(id) = t.get("id").and_then(|v| v.as_str()).map(str::to_string) else { continue };
            let Some(dir) = crate::paths::session_dir_in(home, &id) else { continue };
            write_json(&dir.join("session.json"), t)?;
            *t = serde_json::json!({ "id": id });
        }
    }
    write_json(&home.join("workspace.json"), &workspace)
}
