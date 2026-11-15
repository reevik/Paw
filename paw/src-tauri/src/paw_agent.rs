//! Paw Agent: Paw's own coding agent, running inside the Paw process on
//! Rig (`rig-agent`'s multi-turn tool loop, `rig-tools`' coding tools).
//!
//! One session per tab. A session is a model (Ollama or Anthropic), a system
//! prompt, the tools (read, write, edit, search, list, shell) working in the
//! tab's folder, and the conversation so far, which is saved after every
//! prompt so a restarted Paw continues it.
//!
//! The session talks to the UI with the same events an agent process uses:
//! `agent:status` (an `AgentInfo`) and `agent:output` lines whose text is a
//! Claude Code stream-json event (`system` init, `assistant` text, thinking
//! and tool_use, `user` tool_result, `result`), so the transcript renders,
//! groups and folds them like Claude Code's. Two events are its own:
//! `paw:delta` (the text the model is writing, as it streams) and
//! `paw:approval` (a tool call that waits for the user).
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

/// Where a session's events go: the webview, or a test.
pub trait Sink: Send + Sync + 'static {
    /// An `agent:output` line ("stdout" lines carry stream-json events).
    fn line(&self, id: u32, stream: &'static str, text: String);
    /// The assistant text written so far in the current part ("" clears it).
    fn delta(&self, id: u32, text: &str);
    fn approval(&self, req: &ApprovalRequest);
    fn status(&self, info: &AgentInfo);
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

    /// Auto mode's reviewer: one short call to the tab's model about an
    /// action the rules couldn't decide. `None` allows it; otherwise the
    /// reason to ask the user.
    async fn review(&self, ask: &Ask) -> Option<String> {
        use futures::StreamExt;
        let request = self.request.lock().unwrap().clone();
        let preamble = auto::REVIEWER.replace("{cwd}", &self.cfg.cwd.display().to_string());
        let mut b = AgentBuilder::new(self.model.clone()).name("Paw auto review").preamble(preamble);
        if self.cfg.provider == "anthropic" {
            b = b.max_tokens(400);
        } else {
            use rig_core::providers::ollama::extension::{KeepAlive, OllamaOptions};
            b = b.provider_option(OllamaOptions::default().num_ctx(OLLAMA_NUM_CTX).keep_alive(KeepAlive::duration("30m")));
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
        if self.cfg.provider == "anthropic" {
            b = b.max_tokens(16_000);
        } else {
            use rig_core::providers::ollama::extension::{KeepAlive, OllamaOptions};
            b = b.provider_option(OllamaOptions::default().num_ctx(OLLAMA_NUM_CTX).keep_alive(KeepAlive::duration("30m")));
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
            b = b
                .tool(Read { workspace: ws.clone(), base: base.clone(), confine: false, seen: self.seen.clone() })
                .tool(Edit { workspace: ws.clone(), base: base.clone(), confine: false, seen: self.seen.clone() })
                .tool(Write { workspace: ws.clone(), base: base.clone(), confine: false, seen: self.seen.clone() })
                .tool(Search { workspace: ws.clone(), base: base.clone(), confine: false })
                .tool(List { workspace: ws.clone(), base, confine: false })
                .tool(Shell { workspace: ws, launcher, live: None, spill: None, cut: Some(OutputLimit::default()), confine: false })
                .add_hook(GateHook { sess: self.clone() });
            let mcp: Vec<rig_core::tool::DynamicTool> =
                self.cfg.mcp.tools.iter().cloned().filter_map(|t| rig_core::tool::DynamicTool::try_from(t).ok()).collect();
            if !mcp.is_empty() {
                b = b.dynamic_tools(mcp);
            }
        }
        b.build()
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
        let args: Value = ev.tool_args().and_then(|a| serde_json::from_str(a).ok()).unwrap_or(Value::Null);
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
            Gate::Ask(mut ask) if auto => match auto::check(&tool, &args, &self.sess.cfg.cwd, self.sess.cfg.scripts.as_deref()) {
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
    // Approvals still open belong to this turn.
    sess.pending.lock().unwrap().clear();
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
    if cfg.provider == "anthropic" && (lower.contains("401") || lower.contains("authentication") || lower.contains("invalid x-api-key")) {
        return format!("Anthropic didn't accept the API key — check it in Settings › Agents › Paw Agent.\n{e}");
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
            cancel: Mutex::default(),
            seen: Seen::default(),
            sink: sink.clone(),
            info: Mutex::new(info.clone()),
            closed: AtomicBool::new(false),
            model,
            cfg,
        });
        self.sessions.lock().unwrap().insert(id, sess.clone());
        let tools: Vec<&str> = if sess.cfg.tools { vec!["read", "edit", "write", "search", "list", "shell"] } else { vec![] };
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

fn provider_label(p: &str) -> &'static str {
    match p {
        "anthropic" => "Anthropic",
        _ => "Ollama",
    }
}

// ---------------------------------------------------------------------------
// Models, system prompt, Keychain
// ---------------------------------------------------------------------------

pub const ANTHROPIC_MODELS: &[&str] = &["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-2"];
pub const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";

/// The model for a provider. A model written `anthropic/<name>` or
/// `ollama/<name>` picks that provider whatever the agent's setting.
pub fn split_provider<'a>(provider: &'a str, model: &'a str) -> (&'a str, &'a str) {
    for p in ["anthropic", "ollama"] {
        if let Some(rest) = model.strip_prefix(p).and_then(|r| r.strip_prefix('/')) {
            return (p, rest);
        }
    }
    (if provider == "anthropic" { "anthropic" } else { "ollama" }, model)
}

/// The Anthropic configuration for a credential: `x-api-key`, or a
/// gateway's auth token as `Authorization: Bearer`.
pub fn anthropic_config(cred: &keys::Credential, base_url: &str) -> rig_core::providers::anthropic::AnthropicConfig {
    use rig_core::providers::anthropic::{wire::Auth, AnthropicConfig, ANTHROPIC};
    let mut cfg = if cred.bearer {
        let mut dialect = ANTHROPIC;
        dialect.quirks.auth = Auth::OptionalBearer;
        AnthropicConfig::with_key(&dialect, cred.secret.clone())
    } else {
        AnthropicConfig::new(cred.secret.clone())
    };
    if !base_url.trim().is_empty() {
        cfg = cfg.with_base_url(base_url.trim());
    }
    cfg
}

pub fn make_model(provider: &str, model: &str, base_url: &str, cred: Option<keys::Credential>) -> Result<DynModel<Completion>, String> {
    match provider {
        "anthropic" => {
            let cred = cred.filter(|c| !c.secret.is_empty()).ok_or(
                "No Anthropic API key yet — add one in Settings › Agents › Paw Agent (it's kept in your Keychain).",
            )?;
            Ok(anthropic_config(&cred, base_url).client().completion(model).into())
        }
        _ => {
            use rig_core::providers::ollama::OllamaConfig;
            let mut cfg = OllamaConfig::new();
            if !base_url.trim().is_empty() {
                cfg = cfg.with_base_url(base_url.trim());
            }
            Ok(cfg.client().native_completion(model).into())
        }
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

pub fn build_preamble(cwd: &Path, level: &str, tools: bool, skills_index: &str, scripts: Option<&Path>) -> String {
    let mut p = String::new();
    p.push_str("You are Paw Agent, a coding agent built into Paw, a macOS app where people work with coding agents in terminal-like tabs.\n\n");
    p.push_str(&format!("Working folder: {}\nRelative paths are resolved there; the shell tool runs commands there.\n", cwd.display()));
    if let (true, Some(dir)) = (tools, scripts) {
        p.push_str(&format!("{}\n", scripts_note(dir)));
    }
    if tools {
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
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    fn account(provider: &str) -> String {
        format!("{provider}-api-key")
    }

    fn read(service: &str, provider: &str) -> Option<String> {
        get_generic_password(service, &account(provider))
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .filter(|s| !s.is_empty())
    }

    /// The saved key; one saved before the rename (Hive → Paw) is moved over.
    pub fn get(provider: &str) -> Option<String> {
        if let Some(k) = read(crate::paths::keychain_service(), provider) {
            return Some(k);
        }
        let old = read(crate::paths::legacy_keychain_service(), provider)?;
        if set(provider, &old).is_ok() {
            let _ = delete_generic_password(crate::paths::legacy_keychain_service(), &account(provider));
        }
        Some(old)
    }

    pub fn set(provider: &str, key: &str) -> Result<(), String> {
        set_generic_password(crate::paths::keychain_service(), &account(provider), key.as_bytes()).map_err(|e| e.to_string())
    }

    pub fn delete(provider: &str) -> Result<(), String> {
        let _ = delete_generic_password(crate::paths::legacy_keychain_service(), &account(provider));
        match delete_generic_password(crate::paths::keychain_service(), &account(provider)) {
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
}

fn valid_conversation_id(s: &str) -> bool {
    s.len() >= 8 && s.len() <= 64 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
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
    let model = if model.is_empty() && provider == "anthropic" { ANTHROPIC_MODELS[0].to_string() } else { model };
    if model.is_empty() {
        return Err("Paw Agent needs a model — pick one with /model (Ollama models with tool support are listed).".into());
    }
    let mut base_url = if opts.base_url.trim().is_empty() && provider == "ollama" { DEFAULT_OLLAMA_URL.to_string() } else { opts.base_url.trim().to_string() };
    let approval = if ["ask", "edits", "auto", "plan", "full"].contains(&opts.approval.as_str()) { opts.approval.clone() } else { "edits".into() };

    let conversation = opts.session.clone().filter(|s| valid_conversation_id(s)).unwrap_or_else(new_conversation_id);
    // The tab's folder (a tab from before session folders: its conversation's).
    let session_dir = crate::paths::ensure_session_dir(opts.paw_session.as_deref().filter(|s| crate::paths::valid_session_id(s)).unwrap_or(&conversation)).ok();
    let scripts = session_dir.as_ref().map(|d| d.join("scripts"));
    let app2 = app.clone();
    let scripts2 = scripts.clone();
    let (cwd2, provider2, model2, base2, approval2, source2) =
        (cwd.clone(), provider.clone(), model.clone(), base_url.clone(), approval.clone(), opts.key_source.clone());
    // Keys, `ollama show` and the skill folders: off the async threads.
    let (cred, tools, preamble) = tauri::async_runtime::spawn_blocking(move || {
        let cred = (provider2 == "anthropic").then(|| keys::resolve(&keys::System, &source2)).transpose()?;
        let tools = provider2 == "anthropic" || ollama_supports_tools(&base2, &model2).unwrap_or(true);
        let skills = crate::skills::agent_skills_index(&app2, &cwd2);
        Ok::<_, String>((cred, tools, build_preamble(&cwd2, &approval2, tools, &skills, scripts2.as_deref())))
    })
    .await
    .map_err(|e| e.to_string())??;
    // The agent's own address wins; else the one that came with the key.
    if base_url.is_empty() {
        if let Some(b) = cred.as_ref().and_then(|c| c.base_url.clone()) {
            base_url = b;
        }
    }
    let model_handle = make_model(&provider, &model, &base_url, cred)?;
    // Paw Agent's MCP servers (Settings-free: the MCP panel keeps the list).
    let path_env = crate::registry::login_path().to_string();
    let mcp = if tools {
        let servers = crate::mcp::paw_servers(crate::paths::config_dir(&app).as_deref());
        crate::mcp::connect_all(&servers, &cwd, Some(&path_env)).await
    } else {
        crate::mcp::McpSetup::default()
    };

    let history_path = session_dir.as_ref().map(|d| d.join("conversations").join(format!("{conversation}.json")));
    // Continuing a conversation kept in another tab's folder (or the old
    // shared folder): it moves here.
    if let (Some(path), Some(home)) = (&history_path, crate::paths::home()) {
        if !path.exists() {
            let elsewhere = [
                crate::paths::session_dir_in(&home, &conversation).map(|d| d.join("conversations").join(format!("{conversation}.json"))),
                Some(home.join("paw-agent").join(format!("{conversation}.json"))),
            ];
            if let Some(old) = elsewhere.into_iter().flatten().find(|p| p.is_file()) {
                let _ = std::fs::rename(old, path);
            }
        }
    }
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

/// Which providers have an API key in the Keychain (never the key itself).
#[tauri::command]
pub async fn paw_key_status() -> Result<HashMap<String, bool>, String> {
    tauri::async_runtime::spawn_blocking(|| HashMap::from([("anthropic".to_string(), keychain::get("anthropic").is_some())]))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn paw_key_set(provider: String, key: String) -> Result<(), String> {
    if provider != "anthropic" {
        return Err("Only Anthropic uses an API key".into());
    }
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("The key is empty".into());
    }
    tauri::async_runtime::spawn_blocking(move || keychain::set(&provider, &key)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn paw_key_delete(provider: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || keychain::delete(&provider)).await.map_err(|e| e.to_string())?
}

pub mod auto;
pub mod keys;

#[cfg(test)]
mod tests;
