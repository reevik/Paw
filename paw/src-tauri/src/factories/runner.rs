//! Runs factories in the background process: no window needed.
//!
//! A run keeps a copy of its factory and the state of each node. `pump` starts
//! every node whose inputs are ready (within "Agents at once" and one node
//! changing files at a time), skips the ones whose branch wasn't taken, and
//! notices the end. Agent nodes are Paw Agent sessions started here; their
//! output (`agent:output`) and approval requests (`paw:approval`) come back
//! through the app's events. Wait nodes run their command until it succeeds.
//!
//! Every change goes to windows as a `factory:run` event (the whole run).
//! Each run (an execution) has a UUID and a folder of its own,
//! `~/.paw/factories/<factory-id>/<execution-id>/`: `run.json` (kept while it
//! runs, so a restart doesn't lose it) and `nodes/<node>/` with each agent
//! node's conversations, scripts and files. A factory can have several runs
//! going at once, each in its own project folder.

use super::*;
use crate::paw_agent::{PawAgents, StartOpts};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Listener, Manager};

const LOG_LINES: usize = 120;
const LOG_CHARS: usize = 300;
const RESULT_CHARS: usize = 20_000;
const INPUT_BUDGET: usize = 8_000;
const RUNS_KEPT: usize = 30; // per factory
const CHECK_LIMIT: Duration = Duration::from_secs(120); // one wait-node check
const INTERRUPTED: &str = "Paw stopped while this ran.";
const REJECTED: &str = "Rejected by you";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogLine {
    pub kind: String,
    pub text: String,
    pub ts: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NodeRun {
    pub id: String,
    /// waiting, running, needs (an approval), done, failed, stopped, skipped
    pub state: String,
    #[serde(default)]
    pub agent: Option<u32>,
    /// Its conversation's id (kept in the run's `nodes/<node>/`).
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub started_at: Option<u64>,
    #[serde(default)]
    pub ended_at: Option<u64>,
    #[serde(default)]
    pub result: String,
    #[serde(default)]
    pub error: Option<String>,
    /// Why it was skipped, and such.
    #[serde(default)]
    pub note: String,
    /// The approval it waits for (paw:approval's payload).
    #[serde(default)]
    pub approval: Option<Value>,
    #[serde(default)]
    pub log: Vec<LogLine>,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    /// A wait node: how many times it checked.
    #[serde(default)]
    pub checks: u32,
    /// The round it's in when it's part of a loop (1 = the first pass).
    #[serde(default)]
    pub round: u32,
    /// Its earlier rounds, for the timeline.
    #[serde(default)]
    pub rounds: Vec<Round>,
    /// What sent it back (the looping node's answer), and its own answer then.
    #[serde(default)]
    pub feedback: Option<Feedback>,
    /// A question its agent asked you (`ask_user`: request, question, choices).
    #[serde(default)]
    pub question: Option<Value>,
    /// Done, and its answer waits for your approval (`approve: true`).
    #[serde(default)]
    pub gate: bool,
    #[serde(skip)]
    last_answer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Round {
    pub round: u32,
    pub state: String,
    pub started_at: Option<u64>,
    pub ended_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Feedback {
    /// The node whose loop sent the run back.
    pub from: String,
    pub round: u32,
    pub text: String,
    /// This node's own answer in that round.
    pub previous: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Run {
    /// The execution id (a UUID; older runs have shorter ids).
    pub id: String,
    /// The factory's id (its file name).
    pub factory: String,
    /// The project folder this run works in (empty: the factory's `folder`).
    #[serde(default)]
    pub folder: String,
    /// The factory as it was when the run started.
    pub def: Factory,
    /// What started it: "manual", or the trigger.
    pub trigger: String,
    #[serde(default)]
    pub payload: Option<String>,
    /// running, done, failed, stopped
    pub state: String,
    pub started_at: u64,
    #[serde(default)]
    pub ended_at: Option<u64>,
    #[serde(default)]
    pub note: String,
    pub nodes: Vec<NodeRun>,
}

impl Run {
    fn node(&self, id: &str) -> Option<&NodeRun> {
        self.nodes.iter().find(|n| n.id == id)
    }
    fn node_mut(&mut self, id: &str) -> Option<&mut NodeRun> {
        self.nodes.iter_mut().find(|n| n.id == id)
    }
    fn def_node(&self, id: &str) -> Option<&Node> {
        self.def.nodes.iter().find(|n| n.id == id)
    }
    /// Without the nodes' logs (for lists).
    fn summary(&self) -> Run {
        let mut r = self.clone();
        for n in &mut r.nodes {
            n.log.clear();
        }
        r
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// A random (version 4) UUID.
fn uuid_v4() -> String {
    use ring::rand::SecureRandom;
    let mut b = [0u8; 16];
    if ring::rand::SystemRandom::new().fill(&mut b).is_err() {
        // No randomness: time and a counter still make it unique here.
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        b[..8].copy_from_slice(&(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()) as u64).to_be_bytes());
        b[8..].copy_from_slice(&N.fetch_add(1, std::sync::atomic::Ordering::Relaxed).to_be_bytes());
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

fn new_id(prefix: &str) -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    format!("{prefix}{:08x}", h.finish() as u32)
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let mut out: String = s.chars().take(n).collect();
    out.push('…');
    out
}

/// The end of a long text (that's where an answer sums up).
fn clip_end(s: &str, n: usize) -> String {
    let count = s.chars().count();
    if count <= n {
        return s.to_string();
    }
    format!("…{}", s.chars().skip(count - n).collect::<String>())
}

fn log(node: &mut NodeRun, kind: &str, text: &str) {
    let text = clip(text.trim(), LOG_CHARS);
    if text.is_empty() {
        return;
    }
    node.log.push(LogLine { kind: kind.into(), text, ts: now_ms() });
    if node.log.len() > LOG_LINES {
        let extra = node.log.len() - LOG_LINES;
        node.log.drain(..extra);
    }
}

fn finished(state: &str) -> bool {
    state == "done" || state == "skipped"
}

fn active(state: &str) -> bool {
    state == "running" || state == "needs"
}

/// An agent at work: running or asking, not a finished node waiting for approval.
fn working(n: &NodeRun) -> bool {
    active(&n.state) && !n.gate
}

/// What `pump` decided to start (started outside the lock).
enum Start {
    Agent { run: String, node: String, opts: Box<StartOpts>, prompt: String, timeout: Option<Duration> },
    Wait { run: String, node: String, command: String, folder: PathBuf, env: Vec<(String, String)>, every: Duration, timeout: Option<Duration> },
}

#[derive(Default)]
struct State {
    runs: Vec<Run>,
    /// A Paw Agent session → its run and node.
    agents: HashMap<u32, (String, String)>,
    /// Runs whose latest change hasn't gone to windows yet (log lines wait a bit).
    dirty: HashSet<String>,
    flushing: bool,
}

pub struct Runner {
    app: AppHandle,
    state: Mutex<State>,
    /// Factories whose trigger (and repeat) is paused (set by `triggers`).
    paused: Mutex<HashSet<String>>,
}

/// Settings the runner reads: (agents at once, the default model). The
/// default model is Settings' one, else the one the window falls back to (its
/// first model), which the window passes along and is kept here for runs that
/// start with no window open.
fn settings() -> (usize, String) {
    let v: Value = crate::paths::home()
        .and_then(|h| std::fs::read_to_string(h.join("settings.json")).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let n = v.pointer("/general/max_agents").and_then(Value::as_u64).unwrap_or(3);
    let model = v
        .pointer("/models/default")
        .and_then(Value::as_str)
        .filter(|m| m.contains('/'))
        .map(str::to_string)
        .or_else(window_model)
        .unwrap_or_default();
    (if n == 0 { usize::MAX } else { n as usize }, model)
}

fn window_model_path() -> Option<PathBuf> {
    factories_dir().map(|d| d.join(".default-model"))
}

fn window_model() -> Option<String> {
    window_model_path().and_then(|p| std::fs::read_to_string(p).ok()).map(|s| s.trim().to_string()).filter(|m| m.contains('/'))
}

/// The model the window falls back to ("provider/model"), kept for later runs.
pub fn remember_window_model(model: Option<String>) {
    let Some(m) = model.map(|m| m.trim().to_string()).filter(|m| m.contains('/')) else { return };
    if window_model().as_deref() == Some(m.as_str()) {
        return;
    }
    if let Some(p) = window_model_path() {
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        let _ = std::fs::write(p, m);
    }
}

pub fn factories_dir() -> Option<PathBuf> {
    crate::paths::home().map(|h| dir(&h))
}

/// A run's own folder: `~/.paw/factories/<factory-id>/<execution-id>/`.
pub fn run_dir(factory: &str, run: &str) -> Option<PathBuf> {
    let ok = |s: &str| valid_id(s) || (s.len() <= 64 && !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    (ok(factory) && ok(run)).then(|| factories_dir().map(|d| d.join(factory).join(run))).flatten()
}

/// The folder a run works in: the one it was given, else its factory's.
fn folder_of(r: &Run) -> PathBuf {
    let f = if r.folder.trim().is_empty() { r.def.folder.trim() } else { r.folder.trim() };
    crate::agents::expand_home(if f.is_empty() { "~" } else { f })
}

impl Runner {
    pub fn new(app: &AppHandle) -> Arc<Runner> {
        let runner = Arc::new(Runner { app: app.clone(), state: Mutex::new(State { runs: load_runs(), ..Default::default() }), paused: Mutex::default() });
        // Loops go on after Paw starts again: a repeating factory whose last run
        // finished, or was cut off when Paw stopped, starts again (not one that
        // failed or that you stopped). A moment later, once pauses are known.
        // Each project folder's loop goes on, with its run's payload.
        let resume: Vec<(String, String, Option<String>)> = {
            let st = runner.state.lock().unwrap();
            let mut latest: HashMap<(&str, &str), &Run> = HashMap::new();
            for r in &st.runs {
                let k = (r.factory.as_str(), r.folder.as_str());
                if latest.get(&k).is_none_or(|l| l.started_at < r.started_at) {
                    latest.insert(k, r);
                }
            }
            latest.values().filter(|r| r.state == "done" || r.note == INTERRUPTED).map(|r| (r.factory.clone(), r.folder.clone(), r.payload.clone())).collect()
        };
        let r = runner.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            for (f, folder, payload) in resume {
                let repeats = factory_file(&f).and_then(|p| load(&f, &p).factory).is_some_and(|d| repeat_of(&d).is_some());
                if repeats && !r.is_paused(&f) && !r.running_in(&f, &folder) {
                    let _ = r.start(&f, "repeat", payload, Some(folder).filter(|s| !s.is_empty()));
                }
            }
        });
        let r = runner.clone();
        app.listen_any("agent:output", move |e| {
            if let Ok(v) = serde_json::from_str::<Value>(e.payload()) {
                if let (Some(id), Some(stream), Some(text)) = (v["id"].as_u64(), v["stream"].as_str(), v["text"].as_str()) {
                    r.on_output(id as u32, stream, text);
                }
            }
        });
        let r = runner.clone();
        app.listen_any("paw:approval", move |e| {
            if let Ok(v) = serde_json::from_str::<Value>(e.payload()) {
                if let Some(id) = v["id"].as_u64() {
                    r.on_approval(id as u32, v);
                }
            }
        });
        let r = runner.clone();
        app.listen_any("paw:question", move |e| {
            if let Ok(v) = serde_json::from_str::<Value>(e.payload()) {
                if let Some(id) = v["id"].as_u64() {
                    r.on_question(id as u32, v);
                }
            }
        });
        runner
    }

    /// Your answer to a node's question: it goes back to its agent, which goes on.
    pub fn answer(self: &Arc<Self>, run: &str, node: &str, text: &str) -> Result<(), String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("Write an answer.".into());
        }
        let (agent, request) = {
            let st = self.state.lock().unwrap();
            let n = st.runs.iter().find(|r| r.id == run).and_then(|r| r.node(node)).ok_or("No such node.")?;
            let q = n.question.as_ref().ok_or("That node isn't asking anything now.")?;
            (n.agent.ok_or("That node's agent has ended.")?, q["request"].as_u64().ok_or("That question can't be answered.")?)
        };
        self.app.state::<PawAgents>().answer(agent, request, text.to_string())?;
        {
            let mut st = self.state.lock().unwrap();
            if let Some(n) = st.runs.iter_mut().find(|r| r.id == run).and_then(|r| r.node_mut(node)) {
                n.question = None;
                if n.state == "needs" && n.approval.is_none() {
                    n.state = "running".into();
                }
                log(n, "you", &clip(text, LOG_CHARS));
            }
        }
        self.changed(run, true);
        Ok(())
    }

    /// Your decision on a node's answer (`approve: true`): approve it (as you
    /// may have edited it), or reject it with feedback: another round when the
    /// node has a loop, else the run stops.
    pub fn decide(self: &Arc<Self>, run: &str, node: &str, approve: bool, text: Option<String>) -> Result<(), String> {
        {
            let mut st = self.state.lock().unwrap();
            let r = st.runs.iter_mut().find(|r| r.id == run).ok_or("No such run.")?;
            decide_in(r, node, approve, text)?;
        }
        self.pump_all();
        Ok(())
    }

    /// The factory files and the runs (without logs).
    pub fn list(&self) -> Value {
        let dir = factories_dir();
        let found = dir.as_deref().map(load_all).unwrap_or_default();
        let st = self.state.lock().unwrap();
        let runs: Vec<Run> = st.runs.iter().rev().map(Run::summary).collect();
        json!({ "dir": dir, "factories": found, "runs": runs })
    }

    pub fn set_paused(&self, factory: &str, paused: bool) {
        let mut p = self.paused.lock().unwrap();
        if paused {
            p.insert(factory.to_string());
        } else {
            p.remove(factory);
        }
    }

    fn is_paused(&self, factory: &str) -> bool {
        self.paused.lock().unwrap().contains(factory)
    }

    /// How many runs of this factory are going.
    pub fn running(&self, factory: &str) -> usize {
        self.state.lock().unwrap().runs.iter().filter(|r| r.factory == factory && active_run(r)).count()
    }

    /// Is a run of this factory going in this project folder ("" : its own)?
    pub fn running_in(&self, factory: &str, folder: &str) -> bool {
        self.state.lock().unwrap().runs.iter().any(|r| r.factory == factory && active_run(r) && r.folder == folder)
    }

    /// A node's conversations (one per round, oldest first) as the lines a tab shows.
    pub fn conversation(&self, run: &str, node: &str) -> Result<Vec<Vec<String>>, String> {
        let factory = self.get(run).map(|r| r.factory).ok_or("No such run.")?;
        let dir = run_dir(&factory, run).ok_or("No such run.")?.join("nodes").join(node).join("conversations");
        let mut files: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .map(|p| (std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), p))
            .collect();
        files.sort();
        Ok(files.iter().map(|(_, p)| crate::paw_agent::conversation_lines(p)).collect())
    }

    pub fn get(&self, run: &str) -> Option<Run> {
        self.state.lock().unwrap().runs.iter().find(|r| r.id == run).cloned()
    }

    /// Start a run of a factory (by its id, the file name), in its own folder
    /// or in `folder` (another project); its execution id.
    pub fn start(self: &Arc<Self>, factory: &str, trigger: &str, payload: Option<String>, folder: Option<String>) -> Result<String, String> {
        factories_dir().ok_or("Paw can't find its folder (~/.paw).")?;
        let path = factory_file(factory).ok_or(format!("There's no factory “{factory}”."))?;
        let found = load(factory, &path);
        let def = found.factory.ok_or_else(|| format!("{factory}.yaml: {}", found.error.unwrap_or_default()))?;
        let folder = folder.map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).unwrap_or_default();
        let run = Run {
            id: uuid_v4(),
            factory: factory.to_string(),
            folder,
            nodes: def.nodes.iter().map(|n| NodeRun { id: n.id.clone(), state: "waiting".into(), ..Default::default() }).collect(),
            def,
            trigger: trigger.to_string(),
            payload,
            state: "running".into(),
            started_at: now_ms(),
            ended_at: None,
            note: String::new(),
        };
        if !folder_of(&run).is_dir() {
            return Err(format!("The folder doesn't exist: {}", if run.folder.is_empty() { &run.def.folder } else { &run.folder }));
        }
        let id = run.id.clone();
        {
            let mut st = self.state.lock().unwrap();
            st.runs.push(run);
            // Keep the last few runs of each factory.
            let mine: Vec<usize> = st.runs.iter().enumerate().filter(|(_, r)| r.factory == factory && !active_run(r)).map(|(i, _)| i).collect();
            if mine.len() > RUNS_KEPT {
                let old: Vec<String> = mine[..mine.len() - RUNS_KEPT].iter().map(|&i| st.runs[i].id.clone()).collect();
                st.runs.retain(|r| !old.contains(&r.id));
                for o in old {
                    if let Some(d) = run_dir(factory, &o) {
                        let _ = std::fs::remove_dir_all(d);
                    }
                }
            }
        }
        self.pump_all();
        Ok(id)
    }

    pub fn stop(self: &Arc<Self>, run: &str) -> Result<(), String> {
        let agents = {
            let mut st = self.state.lock().unwrap();
            let r = st.runs.iter_mut().find(|r| r.id == run).ok_or("No such run.")?;
            if !active_run(r) {
                return Ok(());
            }
            r.state = "stopped".into();
            r.ended_at = Some(now_ms());
            let mut agents = vec![];
            for n in &mut r.nodes {
                if active(&n.state) {
                    n.state = "stopped".into();
                    n.ended_at = Some(now_ms());
                    n.approval = None;
                    agents.extend(n.agent);
                }
            }
            for a in &agents {
                st.agents.remove(a);
            }
            agents
        };
        let paw = self.app.state::<PawAgents>();
        for a in agents {
            paw.cancel(a);
            paw.close(a);
        }
        self.changed(run, true);
        self.pump_all(); // others may start now
        Ok(())
    }

    /// Run a failed or stopped node again (and the run, if it ended).
    pub fn retry(self: &Arc<Self>, run: &str, node: &str) -> Result<(), String> {
        self.reset(run, node, |n| {
            n.state = "waiting".into();
            n.error = None;
            n.result.clear();
            n.note.clear();
        })
    }

    /// Mark a node skipped: the nodes after it go on without it.
    pub fn skip(self: &Arc<Self>, run: &str, node: &str) -> Result<(), String> {
        self.reset(run, node, |n| {
            n.state = "skipped".into();
            n.note = "Skipped by you.".into();
            n.result = "(This node was skipped.)".into();
            n.ended_at = Some(now_ms());
        })
    }

    fn reset(self: &Arc<Self>, run: &str, node: &str, f: impl FnOnce(&mut NodeRun)) -> Result<(), String> {
        {
            let mut st = self.state.lock().unwrap();
            let r = st.runs.iter_mut().find(|r| r.id == run).ok_or("No such run.")?;
            let n = r.node_mut(node).ok_or("No such node.")?;
            if working(n) {
                return Err("That node is running; stop the run first.".into());
            }
            n.gate = false;
            n.question = None;
            f(n);
            r.state = "running".into();
            r.ended_at = None;
            r.note.clear();
        }
        self.pump_all();
        Ok(())
    }

    // ---------- the pump ----------

    fn pump_all(self: &Arc<Self>) {
        let (limit, default_model) = settings();
        let starts = {
            let mut st = self.state.lock().unwrap();
            // Agent nodes at work (or starting) in every run count against the limit.
            let mut busy = st.runs.iter().flat_map(|r| r.nodes.iter().zip(&r.def.nodes)).filter(|(n, d)| working(n) && !d.is_wait()).count();
            // Folders a node is changing files in: one such node per folder at a time.
            let mut editing: HashSet<PathBuf> = st
                .runs
                .iter()
                .filter(|r| r.nodes.iter().zip(&r.def.nodes).any(|(n, d)| working(n) && d.edits && !d.is_wait()))
                .map(folder_of)
                .collect();
            let mut starts = vec![];
            let mut repeats = vec![];
            let ids: Vec<String> = st.runs.iter().filter(|r| r.state == "running").map(|r| r.id.clone()).collect();
            for id in ids {
                let r = st.runs.iter_mut().find(|r| r.id == id).unwrap();
                starts.extend(pump_in(r, limit, &mut busy, &mut editing, &default_model));
                // A run that just ended: a repeating factory starts again.
                if let Some((after, on_failure)) = repeat_of(&r.def).filter(|_| r.state == "done" || r.state == "failed") {
                    if r.state == "done" || on_failure {
                        let when = format!("The next run starts in {}.", fmt_duration(after));
                        r.note = if r.note.is_empty() { when } else { format!("{} {when}", r.note) };
                        repeats.push((r.factory.clone(), r.folder.clone(), r.payload.clone(), after));
                    } else {
                        r.note = format!("{} It repeats, but stops after a failed run: fix it and press Run now.", r.note).trim().to_string();
                    }
                }
                st.dirty.insert(id);
            }
            (starts, repeats)
        };
        let (starts, repeats) = starts;
        for s in starts {
            self.launch(s);
        }
        for (factory, folder, payload, after) in repeats {
            let me = self.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(after).await;
                // Paused meanwhile, or going again in this folder (Run now): nothing to do.
                if me.is_paused(&factory) || me.running_in(&factory, &folder) {
                    return;
                }
                if let Err(e) = me.start(&factory, "repeat", payload, Some(folder).filter(|f| !f.is_empty())) {
                    eprintln!("Paw: factory {factory} couldn't start again: {e}");
                }
            });
        }
        self.flush(true);
    }

    fn launch(self: &Arc<Self>, s: Start) {
        let me = self.clone();
        match s {
            Start::Agent { run, node, opts, prompt, timeout } => {
                tauri::async_runtime::spawn(async move {
                    me.app.state::<crate::registry::Registry>().forget();
                    let app = me.app.clone();
                    let started = crate::paw_agent::paw_agent_start(app.clone(), app.state(), app.state(), *opts).await;
                    let id = match started {
                        Ok(reply) => reply.info.id,
                        Err(e) => return me.node_ended(&run, &node, Err(e), false),
                    };
                    let still = {
                        let mut st = me.state.lock().unwrap();
                        let ok = st.runs.iter_mut().find(|r| r.id == run).and_then(|r| r.node_mut(&node)).filter(|n| n.state == "running").map(|n| n.agent = Some(id)).is_some();
                        if ok {
                            st.agents.insert(id, (run.clone(), node.clone()));
                        }
                        ok
                    };
                    let paw = app.state::<PawAgents>();
                    if !still {
                        paw.close(id); // stopped while it was starting
                        return;
                    }
                    match paw.send(id, prompt) {
                        Ok(turn) => {
                            tauri::async_runtime::spawn(turn);
                        }
                        Err(e) => return me.node_ended(&run, &node, Err(e), false),
                    }
                    if let Some(t) = timeout {
                        tokio::time::sleep(t).await;
                        let late = me.state.lock().unwrap().agents.contains_key(&id);
                        if late {
                            app.state::<PawAgents>().cancel(id);
                            me.node_ended(&run, &node, Err(format!("It took longer than its timeout ({}s).", t.as_secs())), false);
                        }
                    }
                });
            }
            Start::Wait { run, node, command, folder, env, every, timeout } => {
                tauri::async_runtime::spawn(async move {
                    let deadline = timeout.map(|t| Instant::now() + t);
                    loop {
                        if !me.is_running(&run, &node) {
                            return;
                        }
                        let (cmd, dir, env) = (command.clone(), folder.clone(), env.clone());
                        let out = tauri::async_runtime::spawn_blocking(move || check_with(&cmd, &dir, &env)).await.unwrap_or_else(|e| (false, e.to_string()));
                        if !me.is_running(&run, &node) {
                            return;
                        }
                        {
                            let mut st = me.state.lock().unwrap();
                            if let Some(n) = st.runs.iter_mut().find(|r| r.id == run).and_then(|r| r.node_mut(&node)) {
                                n.checks += 1;
                                let last = out.1.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
                                let msg = format!("Check {}: {}{}", n.checks, if out.0 { "yes" } else { "not yet" }, if last.is_empty() { String::new() } else { format!(" · {last}") });
                                log(n, "check", &msg);
                            }
                            st.dirty.insert(run.clone());
                        }
                        me.flush(false);
                        if out.0 {
                            return me.node_ended(&run, &node, Ok(clip_end(out.1.trim(), RESULT_CHARS)), false);
                        }
                        if deadline.is_some_and(|d| Instant::now() + every > d) {
                            return me.node_ended(&run, &node, Err(format!("It still wasn't true after {}.", fmt_duration(timeout.unwrap()))), false);
                        }
                        tokio::time::sleep(every).await;
                    }
                });
            }
        }
    }

    fn is_running(&self, run: &str, node: &str) -> bool {
        let st = self.state.lock().unwrap();
        st.runs.iter().find(|r| r.id == run).and_then(|r| r.node(node)).is_some_and(|n| n.state == "running")
    }

    /// A node's turn (or wait) ended: its answer, or what went wrong.
    fn node_ended(self: &Arc<Self>, run: &str, node: &str, result: Result<String, String>, stopped: bool) {
        let agent = {
            let mut st = self.state.lock().unwrap();
            let Some(r) = st.runs.iter_mut().find(|r| r.id == run) else { return };
            let Some(n) = r.node_mut(node) else { return };
            if !active(&n.state) {
                return;
            }
            n.ended_at = Some(now_ms());
            n.approval = None;
            match (result, stopped) {
                (_, true) => n.state = "stopped".into(),
                (Ok(text), _) => {
                    n.state = "done".into();
                    n.result = clip_end(text.trim(), RESULT_CHARS);
                }
                (Err(e), _) => {
                    n.state = "failed".into();
                    n.error = Some(clip(&e, 2000));
                }
            }
            let agent = n.agent;
            n.question = None;
            // A node with a loop: go on, or send the run back for another round.
            loop_back(r, node);
            // A node you approve: its answer waits for you.
            gate(r, node);
            if r.node(node).is_some_and(|n| n.gate) {
                notify(&who(r, node), "Done: its answer waits for your approval.");
            }
            if let Some(a) = agent {
                st.agents.remove(&a);
            }
            agent
        };
        // The node's session is done: its MCP servers and such can go.
        if let Some(a) = agent {
            self.app.state::<PawAgents>().close(a);
        }
        self.changed(run, true);
        self.pump_all();
    }

    // ---------- events from the nodes' sessions ----------

    fn on_output(self: &Arc<Self>, id: u32, stream: &str, text: &str) {
        let mut ended = None;
        let run = {
            let mut st = self.state.lock().unwrap();
            let Some((run, node)) = st.agents.get(&id).cloned() else { return };
            let Some(n) = st.runs.iter_mut().find(|r| r.id == run).and_then(|r| r.node_mut(&node)) else { return };
            if n.state == "needs" && n.question.is_none() && !n.gate {
                n.state = "running".into(); // its approval was answered
                n.approval = None;
            }
            match stream {
                "stdout" => {
                    let v: Value = serde_json::from_str(text).unwrap_or(Value::Null);
                    match v["type"].as_str() {
                        Some("assistant") => {
                            let parts = v.pointer("/message/content").and_then(Value::as_array).cloned().unwrap_or_default();
                            let said: Vec<&str> = parts.iter().filter(|p| p["type"] == "text").filter_map(|p| p["text"].as_str()).collect();
                            if !said.is_empty() {
                                let said = said.join("\n");
                                log(n, "say", &said);
                                n.last_answer = said;
                            }
                            for p in parts.iter().filter(|p| p["type"] == "tool_use") {
                                let name = p["name"].as_str().unwrap_or("tool");
                                let input = &p["input"];
                                let what = ["command", "path", "file_path", "pattern", "query"].iter().find_map(|k| input[*k].as_str()).unwrap_or("");
                                log(n, "tool", &format!("{name} {what}"));
                            }
                        }
                        Some("progress") => {
                            n.input_tokens = v.pointer("/usage/input_tokens").and_then(Value::as_u64).unwrap_or(n.input_tokens);
                            n.output_tokens = v.pointer("/usage/output_tokens").and_then(Value::as_u64).unwrap_or(n.output_tokens);
                        }
                        Some("result") => {
                            n.input_tokens = v.pointer("/usage/input_tokens").and_then(Value::as_u64).unwrap_or(n.input_tokens);
                            n.output_tokens = v.pointer("/usage/output_tokens").and_then(Value::as_u64).unwrap_or(n.output_tokens);
                            let answer = v["result"].as_str().filter(|s| !s.trim().is_empty()).map(str::to_string).unwrap_or_else(|| n.last_answer.clone());
                            let stopped = v["stopped"].as_bool().unwrap_or(false);
                            let res = if v["is_error"].as_bool().unwrap_or(false) {
                                Err(if answer.trim().is_empty() { format!("The agent reported an error ({}).", v["subtype"].as_str().unwrap_or("error")) } else { answer })
                            } else {
                                Ok(answer)
                            };
                            ended = Some((node.clone(), res, stopped));
                        }
                        _ => {}
                    }
                }
                "stderr" => log(n, "error", text),
                "system" => log(n, "note", text),
                _ => {}
            }
            st.dirty.insert(run.clone());
            run
        };
        match ended {
            Some((node, res, stopped)) => self.node_ended(&run, &node, res, stopped),
            None => self.flush(false),
        }
    }

    fn on_approval(self: &Arc<Self>, id: u32, request: Value) {
        let run = {
            let mut st = self.state.lock().unwrap();
            let Some((run, node)) = st.agents.get(&id).cloned() else { return };
            let Some(n) = st.runs.iter_mut().find(|r| r.id == run).and_then(|r| r.node_mut(&node)) else { return };
            n.state = "needs".into();
            let what = request["label"].as_str().or(request["tool"].as_str()).unwrap_or("a tool").to_string();
            log(n, "ask", &format!("Waiting for your approval: {what}"));
            n.approval = Some(request);
            if let Some(r) = st.runs.iter().find(|r| r.id == run) {
                notify(&who(r, &node), &format!("Waiting for your approval: {what}"));
            }
            run
        };
        self.changed(&run, true);
    }

    fn on_question(self: &Arc<Self>, id: u32, q: Value) {
        let run = {
            let mut st = self.state.lock().unwrap();
            let Some((run, node)) = st.agents.get(&id).cloned() else { return };
            let Some(n) = st.runs.iter_mut().find(|r| r.id == run).and_then(|r| r.node_mut(&node)) else { return };
            n.state = "needs".into();
            log(n, "ask", &format!("Asks you: {}", q["question"].as_str().unwrap_or("")));
            n.question = Some(q.clone());
            if let Some(r) = st.runs.iter().find(|r| r.id == run) {
                notify(&who(r, &node), q["question"].as_str().unwrap_or("A question for you"));
            }
            run
        };
        self.changed(&run, true);
    }

    // ---------- telling windows, keeping history ----------

    fn changed(self: &Arc<Self>, run: &str, save: bool) {
        self.state.lock().unwrap().dirty.insert(run.to_string());
        if save {
            if let Some(r) = self.get(run) {
                save_run(&r);
            }
        }
        self.flush(true);
    }

    /// Send changed runs to windows: now, or (for log lines) a moment later.
    fn flush(self: &Arc<Self>, now: bool) {
        if !now {
            let mut st = self.state.lock().unwrap();
            if st.flushing {
                return;
            }
            st.flushing = true;
            drop(st);
            let me = self.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(400)).await;
                me.state.lock().unwrap().flushing = false;
                me.flush(true);
            });
            return;
        }
        let runs: Vec<Run> = {
            let mut st = self.state.lock().unwrap();
            let dirty: Vec<String> = st.dirty.drain().collect();
            st.runs.iter().filter(|r| dirty.contains(&r.id)).cloned().collect()
        };
        let daemon = self.app.try_state::<crate::daemon::DaemonState>();
        for r in runs {
            // Kept while it runs too, so a crash or restart doesn't lose it.
            save_run(&r);
            if let Some(d) = &daemon {
                d.server.publish("factory:run", json!({ "run": r }));
            }
        }
    }
}

fn active_run(r: &Run) -> bool {
    r.state == "running"
}

/// Decide what starts next in a run (and skip what won't run). `editing`:
/// the folders a node is changing files in (this run's own, and others').
fn pump_in(r: &mut Run, limit: usize, busy: &mut usize, editing: &mut HashSet<PathBuf>, default_model: &str) -> Vec<Start> {
    let order = topo_order(&r.def.nodes).unwrap_or_default();
    // Skips can make more nodes ready, so go round until nothing changes.
    loop {
        let mut changed = false;
        for &i in &order {
            let def = r.def.nodes[i].clone();
            if r.nodes[i].state != "waiting" {
                continue;
            }
            let needs: Vec<String> = def.needs.iter().filter_map(|n| r.node(n)).map(|n| n.state.clone()).collect();
            let skip = |r: &mut Run, why: &str| {
                let n = &mut r.nodes[i];
                n.state = "skipped".into();
                n.note = why.into();
                n.result = format!("(Skipped: {why})");
                n.ended_at = Some(now_ms());
            };
            if !needs.is_empty() && needs.iter().all(|s| s == "skipped") {
                skip(r, "the branch before it wasn't taken.");
                changed = true;
                continue;
            }
            let ready = match def.join {
                Join::All => needs.iter().all(|s| finished(s)),
                Join::Any => needs.iter().any(|s| s == "done") || needs.iter().all(|s| finished(s)),
            };
            if !ready {
                continue;
            }
            if let Some(w) = &def.when {
                let from = r.node(&w.from).cloned().unwrap_or_default();
                if from.state == "skipped" {
                    skip(r, &format!("{} was skipped.", w.from));
                    changed = true;
                    continue;
                }
                if !finished(&from.state) {
                    continue; // join: any went on before the node the condition reads
                }
                if !when_holds(w, &from.result) {
                    skip(r, &format!("{}'s answer didn't meet its condition.", w.from));
                    changed = true;
                    continue;
                }
            }
        }
        if !changed {
            break;
        }
    }
    // Start what's ready: one node changing files in a folder at a time, within Agents at once.
    let mut starts = vec![];
    let folder = folder_of(r);
    if r.nodes.iter().zip(&r.def.nodes).any(|(n, d)| working(n) && d.edits && !d.is_wait()) {
        editing.insert(folder.clone());
    }
    let dir = run_dir(&r.factory, &r.id);
    if let Some(d) = &dir {
        let _ = std::fs::create_dir_all(d.join("files"));
    }
    for &i in &order {
        let def = r.def.nodes[i].clone();
        if r.nodes[i].state != "waiting" || !ready_now(r, &def) {
            continue;
        }
        let folder = folder.clone();
        if let Some(cmd) = &def.wait {
            let n = &mut r.nodes[i];
            n.state = "running".into();
            n.started_at = Some(now_ms());
            n.ended_at = None;
            starts.push(Start::Wait {
                run: r.id.clone(),
                node: def.id.clone(),
                command: cmd.clone(),
                folder,
                // The run's own folders, for commands that read what its nodes wrote.
                env: dir.iter().flat_map(|d| [("PAW_RUN_DIR".to_string(), d.display().to_string()), ("PAW_RUN_FILES".to_string(), d.join("files").display().to_string())]).collect(),
                every: def.every.as_deref().and_then(parse_duration).unwrap_or(Duration::from_secs(30)),
                timeout: def.timeout.as_deref().and_then(parse_duration),
            });
            continue;
        }
        if *busy >= limit || (def.edits && editing.contains(&folder)) {
            continue;
        }
        let model = [def.model.trim(), r.def.model.trim(), default_model].into_iter().find(|m| !m.is_empty()).unwrap_or("").to_string();
        let n = &mut r.nodes[i];
        if !model.contains('/') {
            n.state = "failed".into();
            n.error = Some(if model.is_empty() {
                "No model for this node: give it (or the factory) a model like anthropic/claude-sonnet-5-5, or set a default model in Settings.".into()
            } else {
                format!("Name the model with its provider, like anthropic/{model}.")
            });
            n.ended_at = Some(now_ms());
            continue;
        }
        let provider = model.split('/').next().unwrap_or("").to_string();
        let approval = [def.approval.as_str(), if def.edits { r.def.approval.as_str() } else { "plan" }, "auto"]
            .into_iter()
            .find(|a| !a.is_empty())
            .unwrap_or("auto")
            .to_string();
        let session = new_id("");
        n.state = "running".into();
        n.started_at = Some(now_ms());
        n.ended_at = None;
        n.session = Some(session.clone());
        n.log.clear();
        *busy += 1;
        if def.edits {
            editing.insert(folder.clone());
        }
        let prompt = node_prompt(r, &def);
        starts.push(Start::Agent {
            run: r.id.clone(),
            node: def.id.clone(),
            prompt,
            timeout: def.timeout.as_deref().and_then(parse_duration),
            opts: Box::new(StartOpts {
                name: format!("{} · {}", r.def.name, def.label()),
                provider,
                model,
                base_url: String::new(),
                cwd: folder.to_string_lossy().into_owned(),
                approval,
                allow_rules: vec![],
                session: None,
                key_source: String::new(),
                paw_session: Some(session),
                tools: def.tools.clone(),
                skills: def.skills.clone(),
                mcp: def.mcp.clone(),
                dir: dir.as_ref().map(|d| d.join("nodes").join(&def.id)),
                ask: true,
                shared: dir.as_ref().map(|d| d.join("files")),
            }),
        });
    }
    // The end: everything done or skipped; or nothing left that can go on.
    if r.nodes.iter().all(|n| finished(&n.state)) {
        r.state = "done".into();
        r.ended_at = Some(now_ms());
    } else if starts.is_empty() && !r.nodes.iter().any(|n| active(&n.state)) && !r.nodes.iter().zip(&r.def.nodes).any(|(n, d)| n.state == "waiting" && ready_now(r, d)) {
        let failed = r.nodes.iter().any(|n| n.state == "failed");
        r.state = if failed { "failed" } else { "stopped" }.into();
        r.ended_at = Some(now_ms());
        r.note = if failed {
            "A node failed. Retry it, skip it, or fix the factory and run it again.".into()
        } else if let Some(n) = r.nodes.iter().find(|n| n.state == "stopped" && n.note.starts_with(REJECTED)) {
            format!("{}: {}", n.id, n.note)
        } else {
            String::new()
        };
    }
    starts
}

/// Your decision on a node waiting for approval (see `Runner::decide`).
fn decide_in(r: &mut Run, node: &str, approve: bool, text: Option<String>) -> Result<(), String> {
    let text = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let n = r.node_mut(node).ok_or("No such node.")?;
    if !n.gate {
        return Err("That node isn't waiting for your approval.".into());
    }
    n.gate = false;
    if approve {
        n.state = "done".into();
        if let Some(t) = &text {
            if t != n.result.trim() {
                n.result = clip_end(t, RESULT_CHARS);
                log(n, "you", "Approved, with your changes to its answer.");
            } else {
                log(n, "you", "Approved.");
            }
        } else {
            log(n, "you", "Approved.");
        }
    } else {
        let feedback = text.unwrap_or_else(|| "(no reason given)".into());
        log(n, "you", &clip(&format!("Rejected: {feedback}"), LOG_CHARS));
        let looped = r.def_node(node).and_then(|d| d.repeat_until.clone());
        match looped {
            Some(l) => {
                let round = r.node(node).map_or(1, |n| n.round.max(1));
                if round >= l.max_rounds() && l.on_max.as_deref() != Some("continue") {
                    let n = r.node_mut(node).unwrap();
                    n.state = "failed".into();
                    n.error = Some(format!("{REJECTED} after {round} round{}: {feedback}", if round == 1 { "" } else { "s" }));
                } else if round >= l.max_rounds() {
                    let n = r.node_mut(node).unwrap();
                    n.state = "done".into();
                    log(n, "loop", &format!("Round {round} of {round}: rejected, but going on (on_max: continue)."));
                } else {
                    send_back(r, node, &l, round, &format!("{REJECTED}: {feedback}"));
                }
            }
            None => {
                let n = r.node_mut(node).unwrap();
                n.state = "stopped".into();
                n.note = format!("{REJECTED}: {}", clip(&feedback, 300));
            }
        }
    }
    Ok(())
}

/// A node that just finished with `approve`: its answer waits for you.
fn gate(r: &mut Run, node: &str) {
    if r.def_node(node).is_some_and(|d| d.approve) {
        if let Some(n) = r.node_mut(node).filter(|n| n.state == "done") {
            n.state = "needs".into();
            n.gate = true;
            log(n, "ask", "Done: its answer waits for your approval.");
        }
    }
}

/// A node that just finished, with a loop: its answer meets the loop's
/// condition (go on), or the run goes back to `back_to` for another round
/// (the nodes on the way there run again, `back_to` getting the answer as
/// feedback), or the rounds are used up (fail, or go on with `on_max: continue`).
fn loop_back(r: &mut Run, node: &str) {
    let Some(l) = r.def_node(node).and_then(|d| d.repeat_until.clone()) else { return };
    let Some(n) = r.node(node).filter(|n| n.state == "done") else { return };
    let (answer, round) = (n.result.clone(), n.round.max(1));
    if l.done(&answer) {
        if round > 1 && l.until.is_some() {
            log(r.node_mut(node).unwrap(), "loop", &format!("Round {round}: its loop's condition is met; going on."));
        }
        return;
    }
    if round >= l.max_rounds() {
        let n = r.node_mut(node).unwrap();
        if l.on_max.as_deref() == Some("continue") {
            log(n, "loop", &format!("Round {round} of {round}: still not met; going on anyway (on_max: continue)."));
        } else {
            n.state = "failed".into();
            n.error = Some(format!("After {round} round{}, its answer still doesn't meet its loop's condition.", if round == 1 { "" } else { "s" }));
        }
        return;
    }
    send_back(r, node, &l, round, &answer);
}

/// Another round: `back_to`, the looping `node` and the nodes between them
/// wait again; `back_to` gets `feedback` (the node's answer, or your reasons).
fn send_back(r: &mut Run, node: &str, l: &Loop, round: u32, feedback: &str) {
    let region = loop_region(&r.def.nodes, &l.back_to, node);
    for id in &region {
        let back_to = *id == l.back_to;
        let Some(x) = r.node_mut(id) else { continue };
        if x.started_at.is_some() {
            x.rounds.push(Round { round: x.round.max(1), state: x.state.clone(), started_at: x.started_at, ended_at: x.ended_at });
        }
        if back_to {
            x.feedback = Some(Feedback { from: node.to_string(), round, text: clip_end(feedback.trim(), 6000), previous: clip_end(x.result.trim(), 6000) });
        }
        x.gate = false;
        x.question = None;
        x.state = "waiting".into();
        x.round = round + 1;
        x.started_at = None;
        x.ended_at = None;
        x.error = None;
        x.approval = None;
        x.agent = None;
        x.result.clear();
        x.note = format!("Round {} of up to {}.", round + 1, l.max_rounds());
    }
    let why = if feedback.starts_with(REJECTED) { "you rejected its answer" } else { "its loop's condition isn't met" };
    log(r.node_mut(node).unwrap(), "loop", &format!("Round {round}: {why}; back to {} for round {}.", l.back_to, round + 1));
}

/// Can this waiting node start now (its inputs and condition allow it)?
fn ready_now(r: &Run, def: &Node) -> bool {
    let needs: Vec<&NodeRun> = def.needs.iter().filter_map(|n| r.node(n)).collect();
    let ready = match def.join {
        Join::All => needs.iter().all(|n| finished(&n.state)),
        Join::Any => needs.iter().any(|n| n.state == "done") || needs.iter().all(|n| finished(&n.state)),
    };
    ready && def.when.as_ref().map_or(true, |w| r.node(&w.from).is_some_and(|f| f.state == "done" && when_holds(w, &f.result)))
}

/// What an agent node is told: the factory, its own task, and earlier answers.
fn node_prompt(r: &Run, def: &Node) -> String {
    let inputs: Vec<&NodeRun> = def.needs.iter().filter_map(|n| r.node(n)).filter(|n| n.state == "done").collect();
    let each = INPUT_BUDGET / inputs.len().max(1);
    let inputs = inputs
        .iter()
        .map(|n| {
            let title = r.def_node(&n.id).map(|d| d.label().replace('"', "'")).unwrap_or_default();
            format!("<input from=\"{}\" node=\"{}\">\n{}\n</input>", n.id, title, clip_end(n.result.trim(), each))
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut parts = vec![format!(
        "You're one node of the factory “{}”, a pipeline of agents working in {}.{}",
        r.def.name,
        tildify(&folder_of(r)),
        if r.def.description.trim().is_empty() { String::new() } else { format!("\nThe factory: {}", r.def.description.trim()) }
    )];
    parts.push(format!("Your node: {}{}", def.label(), if def.description.trim().is_empty() { String::new() } else { format!("\n{}", def.description.trim()) }));
    if r.trigger != "manual" {
        parts.push(format!("This run was started by its trigger ({}).", r.trigger));
    }
    if let Some(p) = r.payload.as_deref().filter(|p| !p.trim().is_empty()) {
        if r.trigger == "manual" {
            parts.push(format!("The task for this run:\n<task>\n{}\n</task>", clip_end(p.trim(), 4000)));
        } else {
            parts.push(format!("<trigger>\n{}\n</trigger>", clip_end(p.trim(), 4000)));
        }
    }
    if !inputs.is_empty() {
        parts.push(format!("Results of the nodes before yours:\n{inputs}"));
    }
    if !def.edits {
        parts.push("This node only reads: don't change any files.".into());
    }
    if let Some(d) = run_dir(&r.factory, &r.id) {
        parts.push(format!(
            "This run's own folder for files the nodes share (notes, plans, state for later nodes or later rounds): {}. Keep such files there, not in a fixed place: other runs of this factory may go at the same time. (Wait nodes' commands find it as $PAW_RUN_FILES.)",
            tildify(&d.join("files"))
        ));
    }
    parts.push(format!(
        "If you need something only the user can give (a decision, an approval, a missing detail), call {} and wait for the answer. Don't wait for files, poll or send notifications for that.",
        crate::paw_agent::ASK_TOOL
    ));
    if def.approve {
        parts.push("When you're done, the user reviews your answer before the run goes on, so make it complete and easy to check.".into());
    }
    // Sent back by a loop: what came back, and what this node answered before.
    if let Some(fb) = r.node(&def.id).and_then(|n| n.feedback.as_ref()) {
        let max = r.def_node(&fb.from).and_then(|d| d.repeat_until.as_ref()).map_or(0, |l| l.max_rounds());
        let from = r.def_node(&fb.from).map(|d| d.label().to_string()).unwrap_or_else(|| fb.from.clone());
        parts.push(format!(
            "This is round {} of up to {max}: “{from}” sent the work back.\n<feedback from=\"{}\" round=\"{}\">\n{}\n</feedback>{}\nAddress the feedback.",
            fb.round + 1,
            fb.from,
            fb.round,
            fb.text,
            if fb.previous.is_empty() { String::new() } else { format!("\nYour answer in round {}:\n<previous>\n{}\n</previous>", fb.round, fb.previous) },
        ));
    }
    parts.push(def.prompt.trim().to_string());
    parts.push("When you're done, end with a short summary of what you did and what you found. The next nodes get it.".into());
    parts.join("\n\n")
}

/// Run a wait node's command once: (it succeeded, its output).
pub(super) fn check(command: &str, folder: &Path) -> (bool, String) {
    check_with(command, folder, &[])
}

/// `check`, with more environment variables (a wait node's run folders).
fn check_with(command: &str, folder: &Path, env: &[(String, String)]) -> (bool, String) {
    use std::process::{Command, Stdio};
    let mut child = match Command::new("/bin/sh")
        .arg("-c")
        .arg(command)
        .current_dir(folder)
        .env("PATH", crate::registry::login_path())
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return (false, e.to_string()),
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > CHECK_LIMIT => {
                let _ = child.kill();
                let _ = child.wait();
                return (false, format!("The check took longer than {}s.", CHECK_LIMIT.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return (false, e.to_string()),
        }
    }
    match child.wait_with_output() {
        Ok(o) => {
            let mut text = String::from_utf8_lossy(&o.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&o.stderr));
            (o.status.success(), clip_end(&text, 4000))
        }
        Err(e) => (false, e.to_string()),
    }
}

fn fmt_duration(d: Duration) -> String {
    let s = d.as_secs();
    if s % 3600 == 0 && s >= 3600 {
        format!("{}h", s / 3600)
    } else if s % 60 == 0 && s >= 60 {
        format!("{}m", s / 60)
    } else {
        format!("{s}s")
    }
}

/// A macOS notification (the window may be closed): a node needs you.
fn notify(title: &str, body: &str) {
    if cfg!(test) {
        return;
    }
    let _ = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run"])
        .arg(clip(title, 80))
        .arg(clip(body, 200))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

/// "Factory · Node title" for a notification.
fn who(r: &Run, node: &str) -> String {
    format!("{} · {}", r.def.name, r.def_node(node).map(|d| d.label().to_string()).unwrap_or_else(|| node.to_string()))
}

/// A path with the home folder as `~`.
fn tildify(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    match std::env::var("HOME") {
        Ok(h) if !h.is_empty() && s.starts_with(&h) => format!("~{}", &s[h.len()..]),
        _ => s,
    }
}

/// A factory's file by its id: `<id>.yaml` (or `.yml`).
fn factory_file(id: &str) -> Option<PathBuf> {
    let d = factories_dir()?;
    valid_id(id).then(|| ["yaml", "yml"].iter().map(|e| d.join(format!("{id}.{e}"))).find(|p| p.is_file())).flatten()
}

fn save_run(r: &Run) {
    let Some(d) = run_dir(&r.factory, &r.id) else { return };
    let _ = std::fs::create_dir_all(&d);
    if let Ok(text) = serde_json::to_string(r) {
        let tmp = d.join(".run.json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, d.join("run.json"));
        }
    }
}

/// Runs kept before runs had folders (`~/.paw/factories/.runs/<id>.json`)
/// move to `<factory-id>/<execution-id>/run.json`.
fn move_old_runs(dir: &Path) {
    let old = dir.join(".runs");
    let Ok(entries) = std::fs::read_dir(&old) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.file_name().is_some_and(|n| n == "default-model") {
            let to = dir.join(".default-model");
            if !to.exists() {
                let _ = std::fs::rename(&p, to);
            }
            continue;
        }
        if p.extension().is_none_or(|x| x != "json") {
            continue;
        }
        let Some(r) = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Run>(&t).ok()) else { continue };
        if run_dir(&r.factory, &r.id).is_some() {
            save_run(&r);
            let _ = std::fs::remove_file(&p);
        }
    }
    let _ = std::fs::remove_dir(&old); // if it's empty now
}

/// Runs from before; any that were going when Paw stopped are marked stopped.
fn load_runs() -> Vec<Run> {
    let Some(d) = factories_dir() else { return vec![] };
    move_old_runs(&d);
    let subdirs = |p: &Path| -> Vec<PathBuf> {
        std::fs::read_dir(p).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir() && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'))).collect()
    };
    let mut runs: Vec<Run> = subdirs(&d)
        .iter()
        .flat_map(|f| subdirs(f))
        .filter_map(|r| serde_json::from_str(&std::fs::read_to_string(r.join("run.json")).ok()?).ok())
        .collect();
    runs.sort_by_key(|r: &Run| r.started_at);
    for r in &mut runs {
        // Waiting only for your approval: nothing was running, so it waits on.
        if active_run(r) && r.nodes.iter().any(|n| n.gate) && r.nodes.iter().filter(|n| active(&n.state)).all(|n| n.gate) {
            continue;
        }
        if active_run(r) {
            r.state = "stopped".into();
            r.note = INTERRUPTED.into();
            r.ended_at.get_or_insert(now_ms());
            for n in &mut r.nodes {
                if active(&n.state) {
                    n.state = "stopped".into();
                    n.approval = None;
                }
                n.agent = None;
            }
            save_run(r);
        }
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_of(yaml: &str) -> Run {
        let def = parse(yaml).unwrap();
        Run {
            id: "r1".into(),
            factory: "f".into(),
            folder: String::new(),
            nodes: def.nodes.iter().map(|n| NodeRun { id: n.id.clone(), state: "waiting".into(), ..Default::default() }).collect(),
            def,
            trigger: "manual".into(),
            payload: None,
            state: "running".into(),
            started_at: 0,
            ended_at: None,
            note: String::new(),
        }
    }

    fn pump(r: &mut Run, limit: usize, busy: &mut usize, default_model: &str) -> Vec<Start> {
        pump_in(r, limit, busy, &mut HashSet::new(), default_model)
    }

    fn started(starts: &[Start]) -> Vec<String> {
        starts
            .iter()
            .map(|s| match s {
                Start::Agent { node, .. } | Start::Wait { node, .. } => node.clone(),
            })
            .collect()
    }

    fn finish(r: &mut Run, id: &str, answer: &str) {
        let n = r.node_mut(id).unwrap();
        n.state = "done".into();
        n.result = answer.into();
    }

    const GRAPH: &str = r#"
name: Graph
model: anthropic/claude-sonnet-5-5
nodes:
  - { id: triage, prompt: look, edits: false }
  - { id: a, needs: [triage], prompt: read a, edits: false }
  - { id: b, needs: [triage], prompt: read b, edits: false }
  - { id: fix, needs: [triage], prompt: fix, when: { from: triage, matches: critical } }
  - { id: after-fix, needs: [fix], prompt: deploy }
  - { id: join, needs: [a, b], prompt: sum up, edits: false }
  - { id: first, needs: [a, b], join: any, prompt: quick note, edits: false }
"#;

    #[test]
    fn execution_ids_are_uuids() {
        let (a, b) = (uuid_v4(), uuid_v4());
        assert_ne!(a, b);
        let parts: Vec<usize> = a.split('-').map(str::len).collect();
        assert_eq!(parts, [8, 4, 4, 4, 12]);
        assert_eq!(&a[14..15], "4", "version 4");
        assert!("89ab".contains(&a[19..20]), "the RFC 4122 variant");
    }

    #[test]
    fn runs_in_one_folder_take_turns_changing_files_and_other_folders_dont_wait() {
        const EDIT: &str = "name: E\nmodel: anthropic/claude-sonnet-5-5\nnodes:\n  - { id: fix, prompt: fix }\n";
        let (mut a, mut b, mut c) = (run_of(EDIT), run_of(EDIT), run_of(EDIT));
        a.folder = "/tmp/one".into();
        b.folder = "/tmp/one".into();
        c.folder = "/tmp/two".into();
        let (mut busy, mut editing) = (0, HashSet::new());
        assert_eq!(started(&pump_in(&mut a, 9, &mut busy, &mut editing, "")), ["fix"]);
        assert!(pump_in(&mut b, 9, &mut busy, &mut editing, "").is_empty(), "the same folder waits");
        assert_eq!(started(&pump_in(&mut c, 9, &mut busy, &mut editing, "")), ["fix"], "another folder goes on");
    }

    #[test]
    fn parallel_nodes_start_together_and_joins_wait() {
        let mut r = run_of(GRAPH);
        let mut busy = 0;
        assert_eq!(started(&pump(&mut r, 9, &mut busy, "")), ["triage"]);
        finish(&mut r, "triage", "Severity: low");
        let s = started(&pump(&mut r, 9, &mut busy, ""));
        assert_eq!(s, ["a", "b"], "a and b run side by side; fix's branch isn't taken");
        assert_eq!(r.node("fix").unwrap().state, "skipped");
        assert_eq!(r.node("after-fix").unwrap().state, "skipped", "what follows a skipped branch is skipped too");
        finish(&mut r, "a", "A says");
        assert_eq!(started(&pump(&mut r, 9, &mut busy, "")), ["first"], "join: any goes on after one input; join: all waits");
        finish(&mut r, "b", "B says");
        assert_eq!(started(&pump(&mut r, 9, &mut busy, "")), ["join"]);
        let prompt = node_prompt(&r, r.def_node("join").unwrap());
        assert!(prompt.contains("<input from=\"a\"") && prompt.contains("B says"));
        finish(&mut r, "join", "ok");
        finish(&mut r, "first", "ok");
        pump(&mut r, 9, &mut busy, "");
        assert_eq!(r.state, "done");
    }

    #[test]
    fn a_taken_branch_runs_and_edits_go_one_at_a_time() {
        let mut r = run_of(GRAPH);
        let mut busy = 0;
        pump(&mut r, 9, &mut busy, "");
        finish(&mut r, "triage", "This is CRITICAL");
        assert_eq!(started(&pump(&mut r, 9, &mut busy, "")), ["a", "b", "fix"]);
        // Agents at once: with a limit of 1, one node at a time.
        let mut r = run_of(GRAPH);
        let mut busy = 0;
        pump(&mut r, 1, &mut busy, "");
        finish(&mut r, "triage", "x");
        busy = 0;
        assert_eq!(started(&pump(&mut r, 1, &mut busy, "")).len(), 1);
    }

    #[test]
    fn a_failed_node_ends_the_run_and_models_come_from_somewhere() {
        let mut r = run_of(&GRAPH.replace("model: anthropic/claude-sonnet-5-5\n", ""));
        let mut busy = 0;
        assert!(pump(&mut r, 9, &mut busy, "").is_empty());
        assert_eq!(r.node("triage").unwrap().state, "failed");
        assert!(r.node("triage").unwrap().error.as_deref().unwrap().contains("No model"));
        assert_eq!(r.state, "failed");
        let mut r = run_of(&GRAPH.replace("model: anthropic/claude-sonnet-5-5\n", ""));
        assert_eq!(started(&pump(&mut r, 9, &mut 0, "ollama/qwen3")), ["triage"], "the default model from Settings");
    }

    #[test]
    fn a_loop_sends_the_run_back_until_its_condition_holds() {
        let yaml = r#"
name: Loop
model: anthropic/claude-sonnet-5-5
nodes:
  - { id: plan, prompt: p, edits: false }
  - { id: fix, needs: [plan], prompt: f }
  - { id: review, needs: [fix], prompt: r, edits: false, loop: { back_to: fix, until: { matches: approved }, max: 3 } }
  - { id: ship, needs: [review], prompt: s }
"#;
        let mut r = run_of(yaml);
        let mut busy = 0;
        let done = |r: &mut Run, id: &str, answer: &str| {
            let n = r.node_mut(id).unwrap();
            n.state = "done".into();
            n.result = answer.into();
            n.started_at = Some(1);
            n.ended_at = Some(2);
            loop_back(r, id);
        };
        pump(&mut r, 9, &mut busy, "");
        done(&mut r, "plan", "the plan");
        assert_eq!(started(&pump(&mut r, 9, &mut busy, "")), ["fix"]);
        done(&mut r, "fix", "fixed v1");
        assert_eq!(started(&pump(&mut r, 9, &mut busy, "")), ["review"]);
        done(&mut r, "review", "changes needed: tests fail");
        // Back to fix: fix and review run again, plan doesn't; ship waits.
        assert_eq!((r.node("fix").unwrap().state.as_str(), r.node("review").unwrap().state.as_str(), r.node("plan").unwrap().state.as_str()), ("waiting", "waiting", "done"));
        let fb = r.node("fix").unwrap().feedback.clone().unwrap();
        assert_eq!((fb.from.as_str(), fb.round, fb.previous.as_str()), ("review", 1, "fixed v1"));
        assert_eq!(started(&pump(&mut r, 9, &mut busy, "")), ["fix"]);
        let prompt = node_prompt(&r, r.def_node("fix").unwrap());
        assert!(prompt.contains("round 2 of up to 3") && prompt.contains("tests fail") && prompt.contains("fixed v1"));
        done(&mut r, "fix", "fixed v2");
        pump(&mut r, 9, &mut busy, "");
        done(&mut r, "review", "verdict: APPROVED");
        assert_eq!(started(&pump(&mut r, 9, &mut busy, "")), ["ship"]);
        assert_eq!(r.node("fix").unwrap().rounds.len(), 1, "round 1 is kept for the timeline");
        assert_eq!(r.node("review").unwrap().round, 2);
    }

    #[test]
    fn an_approved_answer_goes_on_and_a_rejected_one_goes_back_or_stops() {
        let yaml = r#"
name: Gate
model: anthropic/claude-sonnet-5-5
nodes:
  - { id: plan, prompt: p, edits: false, approve: true, loop: { back_to: plan, max: 2 } }
  - { id: build, needs: [plan], prompt: b }
"#;
        let mut r = run_of(yaml);
        let mut busy = 0;
        let done = |r: &mut Run, id: &str, answer: &str| {
            let n = r.node_mut(id).unwrap();
            n.state = "done".into();
            n.result = answer.into();
            n.started_at = Some(1);
            loop_back(r, id);
            gate(r, id);
        };
        assert_eq!(started(&pump(&mut r, 9, &mut busy, "")), ["plan"]);
        assert!(node_prompt(&r, r.def_node("plan").unwrap()).contains("reviews your answer"));
        done(&mut r, "plan", "plan v1");
        assert!(r.node("plan").unwrap().gate, "without until, the answer waits for you");
        busy = 0;
        assert!(pump(&mut r, 9, &mut busy, "").is_empty(), "build waits for the approval");
        assert_eq!(r.state, "running");
        // Rejected: another round of plan, with your reasons as feedback.
        decide_in(&mut r, "plan", false, Some("split it in two".into())).unwrap();
        assert_eq!(r.node("plan").unwrap().state, "waiting");
        assert!(r.node("plan").unwrap().feedback.as_ref().unwrap().text.contains("split it in two"));
        assert_eq!(started(&pump(&mut r, 9, &mut busy, "")), ["plan"]);
        done(&mut r, "plan", "plan v2");
        // Approved with your edit: that's the answer build gets.
        decide_in(&mut r, "plan", true, Some("plan v2, edited".into())).unwrap();
        assert_eq!(started(&pump(&mut r, 9, &mut busy, "")), ["build"]);
        assert!(node_prompt(&r, r.def_node("build").unwrap()).contains("plan v2, edited"));
        assert!(decide_in(&mut r, "plan", true, None).is_err(), "it isn't waiting any more");

        // Without a loop, rejecting stops the run.
        let mut r = run_of("name: G\nmodel: anthropic/claude-sonnet-5-5\nnodes:\n  - { id: plan, prompt: p, approve: true }\n  - { id: build, needs: [plan], prompt: b }\n");
        pump(&mut r, 9, &mut 0, "");
        done(&mut r, "plan", "a plan");
        decide_in(&mut r, "plan", false, Some("not now".into())).unwrap();
        assert!(pump(&mut r, 9, &mut 0, "").is_empty());
        assert_eq!(r.state, "stopped");
        assert!(r.note.contains("Rejected by you: not now"), "{}", r.note);
    }

    #[test]
    fn nodes_hear_about_asking_and_their_runs_files_folder() {
        let r = run_of("name: A\nmodel: anthropic/claude-sonnet-5-5\nnodes:\n  - { id: a, prompt: p }\n");
        let p = node_prompt(&r, r.def_node("a").unwrap());
        assert!(p.contains("ask_user"));
        if crate::paths::home().is_some() {
            assert!(p.contains("f/r1/files"), "{p}");
        }
    }

    #[test]
    fn a_loop_fails_when_its_rounds_run_out_unless_it_continues() {
        let yaml = |on_max: &str| format!("name: L\nmodel: a/b\nnodes:\n  - {{ id: w, prompt: w, loop: {{ back_to: w, until: {{ matches: ok }}, max: 2{on_max} }} }}\n  - {{ id: next, needs: [w], prompt: n }}\n");
        for (extra, end) in [("", "failed"), (", on_max: continue", "done")] {
            let mut r = run_of(&yaml(extra));
            for _ in 0..2 {
                pump(&mut r, 9, &mut 0, "");
                let n = r.node_mut("w").unwrap();
                n.state = "done".into();
                n.result = "nope".into();
                loop_back(&mut r, "w");
            }
            assert_eq!(r.node("w").unwrap().state, end);
            assert_eq!(r.node("w").unwrap().round, 2);
        }
    }

    #[test]
    fn wait_nodes_check_until_true() {
        let d = std::env::temp_dir();
        assert!(check("test 1 -eq 1 && echo ready", &d).0);
        let (ok, out) = check("echo not yet; exit 3", &d);
        assert!(!ok && out.contains("not yet"));
    }
}
