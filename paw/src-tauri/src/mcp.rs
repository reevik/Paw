//! MCP servers, per agent: Paw Agent's own list, and each CLI agent's own
//! config files, which the MCP panel reads and changes.
//!
//! | agent        | scopes and files                                                        |
//! |--------------|-------------------------------------------------------------------------|
//! | Paw Agent   | `<config>/mcp_servers.json` (Paw's own list)                           |
//! | Claude Code  | user and local: `~/.claude.json`; project: `.mcp.json` — written with `claude mcp add-json/remove`, never by hand |
//! | Codex        | `~/.codex/config.toml` `[mcp_servers.<name>]` (comments kept)           |
//! | Gemini, Qwen | `~/.gemini/settings.json`, `.gemini/settings.json` (`.qwen/…` alike)     |
//! | Cursor Agent | `~/.cursor/mcp.json`, `.cursor/mcp.json`                                 |
//! | opencode     | `~/.config/opencode/opencode.json`, `opencode.json` (`mcp`)             |
//! | Copilot CLI  | `~/.copilot/mcp-config.json`                                             |
//!
//! Before a file is changed, its previous content is kept beside it as
//! `<file>.paw-backup`. JSON keeps its key order; a file Paw can't parse
//! (JSON with comments) is shown but left alone. Env and header values never
//! leave the backend: the panel sees their names only.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn yes() -> bool {
    true
}

/// One MCP server, in Paw's terms.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct McpServer {
    pub name: String,
    /// "stdio" (a local command), "http" (streamable HTTP) or "sse".
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Claude Code: a project (.mcp.json) server nobody approved or rejected yet.
    #[serde(skip)]
    pub pending: bool,
}

/// What the panel gets: no env or header values.
#[derive(Serialize, Debug)]
pub struct ServerView {
    pub name: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub env_keys: Vec<String>,
    pub url: String,
    pub header_keys: Vec<String>,
    pub enabled: bool,
    pub pending: bool,
}

impl From<&McpServer> for ServerView {
    fn from(s: &McpServer) -> Self {
        ServerView {
            name: s.name.clone(),
            transport: s.transport.clone(),
            command: s.command.clone(),
            args: s.args.clone(),
            env_keys: s.env.keys().cloned().collect(),
            url: s.url.clone(),
            header_keys: s.headers.keys().cloned().collect(),
            enabled: s.enabled,
            pending: s.pending,
        }
    }
}

#[derive(Serialize, Debug)]
pub struct ScopeView {
    pub id: String,
    pub label: String,
    pub file: String,
    pub writable: bool,
    /// Servers can be switched off without removing them.
    pub can_toggle: bool,
    /// Why it's read-only, or a problem reading it.
    pub note: String,
    pub servers: Vec<ServerView>,
}

#[derive(Serialize, Debug)]
pub struct Report {
    pub agent: String,
    pub supported: bool,
    pub note: String,
    pub scopes: Vec<ScopeView>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Format {
    Paw,
    /// `~/.claude.json` top-level `mcpServers`.
    ClaudeUser,
    /// `~/.claude.json` `projects[<folder>].mcpServers`.
    ClaudeLocal,
    /// `.mcp.json` `mcpServers`.
    ClaudeProject,
    Codex,
    /// Gemini CLI and Qwen Code: `httpUrl` is streamable HTTP, `url` SSE.
    Gemini,
    Cursor,
    Opencode,
    Copilot,
}

struct Location {
    id: &'static str,
    label: &'static str,
    file: PathBuf,
    format: Format,
}

/// Where an agent keeps its MCP servers. Empty: it has none Paw knows of.
fn locations(agent: &str, cwd: &Path, home: &Path, config_dir: Option<&Path>) -> Vec<Location> {
    let loc = |id, label, file: PathBuf, format| Location { id, label, file, format };
    match agent {
        "paw" => config_dir
            .map(|d| vec![loc("paw", "Paw Agent", d.join("mcp_servers.json"), Format::Paw)])
            .unwrap_or_default(),
        "claude" => vec![
            loc("user", "User — every project", home.join(".claude.json"), Format::ClaudeUser),
            loc("local", "This folder — only you", home.join(".claude.json"), Format::ClaudeLocal),
            loc("project", "Project — shared in .mcp.json", claude_project_root(cwd).join(".mcp.json"), Format::ClaudeProject),
        ],
        "codex" => vec![loc("user", "User", home.join(".codex/config.toml"), Format::Codex)],
        "gemini" => vec![
            loc("user", "User", home.join(".gemini/settings.json"), Format::Gemini),
            loc("project", "Project", cwd.join(".gemini/settings.json"), Format::Gemini),
        ],
        "qwen" => vec![
            loc("user", "User", home.join(".qwen/settings.json"), Format::Gemini),
            loc("project", "Project", cwd.join(".qwen/settings.json"), Format::Gemini),
        ],
        "cursor-agent" => vec![
            loc("user", "User", home.join(".cursor/mcp.json"), Format::Cursor),
            loc("project", "Project", cwd.join(".cursor/mcp.json"), Format::Cursor),
        ],
        "opencode" => {
            let dir = home.join(".config/opencode");
            let user = if dir.join("opencode.jsonc").exists() && !dir.join("opencode.json").exists() {
                dir.join("opencode.jsonc")
            } else {
                dir.join("opencode.json")
            };
            vec![loc("user", "User", user, Format::Opencode), loc("project", "Project", cwd.join("opencode.json"), Format::Opencode)]
        }
        "copilot" => vec![loc("user", "User", home.join(".copilot/mcp-config.json"), Format::Copilot)],
        _ => vec![],
    }
}

fn unsupported_note(agent: &str) -> String {
    match agent {
        "aider" | "ollama" => "This agent doesn't use MCP servers.".into(),
        "goose" => "Goose keeps MCP servers as extensions in ~/.config/goose/config.yaml; Paw can't edit that file yet.".into(),
        _ => "Paw doesn't know where this agent keeps its MCP servers.".into(),
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

fn str_map(v: Option<&Value>) -> BTreeMap<String, String> {
    v.and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .map(|(k, x)| (k.clone(), x.as_str().map(String::from).unwrap_or_else(|| x.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// One entry of a JSON config, in Paw's terms.
fn from_json(format: Format, name: &str, e: &Value) -> McpServer {
    let mut out = McpServer { name: name.into(), enabled: true, ..Default::default() };
    if format == Format::Opencode {
        let cmd = strs(e.get("command"));
        out.enabled = e.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        if s(e, "type") == "remote" || !s(e, "url").is_empty() {
            out.transport = "http".into();
            out.url = s(e, "url");
            out.headers = str_map(e.get("headers"));
        } else {
            out.transport = "stdio".into();
            out.command = cmd.first().cloned().unwrap_or_default();
            out.args = cmd.into_iter().skip(1).collect();
            out.env = str_map(e.get("environment"));
        }
        return out;
    }
    let ty = s(e, "type");
    out.command = s(e, "command");
    out.args = strs(e.get("args"));
    out.env = str_map(e.get("env"));
    out.headers = str_map(e.get("headers"));
    if format == Format::Paw {
        out.enabled = e.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    }
    let http_url = s(e, "httpUrl");
    if !out.command.is_empty() {
        out.transport = "stdio".into();
    } else if !http_url.is_empty() {
        out.transport = "http".into();
        out.url = http_url;
    } else {
        out.url = s(e, "url");
        out.transport = if ty == "sse" || (format == Format::Gemini && !out.url.is_empty()) { "sse".into() } else { "http".into() };
    }
    if format == Format::Paw && !s(e, "transport").is_empty() {
        out.transport = s(e, "transport");
    }
    out
}

/// The folder Claude Code files a session's project settings under (its
/// `projects` key in ~/.claude.json): the git root above the folder, or the
/// folder itself.
pub fn claude_project_root(cwd: &Path) -> PathBuf {
    let start = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let mut dir = Some(start.as_path());
    while let Some(d) = dir {
        if d.join(".git").exists() {
            return d.to_path_buf();
        }
        dir = d.parent();
    }
    start
}

fn claude_project_key(cwd: &Path) -> String {
    claude_project_root(cwd).display().to_string()
}

/// The `mcpServers`-like object of a JSON config, for a format.
fn json_servers<'a>(format: Format, root: &'a Value, cwd: &Path) -> Option<&'a Map<String, Value>> {
    match format {
        Format::ClaudeLocal => root.get("projects")?.get(claude_project_key(cwd))?.get("mcpServers")?.as_object(),
        Format::Opencode => root.get("mcp")?.as_object(),
        _ => root.get("mcpServers")?.as_object(),
    }
}

fn read_json_file(path: &Path) -> Result<Option<Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(t) if t.trim().is_empty() => Ok(Some(json!({}))),
        Ok(t) => serde_json::from_str(&t).map(Some).map_err(|_| "Not plain JSON (comments?) — shown read-only; edit it by hand.".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn read_codex(path: &Path) -> Result<Vec<McpServer>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let doc: toml_edit::DocumentMut = text.parse().map_err(|e| format!("Can't read it: {e}"))?;
    let Some(table) = doc.get("mcp_servers").and_then(|t| t.as_table_like()) else { return Ok(vec![]) };
    let mut out = vec![];
    for (name, item) in table.iter() {
        let Some(t) = item.as_table_like() else { continue };
        let get = |k: &str| t.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let args = t
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let map = |k: &str| -> BTreeMap<String, String> {
            t.get(k)
                .and_then(|v| v.as_table_like())
                .map(|e| e.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.to_string(), v.to_string()))).collect())
                .unwrap_or_default()
        };
        let command = get("command");
        let url = get("url");
        out.push(McpServer {
            name: name.to_string(),
            transport: if command.is_empty() && !url.is_empty() { "http".into() } else { "stdio".into() },
            command,
            args,
            env: map("env"),
            url,
            headers: map("http_headers"),
            enabled: t.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
            pending: false,
        });
    }
    Ok(out)
}

fn read_location(l: &Location, cwd: &Path) -> Result<Vec<McpServer>, String> {
    if l.format == Format::Codex {
        return read_codex(&l.file);
    }
    let Some(root) = read_json_file(&l.file)? else { return Ok(vec![]) };
    if l.format == Format::Paw {
        return Ok(root.as_array().map(|a| a.iter().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect()).unwrap_or_default());
    }
    Ok(json_servers(l.format, &root, cwd)
        .map(|o| o.iter().map(|(name, e)| from_json(l.format, name, e)).collect())
        .unwrap_or_default())
}

// ---------- Claude Code: which servers are on ----------
// As Claude Code itself decides (2.1.x):
// - a user or local server is off when the project entry of ~/.claude.json
//   lists it in `disabledMcpServers` (what `/mcp disable` writes);
// - a project (.mcp.json) server is off when any settings file lists it in
//   `disabledMcpjsonServers`, on when one lists it in `enabledMcpjsonServers`
//   (or sets `enableAllProjectMcpServers`), and waiting for approval
//   otherwise. Old copies of these lists in the project entry of
//   ~/.claude.json count too (Claude Code moves them on its next start).

struct ClaudeState {
    /// The project entry of ~/.claude.json.
    project: Value,
    /// User, shared project and local settings, in that order.
    settings: [Value; 3],
}

fn claude_settings_files(home: &Path, cwd: &Path) -> [PathBuf; 3] {
    let root = claude_project_root(cwd);
    [home.join(".claude/settings.json"), root.join(".claude/settings.json"), root.join(".claude/settings.local.json")]
}

fn claude_state(home: &Path, cwd: &Path) -> ClaudeState {
    let global = read_json_file(&home.join(".claude.json")).ok().flatten().unwrap_or(Value::Null);
    let project = global.get("projects").and_then(|p| p.get(claude_project_key(cwd))).cloned().unwrap_or(Value::Null);
    let settings = claude_settings_files(home, cwd).map(|f| read_json_file(&f).ok().flatten().unwrap_or(Value::Null));
    ClaudeState { project, settings }
}

fn lists(v: &Value, key: &str, name: &str) -> bool {
    v.get(key).and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(name)))
}

impl ClaudeState {
    fn server_off(&self, name: &str) -> bool {
        lists(&self.project, "disabledMcpServers", name)
    }
    /// (on, pending) for a project server.
    fn project_server(&self, name: &str) -> (bool, bool) {
        let all = || self.settings.iter().chain(std::iter::once(&self.project));
        if all().any(|v| lists(v, "disabledMcpjsonServers", name)) || self.server_off(name) {
            return (false, false);
        }
        if all().any(|v| lists(v, "enabledMcpjsonServers", name) || v.get("enableAllProjectMcpServers") == Some(&json!(true))) {
            return (true, false);
        }
        (false, true)
    }
}

fn apply_claude_state(format: Format, servers: &mut [McpServer], state: &ClaudeState) {
    for s in servers {
        match format {
            Format::ClaudeProject => (s.enabled, s.pending) = state.project_server(&s.name),
            Format::ClaudeUser | Format::ClaudeLocal => s.enabled = !state.server_off(&s.name),
            _ => {}
        }
    }
}

/// Copilot CLI's servers, as `copilot mcp list --json` reports them: every
/// source (built-in, plugins, user, workspace) and whether each is on.
fn copilot_scopes(list: &Value, home: &Path) -> Vec<ScopeView> {
    let mut by_source: Vec<(String, Vec<McpServer>)> = vec![];
    for (name, e) in list.get("mcpServers").and_then(Value::as_object).into_iter().flatten() {
        let mut srv = from_json(Format::Copilot, name, e);
        srv.enabled = e.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        let source = s(e, "source");
        let source = if source.is_empty() { "user".to_string() } else { source };
        match by_source.iter_mut().find(|(k, _)| *k == source) {
            Some((_, v)) => v.push(srv),
            None => by_source.push((source, vec![srv])),
        }
    }
    if !by_source.iter().any(|(k, _)| k == "user") {
        by_source.push(("user".into(), vec![]));
    }
    by_source
        .into_iter()
        .map(|(source, servers)| {
            let user = source == "user";
            ScopeView {
                label: match source.as_str() {
                    "user" => "User".into(),
                    "builtin" => "Built-in".into(),
                    "workspace" => "Workspace (.mcp.json)".into(),
                    "plugin" => "Plugins".into(),
                    other => other.to_string(),
                },
                file: if user { home.join(".copilot/mcp-config.json").display().to_string() } else { String::new() },
                writable: user,
                can_toggle: true,
                note: String::new(),
                servers: servers.iter().map(ServerView::from).collect(),
                id: source,
            }
        })
        .collect()
}

/// Every scope of an agent, with its servers.
pub fn report(agent: &str, cwd: &Path, home: &Path, config_dir: Option<&Path>, clis: &dyn Clis) -> Report {
    let locs = locations(agent, cwd, home, config_dir);
    if locs.is_empty() {
        return Report { agent: agent.into(), supported: false, note: unsupported_note(agent), scopes: vec![] };
    }
    if agent == "copilot" {
        if let Some(list) = clis.copilot_list(cwd) {
            return Report { agent: agent.into(), supported: true, note: String::new(), scopes: copilot_scopes(&list, home) };
        }
    }
    let claude = agent == "claude";
    let claude_cli = claude && clis.claude_installed();
    let state = claude.then(|| claude_state(home, cwd));
    let scopes = locs
        .iter()
        .map(|l| {
            let (mut servers, mut note) = match read_location(l, cwd) {
                Ok(v) => (v, String::new()),
                Err(e) => (vec![], e),
            };
            if let Some(st) = &state {
                apply_claude_state(l.format, &mut servers, st);
            }
            let read_ok = note.is_empty();
            let mut writable = read_ok;
            if claude && !claude_cli {
                writable = false;
                note = "Adding and removing go through the `claude` command, which wasn't found.".into();
            }
            if l.file.extension().is_some_and(|e| e == "jsonc") {
                writable = false;
                if note.is_empty() {
                    note = "JSON with comments — shown read-only; edit it by hand.".into();
                }
            }
            ScopeView {
                id: l.id.into(),
                label: l.label.into(),
                file: l.file.display().to_string(),
                writable,
                // Claude Code's switches are settings, not `claude mcp` commands.
                can_toggle: (writable && matches!(l.format, Format::Paw | Format::Opencode | Format::Codex)) || (claude && read_ok),
                note,
                servers: servers.iter().map(ServerView::from).collect(),
            }
        })
        .collect();
    Report { agent: agent.into(), supported: true, note: String::new(), scopes }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

pub fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 64 && n.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

fn check(server: &McpServer) -> Result<(), String> {
    if !valid_name(&server.name) {
        return Err("A server name uses letters, digits, - _ and . (up to 64)".into());
    }
    match server.transport.as_str() {
        "stdio" if server.command.trim().is_empty() => Err("A local server needs a command".into()),
        "http" | "sse" if !(server.url.starts_with("http://") || server.url.starts_with("https://")) => {
            Err("A remote server needs an http(s) URL".into())
        }
        "stdio" | "http" | "sse" => Ok(()),
        _ => Err("Pick local (command), HTTP or SSE".into()),
    }
}

/// A server as an entry of a JSON config, in that format.
fn to_json(format: Format, s: &McpServer) -> Value {
    let stdio = s.transport == "stdio";
    let mut o = Map::new();
    let put_map = |o: &mut Map<String, Value>, k: &str, m: &BTreeMap<String, String>| {
        if !m.is_empty() {
            o.insert(k.into(), json!(m));
        }
    };
    match format {
        Format::Paw => return serde_json::to_value(s).unwrap_or_default(),
        Format::Opencode => {
            if stdio {
                let mut cmd = vec![s.command.clone()];
                cmd.extend(s.args.iter().cloned());
                o.insert("type".into(), json!("local"));
                o.insert("command".into(), json!(cmd));
                put_map(&mut o, "environment", &s.env);
            } else {
                o.insert("type".into(), json!("remote"));
                o.insert("url".into(), json!(s.url));
                put_map(&mut o, "headers", &s.headers);
            }
            o.insert("enabled".into(), json!(s.enabled));
        }
        Format::Gemini => {
            if stdio {
                o.insert("command".into(), json!(s.command));
                o.insert("args".into(), json!(s.args));
                put_map(&mut o, "env", &s.env);
            } else {
                o.insert(if s.transport == "sse" { "url" } else { "httpUrl" }.into(), json!(s.url));
                put_map(&mut o, "headers", &s.headers);
            }
        }
        Format::Cursor => {
            if stdio {
                o.insert("command".into(), json!(s.command));
                o.insert("args".into(), json!(s.args));
                put_map(&mut o, "env", &s.env);
            } else {
                o.insert("url".into(), json!(s.url));
                put_map(&mut o, "headers", &s.headers);
            }
        }
        Format::Copilot => {
            o.insert("type".into(), json!(if stdio { "local" } else { s.transport.as_str() }));
            if stdio {
                o.insert("command".into(), json!(s.command));
                o.insert("args".into(), json!(s.args));
                put_map(&mut o, "env", &s.env);
            } else {
                o.insert("url".into(), json!(s.url));
                put_map(&mut o, "headers", &s.headers);
            }
            o.insert("tools".into(), json!(["*"]));
        }
        Format::ClaudeUser | Format::ClaudeLocal | Format::ClaudeProject | Format::Codex => {
            o.insert("type".into(), json!(s.transport));
            if stdio {
                o.insert("command".into(), json!(s.command));
                o.insert("args".into(), json!(s.args));
                put_map(&mut o, "env", &s.env);
            } else {
                o.insert("url".into(), json!(s.url));
                put_map(&mut o, "headers", &s.headers);
            }
        }
    }
    Value::Object(o)
}

/// Write `text` to `path`: the old content kept as `<path>.paw-backup`,
/// the file's permissions kept, replaced in one step.
fn write_file(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let perms = std::fs::metadata(path).ok().map(|m| m.permissions());
    if path.exists() {
        let mut backup = path.as_os_str().to_owned();
        backup.push(".paw-backup");
        std::fs::copy(path, PathBuf::from(backup)).map_err(|e| format!("Couldn't keep a backup: {e}"))?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".paw-tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    if let Some(p) = perms {
        let _ = std::fs::set_permissions(&tmp, p);
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Change the server map of a JSON config (not Claude Code's: see `claude_cli`).
fn edit_json(l: &Location, cwd: &Path, f: impl FnOnce(&mut Map<String, Value>) -> Result<(), String>) -> Result<(), String> {
    let mut root = read_json_file(&l.file)?.unwrap_or_else(|| json!({}));
    if l.format == Format::Paw {
        // Paw's own list is an array of servers.
        let mut map: Map<String, Value> = Map::new();
        for v in root.as_array().cloned().unwrap_or_default() {
            if let Some(n) = v.get("name").and_then(Value::as_str) {
                map.insert(n.to_string(), v.clone());
            }
        }
        f(&mut map)?;
        let list: Vec<Value> = map.into_iter().map(|(_, v)| v).collect();
        return write_file(&l.file, &serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?);
    }
    let key = if l.format == Format::Opencode { "mcp" } else { "mcpServers" };
    let obj = root.as_object_mut().ok_or("The file isn't a JSON object")?;
    let servers = obj.entry(key).or_insert_with(|| json!({}));
    let servers = servers.as_object_mut().ok_or("Its server list isn't a JSON object")?;
    f(servers)?;
    let _ = cwd;
    write_file(&l.file, &(serde_json::to_string_pretty(&root).map_err(|e| e.to_string())? + "\n"))
}

fn edit_codex(path: &Path, f: impl FnOnce(&mut toml_edit::Table) -> Result<(), String>) -> Result<(), String> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let mut doc: toml_edit::DocumentMut = text.parse().map_err(|e| format!("Can't read it: {e}"))?;
    if !doc.contains_key("mcp_servers") {
        let mut t = toml_edit::Table::new();
        t.set_implicit(true);
        doc.insert("mcp_servers", toml_edit::Item::Table(t));
    }
    let table = doc["mcp_servers"].as_table_mut().ok_or("[mcp_servers] isn't a table")?;
    f(table)?;
    write_file(path, &doc.to_string())
}

fn codex_table(s: &McpServer) -> toml_edit::Table {
    use toml_edit::{value, Array, InlineTable};
    let mut t = toml_edit::Table::new();
    if s.transport == "stdio" {
        t["command"] = value(s.command.clone());
        let mut a = Array::new();
        for x in &s.args {
            a.push(x.as_str());
        }
        t["args"] = value(a);
        if !s.env.is_empty() {
            let mut e = InlineTable::new();
            for (k, v) in &s.env {
                e.insert(k, v.as_str().into());
            }
            t["env"] = value(e);
        }
    } else {
        t["url"] = value(s.url.clone());
        if !s.headers.is_empty() {
            let mut h = InlineTable::new();
            for (k, v) in &s.headers {
                h.insert(k, v.as_str().into());
            }
            t["http_headers"] = value(h);
        }
    }
    if !s.enabled {
        t["enabled"] = value(false);
    }
    t
}

/// The agents' own commands Paw uses: `claude mcp add-json/remove` (run in
/// the tab's folder, which local and project scopes belong to) and
/// `copilot mcp list/enable/disable`.
pub trait Clis {
    fn claude(&self, cwd: &Path, args: &[String]) -> Result<(), String>;
    fn claude_installed(&self) -> bool;
    /// `copilot mcp list --json`, or None when Copilot CLI isn't there.
    fn copilot_list(&self, cwd: &Path) -> Option<Value>;
    fn copilot(&self, cwd: &Path, args: &[String]) -> Result<(), String>;
}

fn location(agent: &str, scope: &str, cwd: &Path, home: &Path, config_dir: Option<&Path>) -> Result<Location, String> {
    locations(agent, cwd, home, config_dir)
        .into_iter()
        .find(|l| l.id == scope)
        .ok_or_else(|| format!("{agent} has no MCP scope \"{scope}\""))
}

fn claude_scope(f: Format) -> &'static str {
    match f {
        Format::ClaudeUser => "user",
        Format::ClaudeProject => "project",
        _ => "local",
    }
}

pub struct Ctx<'a> {
    pub agent: &'a str,
    pub cwd: &'a Path,
    pub home: &'a Path,
    pub config_dir: Option<&'a Path>,
    pub clis: &'a dyn Clis,
}

pub fn add(ctx: &Ctx, scope: &str, server: McpServer) -> Result<(), String> {
    check(&server)?;
    let l = location(ctx.agent, scope, ctx.cwd, ctx.home, ctx.config_dir)?;
    if read_location(&l, ctx.cwd)?.iter().any(|s| s.name == server.name) {
        return Err(format!("There's already a server called {} here", server.name));
    }
    match l.format {
        Format::ClaudeUser | Format::ClaudeLocal | Format::ClaudeProject => {
            let entry = to_json(l.format, &server).to_string();
            ctx.clis.claude(
                ctx.cwd,
                &["mcp".into(), "add-json".into(), "--scope".into(), claude_scope(l.format).into(), server.name.clone(), entry],
            )
        }
        Format::Codex => edit_codex(&l.file, |t| {
            t.insert(&server.name, toml_edit::Item::Table(codex_table(&server)));
            Ok(())
        }),
        f => edit_json(&l, ctx.cwd, |m| {
            m.insert(server.name.clone(), to_json(f, &server));
            Ok(())
        }),
    }
}

pub fn remove(ctx: &Ctx, scope: &str, name: &str) -> Result<(), String> {
    let l = location(ctx.agent, scope, ctx.cwd, ctx.home, ctx.config_dir)?;
    if !read_location(&l, ctx.cwd)?.iter().any(|s| s.name == name) {
        return Err(format!("{name} isn't there any more"));
    }
    match l.format {
        Format::ClaudeUser | Format::ClaudeLocal | Format::ClaudeProject => ctx.clis.claude(
            ctx.cwd,
            &["mcp".into(), "remove".into(), "--scope".into(), claude_scope(l.format).into(), name.to_string()],
        ),
        Format::Codex => edit_codex(&l.file, |t| {
            t.remove(name);
            Ok(())
        }),
        _ => edit_json(&l, ctx.cwd, |m| {
            m.shift_remove(name);
            Ok(())
        }),
    }
}

/// Change ~/.claude.json as little and as briefly as possible: re-read it,
/// change one thing, replace the file in one step (permissions and a backup
/// kept), then read it back. Claude Code writes the file too, each running
/// copy under its own lock Paw can't share; if one wrote at the same moment
/// and the change didn't stick, try again.
fn edit_claude_json(home: &Path, change: &dyn Fn(&mut Value) -> bool, holds: &dyn Fn(&Value) -> bool) -> Result<(), String> {
    let path = home.join(".claude.json");
    for _ in 0..3 {
        let text = std::fs::read_to_string(&path).map_err(|e| format!("Can't read ~/.claude.json: {e}"))?;
        let mut root: Value = serde_json::from_str(&text).map_err(|_| "~/.claude.json isn't valid JSON right now; try again".to_string())?;
        if !change(&mut root) {
            return Ok(());
        }
        let mut out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
        if text.ends_with('\n') {
            out.push('\n');
        }
        write_file(&path, &out)?;
        std::thread::sleep(std::time::Duration::from_millis(400));
        let now: Option<Value> = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok());
        if now.as_ref().is_some_and(|v| holds(v)) {
            return Ok(());
        }
    }
    Err("Claude Code kept rewriting ~/.claude.json at the same moment; the change didn't stick. Try again, or use /mcp in Claude Code.".into())
}

/// Add `name` to (or take it from) the string list `key` of a JSON object.
fn set_listed(obj: &mut Value, key: &str, name: &str, present: bool) -> bool {
    if !obj.is_object() {
        *obj = json!({});
    }
    let o = obj.as_object_mut().unwrap();
    let list = o.entry(key).or_insert_with(|| json!([]));
    if !list.is_array() {
        *list = json!([]);
    }
    let a = list.as_array_mut().unwrap();
    let has = a.iter().any(|x| x.as_str() == Some(name));
    match (present, has) {
        (true, false) => a.push(json!(name)),
        (false, true) => a.retain(|x| x.as_str() != Some(name)),
        _ => return false,
    }
    true
}

/// Switch a Claude Code server for this project, as `/mcp enable|disable` would.
fn claude_set_enabled(ctx: &Ctx, format: Format, name: &str, on: bool) -> Result<(), String> {
    let key = claude_project_key(ctx.cwd);
    let project_has = |v: &Value, list: &str| v.get("projects").and_then(|p| p.get(&key)).is_some_and(|p| lists(p, list, name));
    let project_list = |list: &'static str, present: bool| {
        let key = key.clone();
        edit_claude_json(
            ctx.home,
            &|root: &mut Value| {
                let projects = root.as_object_mut().map(|o| o.entry("projects").or_insert_with(|| json!({})));
                let Some(projects) = projects.and_then(Value::as_object_mut) else { return false };
                set_listed(projects.entry(key.clone()).or_insert_with(|| json!({})), list, name, present)
            },
            &|root: &Value| project_has(root, list) == present,
        )
    };
    if format != Format::ClaudeProject {
        // User and local servers: the project entry's `disabledMcpServers`.
        return project_list("disabledMcpServers", !on);
    }
    // Project (.mcp.json) servers: the folder's own settings.local.json.
    let [user, shared, local] = claude_settings_files(ctx.home, ctx.cwd);
    let state = claude_state(ctx.home, ctx.cwd);
    if on {
        if lists(&state.settings[1], "disabledMcpjsonServers", name) {
            return Err(format!("{name} is turned off in the project's shared settings ({}); change it there.", tildify_path(&shared)));
        }
        if lists(&state.settings[0], "disabledMcpjsonServers", name) {
            edit_settings(&user, &|v| set_listed(v, "disabledMcpjsonServers", name, false))?;
        }
        if lists(&state.project, "disabledMcpjsonServers", name) {
            project_list("disabledMcpjsonServers", false)?;
        }
        if state.server_off(name) {
            project_list("disabledMcpServers", false)?;
        }
    }
    edit_settings(&local, &|v| {
        let a = set_listed(v, "disabledMcpjsonServers", name, !on);
        let b = set_listed(v, "enabledMcpjsonServers", name, on);
        a || b
    })
}

/// Change a Claude Code settings file (plain JSON; created when missing).
fn edit_settings(path: &Path, change: &dyn Fn(&mut Value) -> bool) -> Result<(), String> {
    let mut v = read_json_file(path)?.unwrap_or_else(|| json!({}));
    if !change(&mut v) {
        return Ok(());
    }
    write_file(path, &(serde_json::to_string_pretty(&v).map_err(|e| e.to_string())? + "\n"))
}

fn tildify_path(p: &Path) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let s = p.display().to_string();
    match s.strip_prefix(&home) {
        Some(rest) if !home.is_empty() => format!("~{rest}"),
        _ => s,
    }
}

pub fn set_enabled(ctx: &Ctx, scope: &str, name: &str, enabled: bool) -> Result<(), String> {
    if ctx.agent == "copilot" {
        // Any source (built-in, plugin, user, workspace): Copilot persists it.
        let verb = if enabled { "enable" } else { "disable" };
        return ctx.clis.copilot(ctx.cwd, &["mcp".into(), verb.into(), name.into()]);
    }
    let l = location(ctx.agent, scope, ctx.cwd, ctx.home, ctx.config_dir)?;
    if matches!(l.format, Format::ClaudeUser | Format::ClaudeLocal | Format::ClaudeProject) {
        if !read_location(&l, ctx.cwd)?.iter().any(|s| s.name == name) {
            return Err(format!("{name} isn't there any more"));
        }
        return claude_set_enabled(ctx, l.format, name, enabled);
    }
    match l.format {
        Format::Paw | Format::Opencode => edit_json(&l, ctx.cwd, |m| {
            let e = m.get_mut(name).and_then(Value::as_object_mut).ok_or(format!("{name} isn't there any more"))?;
            e.insert("enabled".into(), json!(enabled));
            Ok(())
        }),
        Format::Codex => edit_codex(&l.file, |t| {
            let e = t.get_mut(name).and_then(|i| i.as_table_like_mut()).ok_or(format!("{name} isn't there any more"))?;
            if enabled {
                e.remove("enabled");
            } else {
                e.insert("enabled", toml_edit::value(false));
            }
            Ok(())
        }),
        _ => Err("This agent's config has no on/off switch for a server; remove it instead.".into()),
    }
}

/// Paw Agent's servers that are switched on.
pub fn paw_servers(config_dir: Option<&Path>) -> Vec<McpServer> {
    let home = PathBuf::from("/");
    locations("paw", Path::new("/"), &home, config_dir)
        .first()
        .and_then(|l| read_location(l, Path::new("/")).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|s| s.enabled)
        .collect()
}

/// Split a command line the way a shell would (quotes and backslashes), for
/// the panel's single "command" field.
pub fn split_command(line: &str) -> Result<Vec<String>, String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut have = false;
    let mut chars = line.chars();
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') => cur.extend(chars.next()),
            (Some(_), c) => cur.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                have = true;
            }
            (None, '\\') => {
                cur.extend(chars.next());
                have = true;
            }
            (None, c) if c.is_whitespace() => {
                if have || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    have = false;
                }
            }
            (None, c) => cur.push(c),
        }
    }
    if quote.is_some() {
        return Err("Unclosed quote in the command".into());
    }
    if have || !cur.is_empty() {
        out.push(cur);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Paw Agent's connections
// ---------------------------------------------------------------------------

/// The MCP tools a Paw Agent session offers the model.
#[derive(Clone, Default)]
pub struct McpSetup {
    pub tools: Vec<rig_rmcp::McpTool>,
    /// Model-visible names of tools the server marks read-only: they run
    /// without approval, like `read`.
    pub read_only: std::collections::HashSet<String>,
    /// `server (n tools)` per connected server.
    pub connected: Vec<String>,
    /// `server: why` per server that couldn't be reached.
    pub failed: Vec<String>,
}

impl std::fmt::Debug for McpSetup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpSetup")
            .field("tools", &self.tools.iter().map(|t| t.name().to_string()).collect::<Vec<_>>())
            .field("connected", &self.connected)
            .field("failed", &self.failed)
            .finish()
    }
}

/// A tool name the providers accept (`^[a-zA-Z0-9_-]{1,64}$`): `mcp__server__tool`.
pub fn tool_name(server: &str, tool: &str) -> String {
    let clean = |s: &str| s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect::<String>();
    let mut n = format!("mcp__{}__{}", clean(server), clean(tool));
    n.truncate(64);
    n
}

const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

async fn connect_one(s: &McpServer, cwd: &Path, path_env: Option<&str>) -> Result<Vec<rig_rmcp::McpTool>, String> {
    use rmcp::ServiceExt;
    let service = match s.transport.as_str() {
        "stdio" => {
            let mut cmd = tokio::process::Command::new(&s.command);
            cmd.args(&s.args).current_dir(cwd).envs(&s.env);
            if let Some(p) = path_env {
                cmd.env("PATH", p);
            }
            let (transport, _) = rmcp::transport::TokioChildProcess::builder(cmd)
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|e| format!("couldn't start {}: {e}", s.command))?;
            ().serve(transport).await.map_err(|e| e.to_string())?
        }
        "http" => {
            use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
            let mut config = StreamableHttpClientTransportConfig::with_uri(s.url.clone());
            let mut custom = std::collections::HashMap::new();
            for (k, v) in &s.headers {
                if k.eq_ignore_ascii_case("authorization") {
                    // The transport adds "Bearer " itself.
                    config = config.auth_header(v.strip_prefix("Bearer ").unwrap_or(v).to_string());
                } else {
                    let name = http::HeaderName::from_bytes(k.as_bytes()).map_err(|_| format!("bad header name {k}"))?;
                    let value = http::HeaderValue::from_str(v).map_err(|_| format!("bad value for header {k}"))?;
                    custom.insert(name, value);
                }
            }
            if !custom.is_empty() {
                config = config.custom_headers(custom);
            }
            let transport = rmcp::transport::StreamableHttpClientTransport::from_config(config);
            ().serve(transport).await.map_err(|e| e.to_string())?
        }
        _ => return Err("SSE servers aren't supported by Paw Agent; use the server's streamable HTTP URL".into()),
    };
    let conn = rig_rmcp::McpConnection::new(service);
    let tools = conn.tools().await.map_err(|e| e.to_string())?;
    tools
        .into_iter()
        .map(|t| {
            let name = tool_name(&s.name, t.name());
            let name = rig_core::message::ToolName::try_from(name).map_err(|e| e.to_string())?;
            Ok(t.with_name(name))
        })
        .collect()
}

/// Connect to every server, side by side; a server that fails is reported, not fatal.
pub async fn connect_all(servers: &[McpServer], cwd: &Path, path_env: Option<&str>) -> McpSetup {
    let attempts = servers.iter().map(|s| async move {
        let r = match tokio::time::timeout(CONNECT_TIMEOUT, connect_one(s, cwd, path_env)).await {
            Ok(r) => r,
            Err(_) => Err("no answer within 30 s".into()),
        };
        (s.name.clone(), r)
    });
    let mut setup = McpSetup::default();
    for (name, r) in futures::future::join_all(attempts).await {
        match r {
            Ok(tools) => {
                setup.connected.push(format!("{name} ({} tool{})", tools.len(), if tools.len() == 1 { "" } else { "s" }));
                for t in tools {
                    // name() is the model-visible (namespaced) name.
                    let ro = t.definition().annotations.as_ref().and_then(|a| a.read_only_hint) == Some(true);
                    if ro {
                        setup.read_only.insert(t.name().to_string());
                    }
                    setup.tools.push(t);
                }
            }
            Err(e) => setup.failed.push(format!("{name}: {e}")),
        }
    }
    setup
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

struct SystemClis;

/// Run `<bin> <args…>` through the login shell in `cwd`; stdout on success.
fn run_cli(bin: &str, cwd: &Path, args: &[String]) -> Result<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let line = std::iter::once(bin.to_string())
        .chain(args.iter().map(|a| crate::registry::shell_quote(a)))
        .collect::<Vec<_>>()
        .join(" ");
    let out = std::process::Command::new(shell)
        .args(["-lc", &line])
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let msg = String::from_utf8_lossy(&out.stderr);
        let msg = if msg.trim().is_empty() { String::from_utf8_lossy(&out.stdout) } else { msg };
        Err(format!("{bin} {}: {}", args.first().map(String::as_str).unwrap_or(""), msg.trim()))
    }
}

impl Clis for SystemClis {
    fn claude(&self, cwd: &Path, args: &[String]) -> Result<(), String> {
        run_cli("claude", cwd, args).map(|_| ())
    }
    fn claude_installed(&self) -> bool {
        crate::registry::run_with_env("claude", &["--version"], &[], std::time::Duration::from_secs(10)).is_some()
    }
    fn copilot_list(&self, cwd: &Path) -> Option<Value> {
        crate::registry::run_with_env("copilot", &["--version"], &[], std::time::Duration::from_secs(10))?;
        let out = run_cli("copilot", cwd, &["mcp".into(), "list".into(), "--json".into()]).ok()?;
        serde_json::from_str(&out).ok()
    }
    fn copilot(&self, cwd: &Path, args: &[String]) -> Result<(), String> {
        run_cli("copilot", cwd, args).map(|_| ())
    }
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

#[tauri::command]
pub async fn mcp_list(app: tauri::AppHandle, agent: String, cwd: String) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = crate::agents::expand_home(&cwd);
        let cfg = crate::paths::config_dir(&app);
        report(&agent, &cwd, &home(), cfg.as_deref(), &SystemClis)
    })
    .await
    .map_err(|e| e.to_string())
}

/// What the panel sends to add a server: one command line, env and header lines.
#[derive(Deserialize, Debug)]
pub struct AddInput {
    pub name: String,
    pub transport: String,
    #[serde(default)]
    pub command_line: String,
    #[serde(default)]
    pub url: String,
    /// `KEY=value` lines.
    #[serde(default)]
    pub env: String,
    /// `Header: value` lines.
    #[serde(default)]
    pub headers: String,
}

pub fn parse_input(i: AddInput) -> Result<McpServer, String> {
    let mut s = McpServer { name: i.name.trim().into(), transport: i.transport, url: i.url.trim().into(), enabled: true, ..Default::default() };
    if s.transport == "stdio" {
        let mut parts = split_command(i.command_line.trim())?;
        if parts.is_empty() {
            return Err("A local server needs a command".into());
        }
        s.command = parts.remove(0);
        s.args = parts;
    }
    for line in i.env.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let (k, v) = line.split_once('=').ok_or(format!("Env lines are KEY=value: {line}"))?;
        s.env.insert(k.trim().into(), v.trim().into());
    }
    for line in i.headers.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let (k, v) = line.split_once(':').ok_or(format!("Header lines are Name: value: {line}"))?;
        s.headers.insert(k.trim().into(), v.trim().into());
    }
    Ok(s)
}

fn with_ctx<T>(app: &tauri::AppHandle, agent: &str, cwd: &str, f: impl FnOnce(&Ctx) -> Result<T, String>) -> Result<T, String> {
    let cwd = crate::agents::expand_home(cwd);
    let cfg = crate::paths::config_dir(app);
    let home = home();
    f(&Ctx { agent, cwd: &cwd, home: &home, config_dir: cfg.as_deref(), clis: &SystemClis })
}

#[tauri::command]
pub async fn mcp_add(app: tauri::AppHandle, agent: String, cwd: String, scope: String, server: AddInput) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || with_ctx(&app, &agent, &cwd, |c| add(c, &scope, parse_input(server)?)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mcp_remove(app: tauri::AppHandle, agent: String, cwd: String, scope: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || with_ctx(&app, &agent, &cwd, |c| remove(c, &scope, &name)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mcp_set_enabled(app: tauri::AppHandle, agent: String, cwd: String, scope: String, name: String, enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || with_ctx(&app, &agent, &cwd, |c| set_enabled(c, &scope, &name, enabled)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests;
