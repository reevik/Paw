//! Runs factories in the background process: no window needed.
//!
//! A run keeps a copy of its factory and the state of each node. `pump` starts
//! every node whose inputs are ready (within "Agents at once" and one node
//! changing files at a time), skips the ones whose branch wasn't taken, and
//! notices the end. Agent nodes are Paw Agent sessions started here; their
//! output (`agent:output`) and approval requests (`paw:approval`) come back
//! through the app's events. Wait nodes run their command until it succeeds.
//!
//! Every change goes to windows as a `factory:run` event (the whole run), and
//! runs are kept in `~/.paw/factories/.runs/` so their history survives.

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
    /// Its folder in `~/.paw/session/` (the conversation is kept there).
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
    #[serde(skip)]
    last_answer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub factory: String,
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

/// What `pump` decided to start (started outside the lock).
enum Start {
    Agent { run: String, node: String, opts: Box<StartOpts>, prompt: String, timeout: Option<Duration> },
    Wait { run: String, node: String, command: String, folder: PathBuf, every: Duration, timeout: Option<Duration> },
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

/// Settings the runner reads: (agents at once, the default model).
fn settings() -> (usize, String) {
    let v: Value = crate::paths::home()
        .and_then(|h| std::fs::read_to_string(h.join("settings.json")).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let n = v.pointer("/general/max_agents").and_then(Value::as_u64).unwrap_or(3);
    let model = v.pointer("/models/default").and_then(Value::as_str).unwrap_or("").to_string();
    (if n == 0 { usize::MAX } else { n as usize }, model)
}

fn runs_dir() -> Option<PathBuf> {
    crate::paths::home().map(|h| dir(&h).join(".runs"))
}

pub fn factories_dir() -> Option<PathBuf> {
    crate::paths::home().map(|h| dir(&h))
}

/// The folder a factory works in.
fn folder_of(def: &Factory) -> PathBuf {
    let f = def.folder.trim();
    crate::agents::expand_home(if f.is_empty() { "~" } else { f })
}

impl Runner {
    pub fn new(app: &AppHandle) -> Arc<Runner> {
        let runner = Arc::new(Runner { app: app.clone(), state: Mutex::new(State { runs: load_runs(), ..Default::default() }), paused: Mutex::default() });
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
        runner
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

    /// Is a run of this factory going?
    pub fn running(&self, factory: &str) -> bool {
        self.state.lock().unwrap().runs.iter().any(|r| r.factory == factory && active_run(r))
    }

    pub fn get(&self, run: &str) -> Option<Run> {
        self.state.lock().unwrap().runs.iter().find(|r| r.id == run).cloned()
    }

    /// Start a run of a factory (by its file name).
    pub fn start(self: &Arc<Self>, factory: &str, trigger: &str, payload: Option<String>) -> Result<String, String> {
        let dir = factories_dir().ok_or("Paw can't find its folder (~/.paw).")?;
        let path = ["yaml", "yml"].iter().map(|e| dir.join(format!("{factory}.{e}"))).find(|p| p.is_file()).ok_or(format!("There's no factory “{factory}”."))?;
        let found = load(factory, &path);
        let def = found.factory.ok_or_else(|| format!("{factory}.yaml: {}", found.error.unwrap_or_default()))?;
        if !folder_of(&def).is_dir() {
            return Err(format!("The factory's folder doesn't exist: {}", def.folder));
        }
        let run = Run {
            id: new_id("r"),
            factory: factory.to_string(),
            nodes: def.nodes.iter().map(|n| NodeRun { id: n.id.clone(), state: "waiting".into(), ..Default::default() }).collect(),
            def,
            trigger: trigger.to_string(),
            payload,
            state: "running".into(),
            started_at: now_ms(),
            ended_at: None,
            note: String::new(),
        };
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
                    if let Some(d) = runs_dir() {
                        let _ = std::fs::remove_file(d.join(format!("{o}.json")));
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
            if active(&n.state) {
                return Err("That node is running; stop the run first.".into());
            }
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
            let mut busy = st.runs.iter().flat_map(|r| r.nodes.iter().zip(&r.def.nodes)).filter(|(n, d)| active(&n.state) && !d.is_wait()).count();
            let mut starts = vec![];
            let mut repeats = vec![];
            let ids: Vec<String> = st.runs.iter().filter(|r| r.state == "running").map(|r| r.id.clone()).collect();
            for id in ids {
                let r = st.runs.iter_mut().find(|r| r.id == id).unwrap();
                starts.extend(pump(r, limit, &mut busy, &default_model));
                // A run that just ended: a repeating factory starts again.
                if let Some((after, on_failure)) = repeat_of(&r.def).filter(|_| r.state == "done" || r.state == "failed") {
                    if r.state == "done" || on_failure {
                        let when = format!("The next run starts in {}.", fmt_duration(after));
                        r.note = if r.note.is_empty() { when } else { format!("{} {when}", r.note) };
                        repeats.push((r.factory.clone(), after));
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
        for (factory, after) in repeats {
            let me = self.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(after).await;
                // Paused meanwhile, or already going again (Run now): nothing to do.
                if me.is_paused(&factory) || me.running(&factory) {
                    return;
                }
                if let Err(e) = me.start(&factory, "repeat", None) {
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
            Start::Wait { run, node, command, folder, every, timeout } => {
                tauri::async_runtime::spawn(async move {
                    let deadline = timeout.map(|t| Instant::now() + t);
                    loop {
                        if !me.is_running(&run, &node) {
                            return;
                        }
                        let (cmd, dir) = (command.clone(), folder.clone());
                        let out = tauri::async_runtime::spawn_blocking(move || check(&cmd, &dir)).await.unwrap_or_else(|e| (false, e.to_string()));
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
            if n.state == "needs" {
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
        let Some(daemon) = self.app.try_state::<crate::daemon::DaemonState>() else { return };
        for r in runs {
            if !active_run(&r) {
                save_run(&r);
            }
            daemon.server.publish("factory:run", json!({ "run": r }));
        }
    }
}

fn active_run(r: &Run) -> bool {
    r.state == "running"
}

/// Decide what starts next in a run (and skip what won't run).
fn pump(r: &mut Run, limit: usize, busy: &mut usize, default_model: &str) -> Vec<Start> {
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
    // Start what's ready: one node changing files at a time, within Agents at once.
    let mut starts = vec![];
    let mut editing = r.nodes.iter().zip(&r.def.nodes).any(|(n, d)| active(&n.state) && d.edits && !d.is_wait());
    for &i in &order {
        let def = r.def.nodes[i].clone();
        if r.nodes[i].state != "waiting" || !ready_now(r, &def) {
            continue;
        }
        let folder = folder_of(&r.def);
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
                every: def.every.as_deref().and_then(parse_duration).unwrap_or(Duration::from_secs(30)),
                timeout: def.timeout.as_deref().and_then(parse_duration),
            });
            continue;
        }
        if *busy >= limit || (def.edits && editing) {
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
            editing = true;
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
        r.note = if failed { "A node failed. Retry it, skip it, or fix the factory and run it again.".into() } else { String::new() };
    }
    starts
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
        r.def.folder.trim().is_empty().then_some("~").unwrap_or(r.def.folder.trim()),
        if r.def.description.trim().is_empty() { String::new() } else { format!("\nThe factory: {}", r.def.description.trim()) }
    )];
    parts.push(format!("Your node: {}{}", def.label(), if def.description.trim().is_empty() { String::new() } else { format!("\n{}", def.description.trim()) }));
    if r.trigger != "manual" {
        parts.push(format!("This run was started by its trigger ({}).", r.trigger));
    }
    if let Some(p) = r.payload.as_deref().filter(|p| !p.trim().is_empty()) {
        parts.push(format!("<trigger>\n{}\n</trigger>", clip_end(p.trim(), 4000)));
    }
    if !inputs.is_empty() {
        parts.push(format!("Results of the nodes before yours:\n{inputs}"));
    }
    if !def.edits {
        parts.push("This node only reads: don't change any files.".into());
    }
    parts.push(def.prompt.trim().to_string());
    parts.push("When you're done, end with a short summary of what you did and what you found. The next nodes get it.".into());
    parts.join("\n\n")
}

/// Run a wait node's command once: (it succeeded, its output).
pub(super) fn check(command: &str, folder: &Path) -> (bool, String) {
    use std::process::{Command, Stdio};
    let mut child = match Command::new("/bin/sh")
        .arg("-c")
        .arg(command)
        .current_dir(folder)
        .env("PATH", crate::registry::login_path())
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

fn save_run(r: &Run) {
    let Some(d) = runs_dir() else { return };
    let _ = std::fs::create_dir_all(&d);
    if let Ok(text) = serde_json::to_string(r) {
        let tmp = d.join(format!(".{}.tmp", r.id));
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, d.join(format!("{}.json", r.id)));
        }
    }
}

/// Runs from before; any that were going when Paw stopped are marked stopped.
fn load_runs() -> Vec<Run> {
    let Some(d) = runs_dir() else { return vec![] };
    let mut runs: Vec<Run> = std::fs::read_dir(&d)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_str(&std::fs::read_to_string(e.path()).ok()?).ok())
        .collect();
    runs.sort_by_key(|r: &Run| r.started_at);
    for r in &mut runs {
        if active_run(r) {
            r.state = "stopped".into();
            r.note = "Paw stopped while this ran.".into();
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
    fn wait_nodes_check_until_true() {
        let d = std::env::temp_dir();
        assert!(check("test 1 -eq 1 && echo ready", &d).0);
        let (ok, out) = check("echo not yet; exit 3", &d);
        assert!(!ok && out.contains("not yet"));
    }
}
