//! Paw Agent: Paw's own coding agent, running inside the Paw process on
//! Rig (`rig-agent`'s multi-turn tool loop, `rig-tools`' coding tools).
//!
//! One session per tab. A session is a model (Anthropic, GitHub Copilot,
//! ChatGPT, OpenRouter, Ollama or a provider the user added), a system
//! prompt, the tools (read, write, edit, search, list, shell) working in the
//! tab's folder, and the conversation so far, which is saved after every
//! prompt so a restarted Paw continues it.
//!
//! The session talks to the UI with the same events an agent process uses:
//! `agent:status` (an `AgentInfo`) and `agent:output` lines whose text is a
//! Claude Code stream-json event (`system` init, `assistant` text, thinking
//! and tool_use, `user` tool_result, `result`), so the transcript renders,
//! groups and folds them like Claude Code's. Two events are its own:
//! `paw:delta` (the text the model is writing, as it streams),
//! `paw:approval` (a tool call that waits for the user) and `paw:question`
//! (a factory node's `ask_user`: a question that waits for the user's answer).
//!
//! Tool calls go through a hook that applies the tab's approval level:
//! reading is always allowed; `plan` refuses writes and commands; `edits`
//! allows writes and asks before commands; `ask` asks before both; `auto`
//! lets routine actions run and asks about risky ones (see `auto`); `full`
//! allows everything. Asking pauses the loop on that call until the user
//! decides (Allow once / Always in this folder / Deny).

use crate::agents::{AgentInfo, Status};
use rig_agent::agent::{AgentHook, DispatchAction, DispatchEvent, HookContext, MultiTurnStreamItem};
use rig_agent::streaming::{Item, StreamEvent};
use rig_agent::AgentBuilder;
use rig_core::message::{AssistantContent, Message, ToolResultContent};
use rig_core::operation::Completion;
use rig_core::DynModel;
use rig_tools::process::Launcher;
use rig_tools::workspace::{Local, Workspace};
use rig_tools::{Edit, List, OutputLimit, Read, Search, Seen, Shell, Write};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;

/// Model calls one prompt may make (each tool round is one).
const MAX_TURNS: usize = 60;
/// How long auto mode's reviewer may take before Paw asks the user instead.
const REVIEW_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);
/// Context window asked of Ollama (its own default is small for an agent).
const OLLAMA_NUM_CTX: u32 = 32_768;
/// Project instructions put into the system prompt, at most.
const NOTES_BUDGET: usize = 24_000;

// ---------------------------------------------------------------------------
// Approval policy
// ---------------------------------------------------------------------------

/// What happens to one tool call.
#[derive(Debug, Clone, PartialEq)]
pub enum Gate {
    Allow,
    /// Refused without asking; the model sees the reason.
    Deny(String),
    Ask(Ask),
}

/// A tool call the user has to decide on.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Ask {
    /// What the user sees, e.g. `$ npm test` or `Edit src/main.rs`.
    pub label: String,
    /// What "Always in this folder" allows: `shell(<command>)`, or `edit`
    /// for every file change.
    pub rule: String,
    /// The change or command in full (the card shows it on request).
    pub detail: String,
    /// The rule covers more than this one call.
    pub broad: bool,
    /// Why auto mode stopped to ask (the card says so).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

const PLAN_REFUSAL: &str = "Paw is in plan mode (read-only): changing files and running commands is not allowed. \
Don't try again; describe what you would do instead.";
const USER_DENIED: &str = "The user denied this action. Don't retry it; ask what they would like to do instead.";

/// The kind of action a tool call is, for the approval levels.
fn tool_kind(tool: &str) -> &'static str {
    match tool {
        "read" | "search" | "list" => "read",
        "write" | "edit" | "delete" | "move" => "edit",
        "shell" => "shell",
        _ => "other",
    }
}

fn arg<'a>(args: &'a Value, key: &str) -> &'a str {
    args.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Decide a tool call from the approval level and the rules the user allowed.
pub fn classify(level: &str, tool: &str, args: &Value, rules: &[String]) -> Gate {
    let kind = tool_kind(tool);
    if kind == "read" || level == "full" {
        return Gate::Allow;
    }
    if level == "plan" {
        return Gate::Deny(PLAN_REFUSAL.into());
    }
    if kind == "edit" && level == "edits" {
        return Gate::Allow;
    }
    let ask = match kind {
        "edit" => {
            let path = arg(args, "path");
            let detail = match tool {
                "edit" => args
                    .get("edits")
                    .and_then(Value::as_array)
                    .map(|edits| {
                        edits
                            .iter()
                            .map(|e| {
                                let minus = arg(e, "old_text").lines().map(|l| format!("- {l}")).collect::<Vec<_>>().join("\n");
                                let plus = arg(e, "new_text").lines().map(|l| format!("+ {l}")).collect::<Vec<_>>().join("\n");
                                format!("{minus}\n{plus}")
                            })
                            .collect::<Vec<_>>()
                            .join("\n…\n")
                    })
                    .unwrap_or_default(),
                "write" => arg(args, "content").to_string(),
                _ => serde_json::to_string_pretty(args).unwrap_or_default(),
            };
            let verb = match tool {
                "edit" => "Edit",
                "write" => "Write",
                "delete" => "Delete",
                _ => "Move",
            };
            Ask { label: format!("{verb} {path}").trim().to_string(), rule: "edit".into(), detail: clip(&detail, 20_000), broad: true, why: None }
        }
        "shell" => {
            let command = arg(args, "command").trim();
            Ask { label: format!("$ {command}"), rule: format!("shell({command})"), detail: command.to_string(), broad: false, why: None }
        }
        _ => Ask {
            // mcp__server__tool reads "server › tool".
            label: match tool.strip_prefix("mcp__").and_then(|t| t.split_once("__")) {
                Some((server, name)) => format!("{server} › {name}"),
                None => tool.to_string(),
            },
            rule: tool.to_string(),
            detail: serde_json::to_string_pretty(args).unwrap_or_default(),
            broad: true,
            why: None,
        },
    };
    if rules.iter().any(|r| *r == ask.rule) {
        return Gate::Allow;
    }
    Gate::Ask(ask)
}

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… ({} more bytes)", &s[..end], s.len() - end)
}

// ---------------------------------------------------------------------------
// Events to the UI
// ---------------------------------------------------------------------------

/// A tool call waiting for the user's decision.
#[derive(Debug, Clone, Serialize)]
pub struct ApprovalRequest {
    /// The session (the tab's process id).
    pub id: u32,
    pub request: u64,
    pub tool: String,
    #[serde(flatten)]
    pub ask: Ask,
}

/// A question a factory node asks the user (its `ask_user` tool).
#[derive(Debug, Clone, Serialize)]
pub struct QuestionRequest {
    /// The session (the node's agent).
    pub id: u32,
    pub request: u64,
    pub question: String,
    /// Answers to pick from, if the agent offered some (the user may still write another).
    pub choices: Vec<String>,
}

/// The tool a factory node asks the user with.
pub const ASK_TOOL: &str = "ask_user";
/// Paw Agent's factory tools (tabs, not factory nodes): start a run, see how
/// runs are doing, pass the user's answer or decision on to a node.
pub const RUN_FACTORY: &str = "run_factory";
pub const FACTORY_STATUS: &str = "factory_status";
pub const FACTORY_REPLY: &str = "reply_to_factory";

/// Where a session's events go: the webview, or a test.
pub trait Sink: Send + Sync + 'static {
    /// An `agent:output` line ("stdout" lines carry stream-json events).
    fn line(&self, id: u32, stream: &'static str, text: String);
    /// The assistant text written so far in the current part ("" clears it).
    fn delta(&self, id: u32, text: &str);
    fn approval(&self, req: &ApprovalRequest);
    /// The sandbox stopped something (a program not on its list, a file outside its folders).
    fn sandbox_blocked(&self, _event: &Value) {}
    fn status(&self, info: &AgentInfo);
    /// A question for the user (factory nodes only).
    fn question(&self, _q: &QuestionRequest) {}
}

pub struct TauriSink {
    app: tauri::AppHandle,
    seq: Mutex<HashMap<u32, u64>>,
}

impl Sink for TauriSink {
    fn line(&self, id: u32, stream: &'static str, text: String) {
        use tauri::Emitter;
        let seq = {
            let mut m = self.seq.lock().unwrap();
            let s = m.entry(id).or_insert(0);
            *s += 1;
            *s
        };
        let _ = self.app.emit("agent:output", crate::agents::OutputLine { id, seq, stream, text, ts: now_ms() });
    }
    fn delta(&self, id: u32, text: &str) {
        use tauri::Emitter;
        let _ = self.app.emit("paw:delta", json!({ "id": id, "text": text }));
    }
    fn approval(&self, req: &ApprovalRequest) {
        use tauri::Emitter;
        let _ = self.app.emit("paw:approval", req);
    }
    fn status(&self, info: &AgentInfo) {
        use tauri::Emitter;
        let _ = self.app.emit("agent:status", info);
    }
    fn question(&self, q: &QuestionRequest) {
        use tauri::Emitter;
        let _ = self.app.emit("paw:question", q);
    }
    fn sandbox_blocked(&self, event: &Value) {
        use tauri::Emitter;
        let _ = self.app.emit("paw:sandbox", event);
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A new conversation id: hex, shaped like a UUID (the UI looks for one).
fn new_conversation_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    static N: AtomicU64 = AtomicU64::new(0);
    let mut parts = [0u64; 2];
    for (i, p) in parts.iter_mut().enumerate() {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        h.write_u64(N.fetch_add(1, Ordering::Relaxed) + i as u64);
        h.write_u32(std::process::id());
        *p = h.finish();
    }
    let hex = format!("{:016x}{:016x}", parts[0], parts[1]);
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// A stream-json line with `type` and `subtype` first, as Claude Code prints
/// them (the UI matches the start of the line).
fn event(v: Value) -> String {
    let Value::Object(mut m) = v else { return v.to_string() };
    let mut parts = Vec::with_capacity(m.len());
    for key in ["type", "subtype"] {
        if let Some(x) = m.remove(key) {
            parts.push(format!("{}:{}", Value::from(key), x));
        }
    }
    parts.extend(m.into_iter().map(|(k, x)| format!("{}:{}", Value::from(k), x)));
    format!("{{{}}}", parts.join(","))
}

fn tool_use_event(call_id: &str, name: &str, input: Value) -> String {
    event(json!({
        "type": "assistant",
        "message": { "role": "assistant", "content": [{ "type": "tool_use", "id": call_id, "name": name, "input": input }] }
    }))
}

fn text_event(text: &str) -> String {
    event(json!({ "type": "assistant", "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] } }))
}

fn thinking_event(text: &str) -> String {
    event(json!({ "type": "assistant", "message": { "role": "assistant", "content": [{ "type": "thinking", "thinking": text }] } }))
}

fn tool_result_event(call_id: &str, text: &str, is_error: bool) -> String {
    event(json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": call_id, "content": text, "is_error": is_error }] }
    }))
}

fn tool_result_text(content: &[ToolResultContent]) -> String {
    content
        .iter()
        .map(|c| match c {
            ToolResultContent::Text(t) => t.text.clone(),
            ToolResultContent::Image(_) => "[image]".to_string(),
            ToolResultContent::Json { value } => value.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/// Everything a session is started with.
#[derive(Clone, Debug)]
pub struct SessionConfig {
    pub name: String,
    /// "ollama" or "anthropic".
    pub provider: String,
    pub model: String,
    pub cwd: PathBuf,
    /// "ask", "edits", "auto", "plan" or "full".
    pub approval: String,
    /// Rules the user allowed for this folder ("edit", "shell(<command>)").
    pub allow_rules: Vec<String>,
    pub preamble: String,
    /// The conversation's id (the tab keeps it to continue after a restart).
    pub conversation: String,
    /// Where the conversation is saved.
    pub history_path: Option<PathBuf>,
    /// Whether the model can call tools (some Ollama models can't).
    pub tools: bool,
    /// PATH for shell commands (the login shell's).
    pub path_env: Option<String>,
    /// Tools of the MCP servers Paw Agent connected to.
    pub mcp: crate::mcp::McpSetup,
    /// The session's `scripts/` folder: helper scripts that aren't part of
    /// the project go there (auto mode treats it like the working folder).
    pub scripts: Option<PathBuf>,
    /// Only these built-in tools (a factory node can narrow them); None: all.
    pub tool_names: Option<Vec<String>>,
    /// It may ask the user (`ask_user`): a factory node, which has no tab to talk in.
    pub ask: bool,
    /// A folder as fine to change as `cwd` in auto mode (a factory run's shared files).
    pub shared: Option<PathBuf>,
    /// Its sandbox, when it has one (the session's own copy changes as the user allows more).
    pub sandbox: Option<sandbox::Policy>,
}

impl SessionConfig {
    /// Does the session have this built-in tool?
    pub fn has_tool(&self, name: &str) -> bool {
        self.tools && self.tool_names.as_ref().map_or(true, |t| t.iter().any(|x| x == name))
    }
}

pub struct Session {
    pub id: u32,
    cfg: SessionConfig,
    model: DynModel<Completion>,
    level: Mutex<String>,
    rules: Mutex<Vec<String>>,
    /// The prompt being worked on (auto mode's reviewer sees it).
    request: Mutex<String>,
    history: Mutex<Vec<Message>>,
    /// Terminal output shared since the last prompt; it goes in front of the next one.
    notes: Mutex<Vec<String>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<bool>>>,
    /// Questions (`ask_user`) waiting for the user's answer.
    questions: Mutex<HashMap<u64, oneshot::Sender<String>>>,
    /// The sandbox as it is now (the user may allow more programs in this tab).
    sandbox: Mutex<Option<sandbox::Policy>>,
    /// Present while a prompt runs; sending (or dropping) it stops the turn.
    cancel: Mutex<Option<oneshot::Sender<()>>>,
    seen: Seen,
    sink: Arc<dyn Sink>,
    info: Mutex<AgentInfo>,
    closed: AtomicBool,
}

static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Deserialize)]
struct SavedConversation {
    version: u32,
    provider: String,
    model: String,
    cwd: String,
    messages: Vec<Message>,
    /// Shared terminal output the agent hasn't seen yet.
    #[serde(default)]
    notes: Vec<String>,
}

fn load_history(path: &Path) -> (Vec<Message>, Vec<String>) {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<SavedConversation>(&t).ok())
        .map(|c| (c.messages, c.notes))
        .unwrap_or_default()
}

/// The prompt as a user message, with shared terminal output in front of it.
fn prompt_message(notes: &[String], prompt: &str) -> Message {
    if notes.is_empty() {
        return Message::user(prompt);
    }
    use rig_core::message::UserContent;
    Message::User { content: vec![UserContent::text(notes.join("\n\n")), UserContent::text(prompt)] }
}

impl Session {
    /// Its process info (the daemon reports it to a window that comes back).
    pub fn info(&self) -> AgentInfo {
        self.info.lock().unwrap().clone()
    }

    /// Working on a prompt.
    pub fn working(&self) -> bool {
        self.cancel.lock().unwrap().is_some()
    }

    #[cfg(test)]
    pub fn busy(&self) -> bool {
        self.cancel.lock().unwrap().is_some()
    }

    #[cfg(test)]
    pub fn conversation(&self) -> &str {
        &self.cfg.conversation
    }

    pub fn history_len(&self) -> usize {
        self.history.lock().unwrap().len()
    }

    fn save(&self) {
        let Some(path) = &self.cfg.history_path else { return };
        let saved = SavedConversation {
            version: 1,
            provider: self.cfg.provider.clone(),
            model: self.cfg.model.clone(),
            cwd: self.cfg.cwd.display().to_string(),
            messages: self.history.lock().unwrap().clone(),
            notes: self.notes.lock().unwrap().clone(),
        };
        let Ok(bytes) = serde_json::to_vec(&saved) else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }

    fn set_status(&self, status: Status) {
        let info = {
            let mut i = self.info.lock().unwrap();
            i.status = status;
            if status != Status::Running {
                i.ended_at = Some(now_ms());
            }
            i.clone()
        };
        self.sink.status(&info);
    }

    /// Ask the user about a tool call; resolves when they decide (false:
    /// denied, or the turn ended first).
    async fn ask(&self, tool: &str, ask: Ask) -> bool {
        let request = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(request, tx);
        self.sink.approval(&ApprovalRequest { id: self.id, request, tool: tool.to_string(), ask });
        rx.await.unwrap_or(false)
    }

    /// Ask the user a question (`ask_user`); their answer, or None when the
    /// turn ended first.
    async fn ask_user(&self, question: String, choices: Vec<String>) -> Option<String> {
        let request = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.questions.lock().unwrap().insert(request, tx);
        self.sink.question(&QuestionRequest { id: self.id, request, question, choices });
        rx.await.ok()
    }

    /// Auto mode's reviewer: one short call to the tab's model about an
    /// action the rules couldn't decide. `None` allows it; otherwise the
    /// reason to ask the user.
    async fn review(&self, ask: &Ask) -> Option<String> {
        use futures::StreamExt;
        let request = self.request.lock().unwrap().clone();
        let preamble = auto::REVIEWER.replace("{cwd}", &self.cfg.cwd.display().to_string());
        let mut b = AgentBuilder::new(self.model.clone()).name("Paw auto review").preamble(preamble);
        // Copilot, ChatGPT, OpenRouter and added providers take each model's own reply budget.
        match self.cfg.provider.as_str() {
            "anthropic" => b = b.max_tokens(400),
            "ollama" => {
                use rig_core::providers::ollama::extension::{KeepAlive, OllamaOptions};
                b = b.provider_option(OllamaOptions::default().num_ctx(OLLAMA_NUM_CTX).keep_alive(KeepAlive::duration("30m")));
            }
            _ => {}
        }
        let agent = b.build();
        let question = auto::review_prompt(&request, &ask.label, &ask.detail);
        let run = async {
            let mut stream = agent.prompt(question).max_turns(1).stream();
            while let Some(item) = stream.next().await {
                match item {
                    Ok(MultiTurnStreamItem::FinalResponse(r)) => return Some(r.output()),
                    Err(_) => return None,
                    _ => {}
                }
            }
            None
        };
        match tokio::time::timeout(REVIEW_TIMEOUT, run).await {
            Ok(Some(answer)) => auto::parse_review(&answer),
            _ => Some("Paw couldn't check this action".into()),
        }
    }

    fn tools_agent(self: &Arc<Self>) -> rig_agent::Agent {
        let mut b = AgentBuilder::new(self.model.clone()).name("Paw Agent").preamble(self.cfg.preamble.clone());
        match self.cfg.provider.as_str() {
            "anthropic" => b = b.max_tokens(16_000),
            "ollama" => {
                use rig_core::providers::ollama::extension::{KeepAlive, OllamaOptions};
                b = b.provider_option(OllamaOptions::default().num_ctx(OLLAMA_NUM_CTX).keep_alive(KeepAlive::duration("30m")));
            }
            _ => {}
        }
        if self.cfg.tools {
            let ws: Arc<dyn Workspace> = Arc::new(Local);
            let base = Some(self.cfg.cwd.clone());
            let mut launcher = Launcher::default()
                .in_dir(self.cfg.cwd.clone())
                .with_env("TERM", "dumb")
                .with_env("NO_COLOR", "1")
                .with_env("PAGER", "cat")
                .with_env("GIT_PAGER", "cat");
            if let Some(p) = &self.cfg.path_env {
                launcher = launcher.with_env("PATH", p.clone());
            }
            // In a sandbox, every command runs under macOS's sandbox with the
            // profile written for it just before it runs (see the gate below).
            if let Some(p) = self.sandbox.lock().unwrap().clone() {
                let path = self.sandbox_profile_path();
                let _ = std::fs::write(&path, sandbox::profile(&p, &self.sandbox_roots(&p), p.network == "on"));
                launcher = launcher.wrapped([std::ffi::OsString::from("/usr/bin/sandbox-exec"), std::ffi::OsString::from("-f"), path.into_os_string()]);
            }
            // A factory node may have only some of the built-in tools.
            let has = |t: &str| self.cfg.has_tool(t);
            if has("read") {
                b = b.tool(Read { workspace: ws.clone(), base: base.clone(), confine: false, seen: self.seen.clone() });
            }
            if has("edit") {
                b = b.tool(Edit { workspace: ws.clone(), base: base.clone(), confine: false, seen: self.seen.clone() });
            }
            if has("write") {
                b = b.tool(Write { workspace: ws.clone(), base: base.clone(), confine: false, seen: self.seen.clone() });
            }
            if has("search") {
                b = b.tool(Search { workspace: ws.clone(), base: base.clone(), confine: false });
            }
            if has("list") {
                b = b.tool(List { workspace: ws.clone(), base, confine: false });
            }
            if has("shell") {
                b = b.tool(Shell { workspace: ws, launcher, live: None, spill: None, cut: Some(OutputLimit::default()), confine: false });
            }
            b = b.add_hook(GateHook { sess: self.clone() });
            let mut mcp: Vec<rig_core::tool::DynamicTool> =
                self.cfg.mcp.tools.iter().cloned().filter_map(|t| rig_core::tool::DynamicTool::try_from(t).ok()).collect();
            if self.cfg.ask {
                mcp.push(self.ask_tool());
            } else if crate::factories::runner::global().is_some() {
                mcp.extend(self.factory_tools());
            }
            if !mcp.is_empty() {
                b = b.dynamic_tools(mcp);
            }
        }
        b.build()
    }
}

/// Where a run asked for in a chat works: the folder named, else the tab's
/// (unless that's just the home folder: then the factory's own).
fn factory_folder(cwd: &Path, given: &str) -> Option<String> {
    let given = given.trim();
    if !given.is_empty() {
        return Some(given.to_string());
    }
    let home = std::env::var("HOME").map(PathBuf::from).ok();
    (home.as_deref() != Some(cwd)).then(|| cwd.display().to_string())
}

impl Session {
    /// The folders its sandbox lets it write.
    fn sandbox_roots(&self, p: &sandbox::Policy) -> Vec<PathBuf> {
        let also: Vec<PathBuf> = self.cfg.scripts.iter().cloned().chain(self.cfg.shared.clone()).collect();
        sandbox::roots(p, &self.cfg.cwd, &also)
    }

    fn sandbox_profile_path(&self) -> PathBuf {
        sandbox::profile_path(self.cfg.scripts.as_deref().and_then(Path::parent), self.id)
    }

    /// The sandbox's word on a tool call: None lets it go on (a command's
    /// profile written for it), Some(reason) stops it (and tells the window).
    fn sandbox_gate(&self, tool: &str, args: &Value) -> Option<String> {
        let p = self.sandbox.lock().unwrap().clone()?;
        let blocked = |what: Value, reason: String| {
            let mut ev = json!({ "id": self.id, "reason": reason });
            if let (Value::Object(m), Value::Object(w)) = (&mut ev, what) {
                m.extend(w);
            }
            self.sink.sandbox_blocked(&ev);
            Some(reason)
        };
        match tool {
            "shell" => {
                let line = arg(args, "command");
                match sandbox::check(&p, line) {
                    sandbox::Verdict::Blocked { program } => blocked(
                        json!({ "program": program, "command": line }),
                        format!("Blocked by the sandbox: `{program}` isn't on the list of programs this session may run. Tell the user it's needed and why, so they can allow it; don't try to get around it."),
                    ),
                    sandbox::Verdict::Run { network } => {
                        let _ = std::fs::write(self.sandbox_profile_path(), sandbox::profile(&p, &self.sandbox_roots(&p), network));
                        None
                    }
                }
            }
            "write" | "edit" | "delete" | "move" => {
                let roots = self.sandbox_roots(&p);
                let path = |k: &str| {
                    let v = arg(args, k);
                    (!v.is_empty()).then(|| if Path::new(v).is_absolute() { PathBuf::from(v) } else { self.cfg.cwd.join(v) })
                };
                let outside = ["path", "from", "to", "destination"].iter().filter_map(|k| path(k)).find(|p| !sandbox::may_write(&roots, p))?;
                blocked(
                    json!({ "path": outside.display().to_string() }),
                    format!("Blocked by the sandbox: {} is outside the folders this session may change. Tell the user, so they can allow the folder (Settings › Sandbox); don't try to get around it.", outside.display()),
                )
            }
            _ => None,
        }
    }

    /// run_factory, factory_status and reply_to_factory.
    fn factory_tools(self: &Arc<Self>) -> Vec<rig_core::tool::DynamicTool> {
        use rig_core::tool::{DynamicTool, ToolExecutionError, ToolOutput};
        let name = |n: &str| rig_core::message::ToolName::new(n).expect("a name");
        let dir = crate::factories::runner::factories_dir();
        let list = dir
            .as_deref()
            .map(crate::factories::load_all)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|f| f.factory.map(|d| format!("- {} (“{}”): {}", f.id, d.name, d.description.trim())))
            .collect::<Vec<_>>();
        let list = if list.is_empty() { "There are no factories yet.".to_string() } else { format!("The factories:\n{}", list.join("\n")) };
        let fail = |e: String| ToolExecutionError::other(e);

        let me = self.clone();
        let run = DynamicTool::new_with_context(
            name(RUN_FACTORY),
            format!(
                "Start a run of one of the user's Paw factories (pipelines of agents that run in the background) when the user asks you to. \
                 The task is what the run is for, in the user's words (every node gets it). The run works in `folder`; leave it out to use \
                 this tab's folder. The user confirms before it starts. It returns the run's execution id; the run goes on without you, \
                 so don't wait for it: say it started, and use {FACTORY_STATUS} when the user asks how it's going.\n{list}"
            ),
            json!({
                "type": "object",
                "properties": {
                    "factory": { "type": "string", "description": "The factory's id (or name)." },
                    "task": { "type": "string", "description": "What this run is for, in the user's words." },
                    "folder": { "type": "string", "description": "The project folder the run works in (default: this tab's folder)." }
                },
                "required": ["factory"]
            }),
            move |_ctx, args| {
                let me = me.clone();
                Box::pin(async move {
                    let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
                    let runner = crate::factories::runner::global().ok_or_else(|| fail("Factories run in Paw's background process, which isn't reachable here.".into()))?;
                    let dir = crate::factories::runner::factories_dir().ok_or_else(|| fail("Paw can't find its folder.".into()))?;
                    let (id, def) = crate::factories::find(&dir, &s("factory")).map_err(fail)?;
                    let folder = factory_folder(&me.cfg.cwd, &s("folder"));
                    let task = Some(s("task")).filter(|t| !t.is_empty());
                    let rid = runner.start(&id, "chat", task, folder.clone()).map_err(fail)?;
                    let shown = folder.unwrap_or_else(|| if def.folder.trim().is_empty() { "~".into() } else { def.folder.trim().to_string() });
                    me.sink.line(me.id, "stdout", event(json!({ "type": "paw", "subtype": "factory_run", "factory": id, "name": def.name, "run": rid, "folder": shown })));
                    Ok(ToolOutput::text(format!(
                        "Started run {rid} of “{}” ({id}) in {shown}. It runs in the background; the user can watch it in the factory's view. \
                         Nodes that need the user (a question, an approval) notify them.",
                        def.name
                    )))
                })
            },
        );

        let status = DynamicTool::new_with_context(
            name(FACTORY_STATUS),
            format!(
                "How the user's factory runs are doing: their state, the node at work, and anything waiting for the user (a question, \
                 an answer to approve) with its run and node ids. With a run id: that run; with a factory: its runs going (or its last one); \
                 with neither: every run going.\n{list}"
            ),
            json!({
                "type": "object",
                "properties": {
                    "factory": { "type": "string", "description": "A factory's id (or name)." },
                    "run": { "type": "string", "description": "A run's execution id (or its first characters)." }
                }
            }),
            move |_ctx, args| {
                Box::pin(async move {
                    let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
                    let runner = crate::factories::runner::global().ok_or_else(|| fail("Factories run in Paw's background process, which isn't reachable here.".into()))?;
                    let factory = match s("factory") {
                        f if f.is_empty() => None,
                        f => {
                            let dir = crate::factories::runner::factories_dir().ok_or_else(|| fail("Paw can't find its folder.".into()))?;
                            Some(crate::factories::find(&dir, &f).map_err(fail)?.0)
                        }
                    };
                    let run = Some(s("run")).filter(|r| !r.is_empty());
                    Ok(ToolOutput::text(runner.status_text(factory.as_deref(), run.as_deref())))
                })
            },
        );

        let reply = DynamicTool::new_with_context(
            name(FACTORY_REPLY),
            "Pass the user's reply on to a factory node that waits for them (factory_status shows which): the answer to its question, \
             or their decision on an answer waiting for approval (approve true or false, with text: the answer as they want it passed on, \
             or why they reject it). Only pass on what the user said in this chat; never answer, approve or reject on your own.",
            json!({
                "type": "object",
                "properties": {
                    "run": { "type": "string", "description": "The run's execution id." },
                    "node": { "type": "string", "description": "The node's id." },
                    "answer": { "type": "string", "description": "The user's answer to the node's question." },
                    "approve": { "type": "boolean", "description": "For an answer waiting for approval: the user approves (true) or rejects (false) it." },
                    "text": { "type": "string", "description": "With approve: the answer as the user changed it, or why they reject it." }
                },
                "required": ["run", "node"]
            }),
            move |_ctx, args| {
                Box::pin(async move {
                    let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
                    let runner = crate::factories::runner::global().ok_or_else(|| fail("Factories run in Paw's background process, which isn't reachable here.".into()))?;
                    let (run, node) = (s("run"), s("node"));
                    let run = runner.full_run_id(&run).ok_or_else(|| fail(format!("There's no run {run}.")))?;
                    if let Some(approve) = args.get("approve").and_then(Value::as_bool) {
                        runner.decide(&run, &node, approve, Some(s("text")).filter(|t| !t.is_empty())).map_err(fail)?;
                        return Ok(ToolOutput::text(if approve { "Approved; the run goes on." } else { "Rejected; the node goes back for another round, or the run stops." }));
                    }
                    runner.answer(&run, &node, &s("answer")).map_err(fail)?;
                    Ok(ToolOutput::text("Passed on; the node goes on with it."))
                })
            },
        );
        vec![run, status, reply]
    }

    /// `ask_user`: a question that waits for the user's answer.
    fn ask_tool(self: &Arc<Self>) -> rig_core::tool::DynamicTool {
        use rig_core::tool::{DynamicTool, ToolExecutionError, ToolOutput};
        let me = self.clone();
        let schema = json!({
            "type": "object",
            "properties": {
                "question": { "type": "string", "description": "The question, complete enough to answer without other context: what you need, and why." },
                "choices": { "type": "array", "items": { "type": "string" }, "description": "Answers to pick from, when there are a few clear options (the user may still write another)." }
            },
            "required": ["question"]
        });
        DynamicTool::new_with_context(
            rig_core::message::ToolName::new(ASK_TOOL).expect("a name"),
            "Ask the user a question and wait for the answer. Use it when you need a decision, an approval or information only the user has \
             (which project, whether a plan is right, which review comments to act on). Don't guess, and don't wait for files or poll: ask. \
             The answer comes back as this tool's result; it may take a while.",
            schema,
            move |_ctx, args| {
                let me = me.clone();
                Box::pin(async move {
                    let question = args.get("question").and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
                    if question.is_empty() {
                        return Err(ToolExecutionError::invalid_args("Give the question."));
                    }
                    let choices: Vec<String> = args
                        .get("choices")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(Value::as_str).map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).take(8).collect())
                        .unwrap_or_default();
                    match me.ask_user(question, choices).await {
                        Some(answer) => Ok(ToolOutput::text(format!("The user answered:\n{answer}"))),
                        None => Err(ToolExecutionError::cancelled("The question wasn't answered: the request ended first.")),
                    }
                })
            },
        )
    }
}

/// Applies the approval level to every tool call; pauses on the ones the
/// user has to decide.
struct GateHook {
    sess: Arc<Session>,
}

impl AgentHook for GateHook {
    fn name(&self) -> Option<String> {
        Some("paw-approvals".into())
    }

    async fn on_dispatch(&self, _ctx: &HookContext, ev: DispatchEvent<'_>) -> DispatchAction {
        let Some(tool) = ev.tool_name().map(str::to_string) else { return DispatchAction::proceed() };
        // Asking the user changes nothing.
        if tool == ASK_TOOL && self.sess.cfg.ask {
            return DispatchAction::proceed();
        }
        let args: Value = ev.tool_args().and_then(|a| serde_json::from_str(a).ok()).unwrap_or(Value::Null);
        // The sandbox first: no use asking about something it won't let run.
        if let Some(reason) = self.sess.sandbox_gate(&tool, &args) {
            return DispatchAction::skip(reason);
        }
        // The factory tools: reading how runs go, and passing on what the user said, need no approval.
        if (tool == FACTORY_STATUS || tool == FACTORY_REPLY) && !self.sess.cfg.ask {
            return DispatchAction::proceed();
        }
        // Starting a run can do a lot (push code, open pull requests): the user confirms it.
        if tool == RUN_FACTORY && !self.sess.cfg.ask {
            let level = self.sess.level.lock().unwrap().clone();
            if level == "plan" {
                return DispatchAction::skip(PLAN_REFUSAL);
            }
            let which = arg(&args, "factory").to_string();
            let found = crate::factories::runner::factories_dir().and_then(|d| crate::factories::find(&d, &which).ok());
            let Some((id, def)) = found else { return DispatchAction::proceed() }; // the tool says what's wrong
            let rule = format!("factory({id})");
            if level == "full" || self.sess.rules.lock().unwrap().contains(&rule) {
                return DispatchAction::proceed();
            }
            let folder = factory_folder(&self.sess.cfg.cwd, arg(&args, "folder"))
                .unwrap_or_else(|| if def.folder.trim().is_empty() { "~".into() } else { def.folder.trim().to_string() });
            let task = arg(&args, "task").trim();
            let ask = Ask {
                label: format!("Start the factory “{}” in {folder}", def.name),
                rule,
                detail: if task.is_empty() { "(no task)".into() } else { task.to_string() },
                broad: false,
                why: None,
            };
            return if self.sess.ask(&tool, ask).await { DispatchAction::proceed() } else { DispatchAction::skip(USER_DENIED) };
        }
        // MCP tools their server marks read-only run like `read`.
        if self.sess.cfg.mcp.read_only.contains(&tool) {
            return DispatchAction::proceed();
        }
        let gate = {
            let level = self.sess.level.lock().unwrap().clone();
            let rules = self.sess.rules.lock().unwrap();
            classify(&level, &tool, &args, &rules)
        };
        let auto = *self.sess.level.lock().unwrap() == "auto";
        let gate = match gate {
            Gate::Ask(mut ask) if auto => match auto::check_in(&tool, &args, &self.sess.cfg.cwd, &self.sess.cfg.scripts.iter().chain(&self.sess.cfg.shared).map(PathBuf::as_path).collect::<Vec<_>>()) {
                auto::Check::Allow => Gate::Allow,
                auto::Check::Ask(why) => {
                    ask.why = Some(why);
                    Gate::Ask(ask)
                }
                auto::Check::Review => match self.sess.review(&ask).await {
                    None => Gate::Allow,
                    Some(why) => {
                        ask.why = Some(why);
                        Gate::Ask(ask)
                    }
                },
            },
            g => g,
        };
        match gate {
            Gate::Allow => DispatchAction::proceed(),
            Gate::Deny(reason) => DispatchAction::skip(reason),
            Gate::Ask(ask) => {
                if self.sess.ask(&tool, ask).await {
                    DispatchAction::proceed()
                } else {
                    DispatchAction::skip(USER_DENIED)
                }
            }
        }
    }
}

/// What the stream of one prompt has shown so far.
#[derive(Default)]
struct TurnState {
    text: String,
    calls_shown: std::collections::HashSet<String>,
    model_calls: usize,
    input_tokens: u64,
    output_tokens: u64,
}

enum Outcome {
    Done(rig_agent::agent::PromptResponse),
    Failed(String),
    Cancelled,
    Ended,
}

impl TurnState {
    fn flush_text(&mut self, sess: &Session) {
        let t = std::mem::take(&mut self.text);
        // Clear the live preview first, so the finished text never shows twice.
        sess.sink.delta(sess.id, "");
        if !t.trim().is_empty() {
            sess.sink.line(sess.id, "stdout", text_event(t.trim()));
        }
    }

    fn show_call(&mut self, sess: &Session, call: &rig_core::message::ToolCall) {
        let id = call.id.to_string();
        if self.calls_shown.insert(id.clone()) {
            self.flush_text(sess);
            sess.sink.line(sess.id, "stdout", tool_use_event(&id, &call.function.name, Value::Object(call.function.arguments.clone())));
        }
    }

    /// Show one stream item; the final response ends the prompt.
    fn handle(&mut self, sess: &Session, item: MultiTurnStreamItem) -> Option<rig_agent::agent::PromptResponse> {
        match item {
            MultiTurnStreamItem::StreamAssistantItem(Item::Event(ev)) => match ev {
                StreamEvent::Text { text, .. } => {
                    self.text.push_str(&text);
                    sess.sink.delta(sess.id, &self.text);
                }
                StreamEvent::End { content, .. } => match content {
                    AssistantContent::Text(t) => {
                        // The finished part is the authoritative text.
                        self.text = t.text;
                        self.flush_text(sess);
                    }
                    AssistantContent::Reasoning(r) if !r.text.trim().is_empty() => {
                        sess.sink.line(sess.id, "stdout", thinking_event(&r.text));
                    }
                    AssistantContent::ToolCall(call) => self.show_call(sess, &call),
                    _ => {}
                },
                _ => {}
            },
            MultiTurnStreamItem::ToolCall { tool_call } => self.show_call(sess, &tool_call),
            MultiTurnStreamItem::ToolResult { tool_result } => {
                let text = tool_result_text(&tool_result.content);
                sess.sink.line(sess.id, "stdout", tool_result_event(&tool_result.call.to_string(), &text, tool_result.is_error));
            }
            MultiTurnStreamItem::CompletionCall(call) => {
                self.model_calls += 1;
                self.input_tokens += call.usage.input_tokens.unwrap_or(0);
                self.output_tokens += call.usage.output_tokens.unwrap_or(0);
                // The running total, for the live count in the tab's working line.
                sess.sink.line(
                    sess.id,
                    "stdout",
                    event(json!({
                        "type": "progress",
                        "subtype": "usage",
                        "model_calls": self.model_calls,
                        "usage": { "input_tokens": self.input_tokens, "output_tokens": self.output_tokens },
                    })),
                );
            }
            MultiTurnStreamItem::ModelTurnRetried { .. } => {
                self.text.clear();
                sess.sink.delta(sess.id, "");
            }
            MultiTurnStreamItem::FinalResponse(resp) => return Some(resp),
            _ => {}
        }
        None
    }
}

/// Run one prompt to its end (or until it's stopped).
async fn run_turn(sess: Arc<Session>, prompt: String, mut cancel: oneshot::Receiver<()>) {
    use futures::StreamExt;
    let started = Instant::now();
    let history = sess.history.lock().unwrap().clone();
    // Terminal output shared since the last prompt goes along with this one.
    let notes = std::mem::take(&mut *sess.notes.lock().unwrap());
    *sess.request.lock().unwrap() = prompt.clone();
    let message = prompt_message(&notes, &prompt);
    let agent = sess.tools_agent();
    let mut stream = agent.prompt(message.clone()).history(history).max_turns(MAX_TURNS).stream();
    let mut st = TurnState::default();
    let outcome = loop {
        tokio::select! {
            _ = &mut cancel => break Outcome::Cancelled,
            item = stream.next() => match item {
                None => break Outcome::Ended,
                Some(Ok(item)) => if let Some(resp) = st.handle(&sess, item) { break Outcome::Done(resp) },
                Some(Err(e)) => break Outcome::Failed(e.to_string()),
            }
        }
    };
    // Dropping the stream ends whatever it was doing (a request, a command).
    drop(stream);
    // Approvals and questions still open belong to this turn.
    sess.pending.lock().unwrap().clear();
    sess.questions.lock().unwrap().clear();
    if !matches!(outcome, Outcome::Done(_)) {
        st.flush_text(&sess);
    }
    let (is_error, note) = match &outcome {
        Outcome::Done(resp) => {
            sess.history.lock().unwrap().extend(resp.messages().iter().cloned());
            (false, None)
        }
        Outcome::Cancelled => (true, Some("(The user stopped this request before it finished. Some of its actions may have run.)")),
        Outcome::Failed(_) | Outcome::Ended => (true, Some("(This request failed before it finished.)")),
    };
    if let Some(note) = note {
        let mut h = sess.history.lock().unwrap();
        h.push(message.clone());
        h.push(Message::assistant(note));
    }
    sess.save();
    if let Outcome::Failed(e) = &outcome {
        sess.sink.line(sess.id, "stderr", format!("✗ {}", friendly_error(&sess.cfg, e)));
    }
    let result = json!({
        "type": "result",
        "subtype": match outcome { Outcome::Done(_) => "success", Outcome::Cancelled => "interrupted", _ => "error" },
        "is_error": is_error,
        "stopped": matches!(outcome, Outcome::Cancelled),
        "num_turns": st.model_calls.max(1),
        "duration_ms": started.elapsed().as_millis() as u64,
        "session_id": sess.cfg.conversation,
        "usage": { "input_tokens": st.input_tokens, "output_tokens": st.output_tokens },
        "permission_denials": [],
        // The final answer, as Claude Code's result carries it (tasks pass it on).
        "result": match &outcome { Outcome::Done(resp) => resp.output(), _ => String::new() },
    });
    *sess.cancel.lock().unwrap() = None;
    sess.sink.line(sess.id, "stdout", event(result));
}

/// Errors in words the user can act on.
fn friendly_error(cfg: &SessionConfig, e: &str) -> String {
    let lower = e.to_ascii_lowercase();
    if cfg.provider == "ollama" && (lower.contains("connect") || lower.contains("connection refused")) {
        return format!("Couldn't reach Ollama — is it running? (`ollama serve`)\n{e}");
    }
    if cfg.provider == "ollama" && lower.contains("not found") && lower.contains("model") {
        return format!("Ollama doesn't have the model {} — `ollama pull {}`\n{e}", cfg.model, cfg.model);
    }
    if cfg.provider == "anthropic" && lower.contains("only authorized for use with claude code") {
        return format!("Anthropic refused the Claude sign-in for Paw: it takes subscription sign-ins only from Claude Code. Use an API key instead.\n{e}");
    }
    if cfg.provider == "anthropic" && (lower.contains("401") || lower.contains("authentication") || lower.contains("invalid x-api-key")) {
        return format!("Anthropic didn't accept the key or sign-in — check it in Settings › Agents › Paw Agent.\n{e}");
    }
    if cfg.provider == copilot::PROVIDER && (lower.contains("model_not_supported") || lower.contains("model is not supported")) {
        return format!("GitHub Copilot doesn't offer {} to this account — pick another with /model.\n{e}", cfg.model);
    }
    e.to_string()
}

// ---------------------------------------------------------------------------
// The session table
// ---------------------------------------------------------------------------

/// A session that just started: what the UI shows first.
pub struct Started {
    pub info: AgentInfo,
    pub conversation: String,
    /// (stream, text) lines, the init event first.
    pub lines: Vec<(&'static str, String)>,
}

/// What `paw_agent_start` answers: the session, its conversation id and its
/// first lines (shaped like `agent:output` lines).
#[derive(Serialize)]
pub struct StartReply {
    #[serde(flatten)]
    pub info: AgentInfo,
    pub session: String,
    pub lines: Vec<crate::agents::OutputLine>,
}

#[derive(Default)]
pub struct PawAgents {
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
}

impl PawAgents {
    pub fn get(&self, id: u32) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(&id).cloned()
    }

    /// Start a session and load its conversation. Its first lines (the init
    /// event, a warning) are returned, not sent: the UI only knows the
    /// session's id once this returns, and would drop lines sent before.
    pub fn start(&self, id: u32, cfg: SessionConfig, model: DynModel<Completion>, sink: Arc<dyn Sink>) -> Started {
        // A tab that restarts its session (new model, approval level…) or a
        // reloaded window: the conversation has one live session at a time.
        let old: Vec<u32> = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.cfg.conversation == cfg.conversation)
            .map(|s| s.id)
            .collect();
        for o in old {
            self.close(o);
        }
        let (history, notes) = cfg.history_path.as_deref().map(load_history).unwrap_or_default();
        let info = AgentInfo {
            id,
            name: cfg.name.clone(),
            command: format!("paw-agent {} {}", cfg.provider, cfg.model),
            cwd: cfg.cwd.display().to_string(),
            pid: 0,
            status: Status::Running,
            exit_code: None,
            started_at: now_ms(),
            ended_at: None,
        };
        let sess = Arc::new(Session {
            id,
            level: Mutex::new(cfg.approval.clone()),
            rules: Mutex::new(cfg.allow_rules.clone()),
            request: Mutex::default(),
            history: Mutex::new(history),
            notes: Mutex::new(notes),
            pending: Mutex::default(),
            questions: Mutex::default(),
            sandbox: Mutex::new(cfg.sandbox.clone()),
            cancel: Mutex::default(),
            seen: Seen::default(),
            sink: sink.clone(),
            info: Mutex::new(info.clone()),
            closed: AtomicBool::new(false),
            model,
            cfg,
        });
        self.sessions.lock().unwrap().insert(id, sess.clone());
        let tools: Vec<&str> = ["read", "edit", "write", "search", "list", "shell"].into_iter().filter(|t| sess.cfg.has_tool(t)).collect();
        let mut lines = vec![(
            "stdout",
            event(json!({
                "type": "system",
                "subtype": "init",
                "session_id": sess.cfg.conversation,
                "model": format!("{} · {}", sess.cfg.model, provider_label(&sess.cfg.provider)),
                "cwd": sess.cfg.cwd.display().to_string(),
                "tools": tools,
                "mcp_servers": sess.cfg.mcp.connected,
                "messages": sess.history_len(),
            })),
        )];
        if !sess.cfg.mcp.connected.is_empty() {
            lines.push(("system", format!("MCP: {}", sess.cfg.mcp.connected.join(" · "))));
        }
        for f in &sess.cfg.mcp.failed {
            lines.push(("stderr", format!("MCP server {f}")));
        }
        if !sess.cfg.tools {
            lines.push(("stderr", format!("{} can't call tools, so Paw Agent can only talk here (no reading or editing files). Pick a model with tool support (/model).", sess.cfg.model)));
        }
        Started { info, conversation: sess.cfg.conversation.clone(), lines }
    }

    /// Start a prompt. Returns the future that runs it (the caller spawns it).
    pub fn send(&self, id: u32, text: String) -> Result<impl std::future::Future<Output = ()> + Send + 'static, String> {
        let sess = self.get(id).ok_or("This Paw Agent session has ended")?;
        let (tx, rx) = oneshot::channel();
        {
            let mut c = sess.cancel.lock().unwrap();
            if c.is_some() {
                return Err("Paw Agent is still working on the last prompt — wait, or ⌘. to stop it".into());
            }
            *c = Some(tx);
        }
        Ok(run_turn(sess, text, rx))
    }

    /// Add terminal output to the conversation: the agent sees it with the
    /// next prompt (a running one has already been sent). Saved right away.
    pub fn note(&self, id: u32, text: String) -> Result<(), String> {
        let sess = self.get(id).ok_or("This Paw Agent session has ended")?;
        if text.trim().is_empty() {
            return Ok(());
        }
        sess.notes.lock().unwrap().push(text);
        sess.save();
        Ok(())
    }

    /// Stop the running prompt, if any.
    pub fn cancel(&self, id: u32) {
        if let Some(sess) = self.get(id) {
            if let Some(tx) = sess.cancel.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
    }

    /// End the session (tab closed, agent restarted).
    pub fn close(&self, id: u32) {
        let Some(sess) = self.sessions.lock().unwrap().remove(&id) else { return };
        if let Some(tx) = sess.cancel.lock().unwrap().take() {
            let _ = tx.send(());
        }
        if !sess.closed.swap(true, Ordering::SeqCst) {
            sess.set_status(Status::Stopped);
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<u32> = self.sessions.lock().unwrap().keys().copied().collect();
        for id in ids {
            self.close(id);
        }
    }

    /// The user allowed a program the sandbox blocked (in this session).
    pub fn sandbox_allow(&self, id: u32, program: &str) -> Result<(), String> {
        let sess = self.get(id).ok_or("This Paw Agent session has ended")?;
        let mut p = sess.sandbox.lock().unwrap();
        let p = p.as_mut().ok_or("This session has no sandbox")?;
        if !p.programs.iter().any(|x| x == program) {
            p.programs.push(program.to_string());
        }
        Ok(())
    }

    /// The user's answer to a question (`ask_user`).
    pub fn answer(&self, id: u32, request: u64, text: String) -> Result<(), String> {
        let sess = self.get(id).ok_or("This Paw Agent session has ended")?;
        let tx = sess.questions.lock().unwrap().remove(&request).ok_or("That question is no longer waiting")?;
        tx.send(text).map_err(|_| "That question is no longer waiting".to_string())
    }

    /// The user's decision on an approval card: "once", "always" or "deny".
    pub fn approve(&self, id: u32, request: u64, decision: &str, rule: Option<String>) -> Result<(), String> {
        let sess = self.get(id).ok_or("This Paw Agent session has ended")?;
        let tx = sess.pending.lock().unwrap().remove(&request).ok_or("That request is no longer waiting")?;
        let allow = match decision {
            "once" => true,
            "always" => {
                if let Some(rule) = rule.filter(|r| !r.is_empty()) {
                    let mut rules = sess.rules.lock().unwrap();
                    if !rules.contains(&rule) {
                        rules.push(rule);
                    }
                }
                true
            }
            _ => false,
        };
        tx.send(allow).map_err(|_| "That request is no longer waiting".to_string())
    }
}

/// A saved conversation as the `agent:output` lines a tab shows (the same
/// stream-json events a live session sends), for reading a finished one.
pub fn conversation_lines(path: &Path) -> Vec<String> {
    let (messages, _) = load_history(path);
    let mut out = vec![];
    for m in messages {
        match m {
            Message::User { content } => {
                for c in content {
                    match c {
                        rig_core::message::UserContent::Text(t) if !t.text.trim().is_empty() => out.push(event(json!({
                            "type": "user",
                            "message": { "role": "user", "content": [{ "type": "text", "text": t.text }] }
                        }))),
                        rig_core::message::UserContent::ToolResult(r) => out.push(tool_result_event(&r.call.to_string(), &tool_result_text(&r.content), r.is_error)),
                        _ => {}
                    }
                }
            }
            Message::Assistant(a) => {
                for c in a.content {
                    match c {
                        AssistantContent::Text(t) if !t.text.trim().is_empty() => out.push(text_event(t.text.trim())),
                        AssistantContent::Reasoning(r) if !r.text.trim().is_empty() => out.push(thinking_event(&r.text)),
                        AssistantContent::ToolCall(call) => out.push(tool_use_event(&call.id.to_string(), &call.function.name, Value::Object(call.function.arguments.clone()))),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// A provider's name; an added provider's id stands for its name.
fn provider_label(p: &str) -> &str {
    match p {
        "anthropic" => "Anthropic",
        copilot::PROVIDER => "GitHub Copilot",
        chatgpt::PROVIDER => "ChatGPT",
        openrouter::PROVIDER => "OpenRouter",
        "ollama" => "Ollama",
        _ => p,
    }
}

// ---------------------------------------------------------------------------
// Models, system prompt, Keychain
// ---------------------------------------------------------------------------

pub const ANTHROPIC_MODELS: &[&str] = &["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-2"];
pub const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";

/// Paw's own providers; any other id is one the user added.
pub const BUILT_IN: &[&str] = &["anthropic", copilot::PROVIDER, chatgpt::PROVIDER, openrouter::PROVIDER, "ollama"];

/// The provider and model of a model id written `<provider>/<model>`, where
/// `<model>` may hold `/` itself (`openrouter/anthropic/claude-sonnet-4.6`).
/// The prefix is stripped when it's `provider`'s. Without it, a model
/// written `anthropic/<name>`, `copilot/<name>`… picks that built-in
/// provider over Anthropic, Copilot, ChatGPT or Ollama (older settings);
/// OpenRouter's and added providers' model names are taken as they are.
/// No provider at all is Ollama.
pub fn split_provider<'a>(provider: &'a str, model: &'a str) -> (&'a str, &'a str) {
    let provider = if provider.is_empty() { "ollama" } else { provider };
    if let Some(rest) = model.strip_prefix(provider).and_then(|r| r.strip_prefix('/')) {
        return (provider, rest);
    }
    if provider != openrouter::PROVIDER && BUILT_IN.contains(&provider) {
        for p in BUILT_IN {
            if let Some(rest) = model.strip_prefix(p).and_then(|r| r.strip_prefix('/')) {
                return (p, rest);
            }
        }
    }
    (provider, model)
}

/// The model for a provider and its credential. Anthropic: an API key as
/// `x-api-key`, a gateway's auth token as `Authorization: Bearer`, both at
/// `base_url` when set; a claude.ai sign-in on the account's Claude plan,
/// always at Anthropic's API (its token is for nowhere else). ChatGPT: the
/// account's sign-in. OpenRouter: its key. Ollama at `base_url`. Any other
/// provider is one the user added: Chat Completions at `base_url`, with
/// its key when it has one. (Copilot's model is `copilot::model`.)
pub fn make_model(provider: &str, model: &str, base_url: &str, cred: Option<keys::Credential>) -> Result<DynModel<Completion>, String> {
    let key = |cred: Option<keys::Credential>| match cred.map(|c| c.secret) {
        Some(keys::Secret::ApiKey(k) | keys::Secret::Bearer(k)) if !k.is_empty() => Some(k),
        _ => None,
    };
    match provider {
        "anthropic" => {
            use rig_core::providers::anthropic::{wire::Auth, AnthropicConfig, ANTHROPIC};
            let cred = cred.ok_or("No Anthropic API key or Claude sign-in yet — add one in Settings › Agents › Paw Agent.")?;
            let mut cfg = match cred.secret {
                keys::Secret::Claude(login) => return Ok(claude::model(login, model)),
                keys::Secret::ApiKey(key) => AnthropicConfig::new(key),
                keys::Secret::Bearer(token) => {
                    let mut dialect = ANTHROPIC;
                    dialect.quirks.auth = Auth::OptionalBearer;
                    AnthropicConfig::with_key(&dialect, token)
                }
            };
            if !base_url.trim().is_empty() {
                cfg = cfg.with_base_url(base_url.trim());
            }
            Ok(cfg.client().completion(model).into())
        }
        "ollama" => {
            use rig_core::providers::ollama::OllamaConfig;
            let mut cfg = OllamaConfig::new();
            if !base_url.trim().is_empty() {
                cfg = cfg.with_base_url(base_url.trim());
            }
            Ok(cfg.client().native_completion(model).into())
        }
        chatgpt::PROVIDER => Ok(chatgpt::model(model)),
        openrouter::PROVIDER => Ok(openrouter::model(&key(cred).ok_or(openrouter::NO_KEY)?, model)),
        _ if base_url.trim().is_empty() => Err(format!("The provider “{provider}” has no address. Set its base URL in Settings › Agents.")),
        _ => Ok(compatible::model(base_url, key(cred).as_deref(), model)),
    }
}

/// What agents are told about the session's scripts folder (Claude Code gets
/// the same words).
pub fn scripts_note(dir: &Path) -> String {
    format!(
        "Scripts folder for this session: {}\nWrite one-off helper scripts (anything that isn't part of the project) there, \
not into the working folder, and run them from there.",
        dir.display()
    )
}

fn level_text(level: &str) -> &'static str {
    match level {
        "plan" => "plan — read-only. Read and search freely, but don't change files or run commands; propose a plan instead.",
        "ask" => "ask — the user confirms every file change and every command before it runs.",
        "full" => "full — file changes and commands run without confirmation. Be careful.",
        "auto" => "auto — file changes in this folder and routine commands run on their own; risky actions (pushing, deleting outside the folder, installing, system changes) wait for the user's confirmation.",
        _ => "edits — file changes run without asking; the user confirms commands before they run.",
    }
}

/// Instructions a project keeps for agents (AGENTS.md, CLAUDE.md), from the
/// folder up to its repository root.
fn project_notes(cwd: &Path) -> String {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut out = String::new();
    let mut dir = Some(cwd.to_path_buf());
    while let Some(d) = dir {
        if Some(&d) == home.as_ref() || d.parent().is_none() {
            break;
        }
        for name in ["AGENTS.md", "CLAUDE.md"] {
            let p = d.join(name);
            if let Ok(text) = std::fs::read_to_string(&p) {
                if out.len() + text.len() <= NOTES_BUDGET {
                    out.push_str(&format!("\n<project-instructions file=\"{}\">\n{}\n</project-instructions>\n", p.display(), text.trim()));
                }
                break; // one file per folder; AGENTS.md wins
            }
        }
        if d.join(".git").exists() {
            break;
        }
        dir = d.parent().map(Path::to_path_buf);
    }
    out
}

/// `only`: the built-in tools the session has, when it doesn't have them all
/// (a factory node); the model is told about those alone.
/// The language the user picked (Settings › General › Language), as its
/// English name; None for English.
pub fn user_language() -> Option<&'static str> {
    let v: Value = crate::paths::home()
        .and_then(|h| std::fs::read_to_string(h.join("settings.json")).ok())
        .and_then(|t| serde_json::from_str(&t).ok())?;
    match v.pointer("/general/language")?.as_str()? {
        "de" => Some("German"),
        "tr" => Some("Turkish"),
        _ => None,
    }
}

/// What Paw Agent is told about the user's language.
pub fn language_rule(lang: &str) -> String {
    format!(
        "The user's language is {lang}. Write everything meant for the user in {lang}: your answers, questions, summaries, plans, \
         notes and commit messages you're asked to write for them. Keep code, commands, file names, identifiers and quoted output as \
         they are. When your instructions ask for an exact line, keyword or format (like `VERDICT: approved` or a JSON shape), \
         write it exactly as given, in English if that's how it's given."
    )
}

pub fn build_preamble(cwd: &Path, level: &str, tools: bool, skills_index: &str, scripts: Option<&Path>, only: Option<&[String]>) -> String {
    let has = |t: &str| only.map_or(true, |o| o.iter().any(|x| x == t));
    let mut p = String::new();
    p.push_str("You are Paw Agent, a coding agent built into Paw, a macOS app where people work with coding agents in terminal-like tabs.\n\n");
    if let Some(lang) = user_language() {
        p.push_str(&language_rule(lang));
        p.push_str("\n\n");
    }
    p.push_str(&format!("Working folder: {}\nRelative paths are resolved there{}.\n", cwd.display(), if tools && has("shell") { "; the shell tool runs commands there" } else { "" }));
    if let (true, Some(dir)) = (tools, scripts) {
        p.push_str(&format!("{}\n", scripts_note(dir)));
    }
    if let (true, Some(only)) = (tools, only) {
        const ALL: [(&str, &str); 6] = [
            ("read", "a file's lines"),
            ("search", "regex over the tree"),
            ("list", "a folder's files"),
            ("edit", "exact replacements in a file"),
            ("write", "a whole file"),
            ("shell", "a command line, `sh -c`"),
        ];
        let mine: Vec<String> = ALL.iter().filter(|(t, _)| only.iter().any(|x| x == t)).map(|(t, what)| format!("{t} ({what})")).collect();
        if mine.is_empty() {
            p.push_str("\nYou have no built-in tools here (no file or shell access); use only the other tools you're given, if any.\n");
        } else {
            p.push_str(&format!(
                "\nYour only built-in tools: {}. Don't call any other built-in tool (such as shell) — you don't have it; do the job with these.\n",
                mine.join(", ")
            ));
        }
        p.push_str(&format!("\nApproval level: {}\n", level_text(level)));
    } else if tools {
        p.push_str(
            "\nTools: read (a file's lines), search (regex over the tree), list (a folder's files), edit (exact replacements in a file), \
write (a whole file), shell (a command line, `sh -c`).\n\
- Look before you change: read a file before editing it, and search or list to find things.\n\
- Prefer edit for changes to existing files; old_text must match the file exactly.\n\
- Run commands non-interactively; they get no input and no terminal.\n\
- When a tool call is refused, don't repeat it; adapt or ask the user.\n\
- The user also runs commands in the tab's terminal; their output reaches you in <terminal> blocks.\n",
        );
        p.push_str(&format!("\nApproval level: {}\n", level_text(level)));
    } else {
        p.push_str("\nThis model can't call tools here, so you can't read or change files. Answer from what the user tells you.\n");
    }
    p.push_str("\nAnswer in the user's language. Be concise; use Markdown. When you're done, say briefly what you did.\n");
    let notes = project_notes(cwd);
    if !notes.is_empty() {
        p.push_str(&notes);
    }
    if tools && !skills_index.trim().is_empty() {
        p.push('\n');
        p.push_str(skills_index.trim());
        p.push('\n');
    }
    p
}

pub mod keychain {
    //! Paw's Keychain items: one service, an account per item.
    //!
    //! Reading an item's secret is what makes macOS ask whether Paw may (once
    //! per item, with Always Allow). Checking that an item exists doesn't ask,
    //! so status ("signed in?", "key saved?") uses `has*`, and the names shown
    //! next to sign-ins come from `~/.paw/signins.json` (not secret), not from
    //! the Keychain.
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    fn account(provider: &str) -> String {
        format!("{provider}-api-key")
    }

    fn read(service: &str, account: &str) -> Option<String> {
        get_generic_password(service, account)
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .filter(|s| !s.is_empty())
    }

    /// Does this item exist? Its attributes only: no secret, no prompt.
    fn exists(service: &str, account: &str) -> bool {
        use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
        ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(service)
            .account(account)
            .load_attributes(true)
            .limit(Limit::Max(1))
            .search()
            .is_ok_and(|r| !r.is_empty())
    }

    /// Is a key saved for this provider (here, or from before the rename)? Never asks.
    pub fn has(provider: &str) -> bool {
        has_item(&account(provider)) || exists(crate::paths::legacy_keychain_service(), &account(provider))
    }

    /// Does Paw's item `account` exist? Never asks.
    pub fn has_item(account: &str) -> bool {
        exists(crate::paths::keychain_service(), account)
    }

    fn notes_path() -> Option<std::path::PathBuf> {
        crate::paths::home().map(|h| h.join("signins.json"))
    }

    /// A sign-in's account name (an email, a GitHub login), kept outside the
    /// Keychain so showing it doesn't ask.
    pub fn note(key: &str) -> Option<String> {
        let text = std::fs::read_to_string(notes_path()?).ok()?;
        let v: serde_json::Value = serde_json::from_str(&text).ok()?;
        v.get(key)?.as_str().filter(|s| !s.is_empty()).map(String::from)
    }

    /// Keep (or with None, forget) a sign-in's account name.
    pub fn set_note(key: &str, value: Option<&str>) {
        let Some(path) = notes_path() else { return };
        let mut v: serde_json::Map<String, serde_json::Value> =
            std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        match value.filter(|s| !s.is_empty()) {
            Some(x) => v.insert(key.to_string(), x.into()),
            None => v.remove(key),
        };
        if let Ok(text) = serde_json::to_string_pretty(&v) {
            let _ = std::fs::create_dir_all(path.parent().unwrap_or(std::path::Path::new(".")));
            let _ = std::fs::write(&path, text);
        }
    }

    /// The saved key; one saved before the rename (Hive → Paw) is moved over.
    pub fn get(provider: &str) -> Option<String> {
        if let Some(k) = item(&account(provider)) {
            return Some(k);
        }
        let old = read(crate::paths::legacy_keychain_service(), &account(provider))?;
        if set(provider, &old).is_ok() {
            let _ = delete_generic_password(crate::paths::legacy_keychain_service(), &account(provider));
        }
        Some(old)
    }

    pub fn set(provider: &str, key: &str) -> Result<(), String> {
        set_item(&account(provider), key)
    }

    pub fn delete(provider: &str) -> Result<(), String> {
        let _ = delete_generic_password(crate::paths::legacy_keychain_service(), &account(provider));
        delete_item(&account(provider))
    }

    /// The item `account` of Paw's service.
    pub fn item(account: &str) -> Option<String> {
        read(crate::paths::keychain_service(), account)
    }

    pub fn set_item(account: &str, value: &str) -> Result<(), String> {
        set_generic_password(crate::paths::keychain_service(), account, value.as_bytes()).map_err(|e| e.to_string())
    }

    /// Removing an item that isn't there succeeds.
    pub fn delete_item(account: &str) -> Result<(), String> {
        match delete_generic_password(crate::paths::keychain_service(), account) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == -25300 => Ok(()), // errSecItemNotFound
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Whether an Ollama model can call tools (`ollama show` lists "tools"
/// under Capabilities). None: couldn't tell.
pub fn ollama_supports_tools(base_url: &str, model: &str) -> Option<bool> {
    let out = crate::registry::run_with_env(
        "ollama",
        &["show", model],
        &[("OLLAMA_HOST", base_url)],
        std::time::Duration::from_secs(10),
    )?;
    let caps = out.split("Capabilities").nth(1)?;
    let section: Vec<&str> = caps.lines().skip(1).take_while(|l| !l.trim().is_empty()).collect();
    if section.is_empty() {
        return None;
    }
    Some(section.iter().any(|l| l.trim() == "tools"))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
pub struct StartOpts {
    pub name: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub base_url: String,
    pub cwd: String,
    #[serde(default)]
    pub approval: String,
    #[serde(default)]
    pub allow_rules: Vec<String>,
    /// The conversation to continue, if any.
    #[serde(default)]
    pub session: Option<String>,
    /// Where the Anthropic key comes from (keys::list ids; empty: automatic).
    #[serde(default)]
    pub key_source: String,
    /// The tab's id: its folder `~/.paw/session/<id>` keeps the conversation.
    #[serde(default)]
    pub paw_session: Option<String>,
    /// Only these built-in tools (read, edit, write, search, list, shell); unset: all.
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    /// Only these skills (by name); unset: all.
    #[serde(default)]
    pub skills: Option<Vec<String>>,
    /// Only these MCP servers (by name); unset: every one that's on.
    #[serde(default)]
    pub mcp: Option<Vec<String>>,
    /// A folder to keep the conversation, scripts and files in instead of
    /// `~/.paw/session/<id>` (a factory node's, inside its run's folder).
    #[serde(skip)]
    pub dir: Option<PathBuf>,
    /// It may ask the user (`ask_user`): a factory node.
    #[serde(skip)]
    pub ask: bool,
    /// A folder as fine to change as `cwd` in auto mode (a factory run's shared files).
    #[serde(skip)]
    pub shared: Option<PathBuf>,
    /// The sandbox it asks for (a tab's, a factory's); None: Settings'. A
    /// project's `.paw/sandbox.yaml` can only make it stricter.
    #[serde(default)]
    pub sandbox: Option<sandbox::Policy>,
}

fn valid_conversation_id(s: &str) -> bool {
    s.len() >= 8 && s.len() <= 64 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Fork a tab's conversation: a copy of it in another tab's folder, under a
/// new id, for that tab's agent to go on from (Fork Tab). Returns the copy's id.
#[tauri::command]
pub fn paw_agent_fork_conversation(from: String, conversation: String, to: String) -> Result<String, String> {
    let home = crate::paths::home().ok_or("Paw can't find its folder (~/.paw).")?;
    fork_conversation_in(&home, &from, &conversation, &to)
}

fn fork_conversation_in(home: &Path, from: &str, conversation: &str, to: &str) -> Result<String, String> {
    if !valid_conversation_id(conversation) || from == to {
        return Err("That conversation can't be forked.".into());
    }
    let file = format!("{conversation}.json");
    let src = crate::paths::session_dir_in(home, from).map(|d| d.join("conversations").join(&file)).filter(|p| p.is_file()).ok_or("There's no conversation to fork yet.")?;
    let dst = crate::paths::session_dir_in(home, to).ok_or("Not a valid session id")?.join("conversations");
    std::fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
    let id = new_conversation_id();
    std::fs::copy(&src, dst.join(format!("{id}.json"))).map_err(|e| format!("Paw couldn't copy the conversation: {e}"))?;
    Ok(id)
}

#[tauri::command]
pub async fn paw_agent_start(
    app: tauri::AppHandle,
    procs: tauri::State<'_, crate::agents::AgentManager>,
    paw: tauri::State<'_, PawAgents>,
    opts: StartOpts,
) -> Result<StartReply, String> {
    let cwd = crate::agents::expand_home(opts.cwd.trim());
    if !cwd.is_dir() {
        return Err(format!("Working directory does not exist: {}", cwd.display()));
    }
    let (provider, model) = split_provider(&opts.provider, &opts.model);
    let (provider, model) = (provider.to_string(), model.trim().to_string());
    let model = match provider.as_str() {
        _ if !model.is_empty() => model,
        "anthropic" => ANTHROPIC_MODELS[0].to_string(),
        copilot::PROVIDER => copilot::MODELS[0].to_string(),
        chatgpt::PROVIDER => rig_core::providers::chatgpt::DEFAULT_MODEL.to_string(),
        _ => model,
    };
    if model.is_empty() {
        return Err("Paw Agent needs a model — pick one with /model (Ollama models with tool support are listed).".into());
    }
    let mut base_url = if opts.base_url.trim().is_empty() && provider == "ollama" { DEFAULT_OLLAMA_URL.to_string() } else { opts.base_url.trim().to_string() };
    let approval = if ["ask", "edits", "auto", "plan", "full"].contains(&opts.approval.as_str()) { opts.approval.clone() } else { "edits".into() };

    let conversation = opts.session.clone().filter(|s| valid_conversation_id(s)).unwrap_or_else(new_conversation_id);
    // The tab's folder (a tab from before session folders: its conversation's).
    let session_dir = match &opts.dir {
        Some(d) => ["files", "scripts", "conversations"].iter().all(|s| std::fs::create_dir_all(d.join(s)).is_ok()).then(|| d.clone()),
        None => crate::paths::ensure_session_dir(opts.paw_session.as_deref().filter(|s| crate::paths::valid_session_id(s)).unwrap_or(&conversation)).ok(),
    };
    let scripts = session_dir.as_ref().map(|d| d.join("scripts"));
    let app2 = app.clone();
    let scripts2 = scripts.clone();
    let (cwd2, provider2, model2, base2, approval2, source2) =
        (cwd.clone(), provider.clone(), model.clone(), base_url.clone(), approval.clone(), opts.key_source.clone());
    let only_skills = opts.skills.clone();
    let only_tools = opts.tools.clone();
    // Keys, the sign-ins, `ollama show` and the skill folders: off the async threads.
    let (cred, copilot_source, tools, preamble) = tauri::async_runtime::spawn_blocking(move || {
        let cred = match provider2.as_str() {
            "anthropic" => Some(keys::resolve(&keys::System, &source2)?),
            copilot::PROVIDER | "ollama" => None,
            chatgpt::PROVIDER if !chatgpt::status().signed_in => return Err(chatgpt::NOT_SIGNED_IN.to_string()),
            chatgpt::PROVIDER => None,
            // OpenRouter's key, or an added provider's.
            p => keychain::get(p).map(|k| keys::Credential { secret: keys::Secret::ApiKey(k), base_url: None, source: p.to_string() }),
        };
        let copilot_source = (provider2 == copilot::PROVIDER).then(|| copilot::source(&copilot::user_home())).transpose()?;
        let tools = provider2 != "ollama" || ollama_supports_tools(&base2, &model2).unwrap_or(true);
        let skills = crate::skills::agent_skills_index_of(&app2, &cwd2, only_skills.as_deref());
        Ok::<_, String>((cred, copilot_source, tools, build_preamble(&cwd2, &approval2, tools, &skills, scripts2.as_deref(), only_tools.as_deref())))
    })
    .await
    .map_err(|e| e.to_string())??;
    // The agent's own address wins; else the one that came with the key.
    if base_url.is_empty() {
        if let Some(b) = cred.as_ref().and_then(|c| c.base_url.clone()) {
            base_url = b;
        }
    }
    let model_handle = match copilot_source {
        Some(source) => copilot::model(source, &model).await?,
        None => make_model(&provider, &model, &base_url, cred)?,
    };
    // Paw Agent's MCP servers (Settings-free: the MCP panel keeps the list).
    let path_env = crate::registry::login_path().to_string();
    let mcp = if tools {
        let mut servers = crate::mcp::paw_servers(crate::paths::config_dir(&app).as_deref());
        // A factory node may use only some of them.
        if let Some(only) = &opts.mcp {
            servers.retain(|s| only.iter().any(|n| n.eq_ignore_ascii_case(&s.name)));
        }
        crate::mcp::connect_all(&servers, &cwd, Some(&path_env)).await
    } else {
        crate::mcp::McpSetup::default()
    };

    let history_path = session_dir.as_ref().map(|d| d.join("conversations").join(format!("{conversation}.json")));
    // Continuing a conversation kept in another tab's folder (or the old
    // shared folder): it moves here.
    if let (Some(path), Some(home)) = (&history_path, crate::paths::home()) {
        if !path.exists() {
            let short: String = conversation.chars().take(8).collect();
            let elsewhere = [
                crate::paths::session_dir_in(&home, &conversation).map(|d| d.join("conversations").join(format!("{conversation}.json"))),
                crate::paths::session_dir_in(&home, &short).map(|d| d.join("conversations").join(format!("{conversation}.json"))),
                Some(home.join("paw-agent").join(format!("{conversation}.json"))),
            ];
            if let Some(old) = elsewhere.into_iter().flatten().find(|p| p.is_file()) {
                let _ = std::fs::rename(old, path);
            }
        }
    }
    // The sandbox: the one asked for (else Settings'), made stricter by the project's file.
    let sandbox = sandbox::effective(opts.sandbox.clone(), &cwd);
    let preamble = match &sandbox {
        Some(p) => {
            let also: Vec<PathBuf> = scripts.iter().cloned().chain(opts.shared.clone()).collect();
            format!("{preamble}\n\n{}", sandbox::describe(p, &sandbox::roots(p, &cwd, &also)))
        }
        None => preamble,
    };
    let cfg = SessionConfig {
        name: opts.name,
        provider,
        model,
        cwd,
        approval,
        allow_rules: opts.allow_rules,
        preamble,
        conversation,
        history_path,
        tools,
        path_env: Some(path_env),
        mcp,
        scripts,
        tool_names: opts.tools,
        ask: opts.ask,
        shared: opts.shared,
        sandbox,
    };
    let id = procs.alloc_id();
    let sink: Arc<dyn Sink> = Arc::new(TauriSink { app, seq: Mutex::default() });
    let started = paw.start(id, cfg, model_handle, sink);
    let lines = started
        .lines
        .into_iter()
        .enumerate()
        .map(|(i, (stream, text))| crate::agents::OutputLine { id, seq: i as u64, stream, text, ts: now_ms() })
        .collect();
    Ok(StartReply { info: started.info, session: started.conversation, lines })
}

#[tauri::command]
pub async fn paw_agent_send(paw: tauri::State<'_, PawAgents>, id: u32, text: String) -> Result<(), String> {
    let fut = paw.send(id, text)?;
    tauri::async_runtime::spawn(fut);
    Ok(())
}

#[tauri::command]
pub async fn paw_agent_note(paw: tauri::State<'_, PawAgents>, id: u32, text: String) -> Result<(), String> {
    let paw = paw.inner();
    paw.note(id, text)
}

#[tauri::command]
pub async fn paw_agent_cancel(paw: tauri::State<'_, PawAgents>, id: u32) -> Result<(), String> {
    paw.cancel(id);
    Ok(())
}

#[tauri::command]
pub async fn paw_agent_close(paw: tauri::State<'_, PawAgents>, id: u32) -> Result<(), String> {
    paw.close(id);
    Ok(())
}

#[tauri::command]
pub async fn paw_agent_sandbox(paw: tauri::State<'_, PawAgents>, id: u32, program: String) -> Result<(), String> {
    paw.sandbox_allow(id, program.trim())
}

#[tauri::command]
pub async fn paw_agent_approve(
    paw: tauri::State<'_, PawAgents>,
    id: u32,
    request: u64,
    decision: String,
    rule: Option<String>,
) -> Result<(), String> {
    paw.approve(id, request, &decision, rule)
}

/// Where an Anthropic key was found on this Mac (never the key itself).
#[tauri::command]
pub async fn paw_key_sources() -> Result<Vec<keys::KeySource>, String> {
    tauri::async_runtime::spawn_blocking(|| keys::list(&keys::System)).await.map_err(|e| e.to_string())
}

/// The providers Paw keeps an API key for: Anthropic, OpenRouter and the
/// ones the user added (the settings name them).
fn key_ids(app: &tauri::AppHandle, reg: &crate::registry::Registry) -> Vec<String> {
    reg.settings(app).providers.key_ids()
}

fn key_provider(app: &tauri::AppHandle, reg: &crate::registry::Registry, provider: &str) -> Result<(), String> {
    if key_ids(app, reg).iter().any(|p| p == provider) {
        Ok(())
    } else {
        Err(format!("Paw keeps no API key for “{provider}”."))
    }
}

/// Which providers have an API key in the Keychain (never the key itself).
#[tauri::command]
pub async fn paw_key_status(app: tauri::AppHandle, reg: tauri::State<'_, crate::registry::Registry>) -> Result<HashMap<String, bool>, String> {
    let ids = key_ids(&app, &reg);
    let saved = move || {
        ids.into_iter()
            .map(|p| {
                let saved = keychain::has(&p); // without reading it: no prompt
                (p, saved)
            })
            .collect()
    };
    tauri::async_runtime::spawn_blocking(saved).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn paw_key_set(app: tauri::AppHandle, reg: tauri::State<'_, crate::registry::Registry>, provider: String, key: String) -> Result<(), String> {
    key_provider(&app, &reg, &provider)?;
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("The key is empty".into());
    }
    tauri::async_runtime::spawn_blocking(move || keychain::set(&provider, &key)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn paw_key_delete(app: tauri::AppHandle, reg: tauri::State<'_, crate::registry::Registry>, provider: String) -> Result<(), String> {
    key_provider(&app, &reg, &provider)?;
    tauri::async_runtime::spawn_blocking(move || keychain::delete(&provider)).await.map_err(|e| e.to_string())?
}

/// Paw's Copilot sign-in and Copilot CLI's (never a token).
#[tauri::command]
pub async fn paw_copilot_status() -> Result<copilot::Status, String> {
    tauri::async_runtime::spawn_blocking(|| copilot::status(&copilot::user_home())).await.map_err(|e| e.to_string())
}

/// Stops the sign-in that's waiting for the browser.
static CANCEL_SIGN_IN: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

/// Sign in to GitHub Copilot: the browser opens GitHub's device page and
/// `copilot:device` tells Settings the code to enter there. Answers the
/// GitHub login once the user has approved Paw.
#[tauri::command]
pub async fn paw_copilot_sign_in(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;
    let (tx, rx) = oneshot::channel();
    // A sign-in already waiting ends (its sender is dropped).
    *CANCEL_SIGN_IN.lock().unwrap() = Some(tx);
    let show = move |device: copilot::DeviceCode| {
        let _ = std::process::Command::new("/usr/bin/open").arg(&device.uri).spawn();
        let _ = app.emit("copilot:device", device);
    };
    tokio::select! {
        r = copilot::sign_in(show) => r,
        _ = rx => Err("Sign-in cancelled.".into()),
    }
}

#[tauri::command]
pub async fn paw_copilot_cancel_sign_in() -> Result<(), String> {
    CANCEL_SIGN_IN.lock().unwrap().take();
    Ok(())
}

#[tauri::command]
pub async fn paw_copilot_sign_out() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(copilot::sign_out).await.map_err(|e| e.to_string())?
}

/// Paw's Claude sign-in (never a token).
#[tauri::command]
pub async fn paw_claude_status() -> Result<claude::Status, String> {
    tauri::async_runtime::spawn_blocking(claude::status).await.map_err(|e| e.to_string())
}

/// Stops the Claude sign-in that's waiting for the browser.
static CANCEL_CLAUDE_SIGN_IN: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

/// Sign in with claude.ai: the browser opens Claude's consent page and
/// `claude:auth` tells Settings its address (to open it again). Answers the
/// account's email once the user has allowed Paw.
#[tauri::command]
pub async fn paw_claude_sign_in(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;
    let (tx, rx) = oneshot::channel();
    // A sign-in already waiting ends (its sender is dropped).
    *CANCEL_CLAUDE_SIGN_IN.lock().unwrap() = Some(tx);
    let show = move |url: String| {
        let _ = std::process::Command::new("/usr/bin/open").arg(&url).spawn();
        let _ = app.emit("claude:auth", url);
    };
    tokio::select! {
        r = claude::sign_in(show) => r,
        _ = rx => Err("Sign-in cancelled.".into()),
    }
}

#[tauri::command]
pub async fn paw_claude_cancel_sign_in() -> Result<(), String> {
    CANCEL_CLAUDE_SIGN_IN.lock().unwrap().take();
    Ok(())
}

#[tauri::command]
pub async fn paw_claude_sign_out() -> Result<(), String> {
    claude::sign_out().await
}

/// Paw's ChatGPT sign-in (never a token).
#[tauri::command]
pub async fn paw_chatgpt_status() -> Result<chatgpt::Status, String> {
    tauri::async_runtime::spawn_blocking(chatgpt::status).await.map_err(|e| e.to_string())
}

/// Stops the ChatGPT sign-in that's waiting for the browser.
static CANCEL_CHATGPT_SIGN_IN: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

/// Sign in with ChatGPT: the browser opens OpenAI's sign-in page and
/// `chatgpt:auth` tells Settings its address (to open it again); when that
/// can't be used, `chatgpt:device` tells the code to enter on OpenAI's
/// device page. Answers the account's email ("" when unknown).
#[tauri::command]
pub async fn paw_chatgpt_sign_in(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;
    let (tx, rx) = oneshot::channel();
    // A sign-in already waiting ends (its sender is dropped).
    *CANCEL_CHATGPT_SIGN_IN.lock().unwrap() = Some(tx);
    let app2 = app.clone();
    let page = move |url: String, opened: bool| {
        if !opened {
            let _ = std::process::Command::new("/usr/bin/open").arg(&url).spawn();
        }
        let _ = app.emit("chatgpt:auth", json!({ "url": url }));
    };
    let code = move |device: copilot::DeviceCode| {
        let _ = std::process::Command::new("/usr/bin/open").arg(&device.uri).spawn();
        let _ = app2.emit("chatgpt:device", device);
    };
    tokio::select! {
        r = chatgpt::sign_in(page, code) => r,
        _ = rx => Err("Sign-in cancelled.".into()),
    }
}

#[tauri::command]
pub async fn paw_chatgpt_cancel_sign_in() -> Result<(), String> {
    CANCEL_CHATGPT_SIGN_IN.lock().unwrap().take();
    Ok(())
}

#[tauri::command]
pub async fn paw_chatgpt_sign_out() -> Result<(), String> {
    chatgpt::sign_out().await
}

/// Stops the OpenRouter sign-in that's waiting for the browser.
static CANCEL_OPENROUTER_SIGN_IN: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

/// Sign in with OpenRouter: the browser opens openrouter.ai and
/// `openrouter:auth` tells Settings its address (to open it again). The key
/// OpenRouter makes for Paw is saved as the `openrouter` key; signing out
/// is `paw_key_delete("openrouter")`.
#[tauri::command]
pub async fn paw_openrouter_sign_in(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    let (tx, rx) = oneshot::channel();
    // A sign-in already waiting ends (its sender is dropped).
    *CANCEL_OPENROUTER_SIGN_IN.lock().unwrap() = Some(tx);
    let show = move |url: String| {
        let _ = std::process::Command::new("/usr/bin/open").arg(&url).spawn();
        let _ = app.emit("openrouter:auth", json!({ "url": url }));
    };
    tokio::select! {
        r = openrouter::sign_in(show) => r,
        _ = rx => Err("Sign-in cancelled.".into()),
    }
}

#[tauri::command]
pub async fn paw_openrouter_cancel_sign_in() -> Result<(), String> {
    CANCEL_OPENROUTER_SIGN_IN.lock().unwrap().take();
    Ok(())
}

pub mod auto;
pub mod sandbox;
pub mod chatgpt;
pub mod claude;
pub mod compatible;
pub mod copilot;
pub mod keys;
pub mod oauth;
pub mod openrouter;

#[cfg(test)]
mod tests;
