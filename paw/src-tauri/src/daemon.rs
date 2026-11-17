//! Paw in two processes: the **daemon** (`paw --daemon`) runs the agents,
//! shells and Paw Agent sessions and sits in the menu bar; the **window**
//! (`paw`) is the app you see. They talk over a Unix socket that only you
//! can open (`~/.paw/daemon.sock`), one JSON object per line:
//!
//! ```text
//! window → daemon   {"id": 7, "cmd": "spawn_agent", "args": {...}}
//! daemon → window   {"id": 7, "ok": {...}}      or {"id": 7, "err": "..."}
//! daemon → window   {"event": "agent:output", "payload": {...}, "dseq": 1234}
//! ```
//!
//! Every event the daemon sends is numbered (`dseq`) and kept for a while per
//! process, so a window that starts again (quit, crash, update) asks for what
//! it missed since the last number it saw and carries on: the agents never
//! noticed the window was gone. Quitting the window leaves the daemon and its
//! agents running; Quit Paw in the menu bar stops everything.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc, oneshot};

/// Events the daemon's modules emit; all go to the windows (and the log).
pub const EVENTS: &[&str] = &[
    "agent:output", "agent:status", "paw:delta", "paw:approval",
    "shell:output", "shell:raw", "shell:names", "shell:data", "shell:ready", "shell:done", "shell:exit",
];

/// Commands that run in the daemon (the window passes them on).
pub const COMMANDS: &[&str] = &[
    "spawn_agent", "send_input", "close_input", "stop_agent", "remove_agent", "list_agents", "agent_output",
    "shell_open", "shell_run", "shell_write", "shell_interrupt", "shell_close", "shell_write_raw", "shell_resize", "shell_raw_exit",
    "paw_agent_start", "paw_agent_send", "paw_agent_note", "paw_agent_cancel", "paw_agent_close", "paw_agent_approve",
    "tray_update", "daemon_attach",
    "factory_list", "factory_get", "factory_run", "factory_stop", "factory_retry", "factory_skip", "factory_new", "factory_pause",
];

/// Events kept per process for windows that come back.
const LOG_PER_ID: usize = 4000;

/// The socket: `~/.paw/daemon.sock`, or in the temp folder when that path is
/// too long for a socket (a long PAW_CONFIG_DIR).
pub fn socket_path() -> PathBuf {
    let home = crate::paths::home().unwrap_or_else(std::env::temp_dir);
    let p = home.join("daemon.sock");
    if p.as_os_str().len() < 100 {
        return p;
    }
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    home.hash(&mut h);
    std::env::temp_dir().join(format!("paw-{:x}.sock", h.finish()))
}

// ---------------------------------------------------------------------------
// The event log: what a window missed
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Logged {
    pub event: String,
    pub payload: Value,
    pub dseq: u64,
}

/// The process an event is about. Agents (and Paw Agent sessions) and shells
/// are numbered separately, so the kind is part of the key.
pub fn event_key(event: &str, payload: &Value) -> Option<(bool, u32)> {
    let id = payload.get("id").and_then(Value::as_u64).or_else(|| payload.as_u64())?;
    Some((event.starts_with("shell:"), id as u32))
}

#[derive(Default)]
pub struct EventLog {
    seq: u64,
    /// (is a shell, id) → its recent events.
    by_id: HashMap<(bool, u32), VecDeque<Logged>>,
}

impl EventLog {
    /// Number an event and keep it (deltas, the text being typed, only matter live).
    pub fn push(&mut self, event: &str, payload: &Value) -> u64 {
        self.seq += 1;
        if event != "paw:delta" {
            if let Some(key) = event_key(event, payload) {
                let q = self.by_id.entry(key).or_default();
                q.push_back(Logged { event: event.to_string(), payload: payload.clone(), dseq: self.seq });
                while q.len() > LOG_PER_ID {
                    q.pop_front();
                }
            }
        }
        self.seq
    }

    /// The events about these agents and shells after `after`, in order.
    pub fn since(&self, procs: &[u32], shells: &[u32], after: u64) -> Vec<Logged> {
        let keys = procs.iter().map(|&id| (false, id)).chain(shells.iter().map(|&id| (true, id)));
        let mut out: Vec<Logged> = keys
            .filter_map(|k| self.by_id.get(&k))
            .flat_map(|q| q.iter().filter(|l| l.dseq > after).cloned())
            .collect();
        out.sort_by_key(|l| l.dseq);
        out
    }

    pub fn last(&self) -> u64 {
        self.seq
    }
}

/// `noStdin` → `no_stdin`: the window's arguments use JavaScript's names, as
/// Tauri commands take them.
pub fn snake_keys(args: Value) -> Value {
    let Value::Object(map) = args else { return args };
    Value::Object(
        map.into_iter()
            .map(|(k, v)| {
                let mut s = String::with_capacity(k.len() + 4);
                for c in k.chars() {
                    if c.is_ascii_uppercase() {
                        s.push('_');
                        s.push(c.to_ascii_lowercase());
                    } else {
                        s.push(c);
                    }
                }
                (s, v)
            })
            .collect(),
    )
}

// ---------------------------------------------------------------------------
// Server (the daemon)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct Request {
    id: u64,
    cmd: String,
    #[serde(default)]
    args: Value,
}

type BoxFut = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send>>;

/// What runs a command (the Tauri glue below; a fake in the tests).
pub trait Handler: Send + Sync + 'static {
    fn call(&self, cmd: String, args: Value) -> BoxFut;
}

pub struct Server {
    pub log: Mutex<EventLog>,
    events: broadcast::Sender<String>,
    pub clients: AtomicUsize,
}

impl Default for Server {
    fn default() -> Self {
        Self { log: Mutex::default(), events: broadcast::channel(8192).0, clients: AtomicUsize::new(0) }
    }
}

impl Server {
    /// Send an event to every window (and keep it for ones that come back).
    pub fn publish(&self, event: &str, mut payload: Value) {
        let mut log = self.log.lock().unwrap();
        let dseq = log.push(event, &payload);
        if let Value::Object(m) = &mut payload {
            m.insert("__dseq".into(), dseq.into());
        }
        let line = json!({ "event": event, "payload": payload, "dseq": dseq }).to_string();
        drop(log);
        let _ = self.events.send(line);
    }

    /// Bind the socket (owner only). Fails when another daemon is listening.
    pub async fn bind(path: &std::path::Path) -> std::io::Result<UnixListener> {
        if UnixStream::connect(path).await.is_ok() {
            return Err(std::io::Error::new(std::io::ErrorKind::AddrInUse, "a Paw daemon is already running"));
        }
        let _ = std::fs::remove_file(path);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let l = UnixListener::bind(path)?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        Ok(l)
    }

    pub async fn serve(self: Arc<Self>, listener: UnixListener, handler: Arc<dyn Handler>) {
        let me = unsafe { libc::getuid() };
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            // Only this user's processes.
            if stream.peer_cred().map(|c| c.uid() != me).unwrap_or(true) {
                continue;
            }
            let (server, handler) = (self.clone(), handler.clone());
            tokio::spawn(async move { server.client(stream, handler).await });
        }
    }

    async fn client(self: Arc<Self>, stream: UnixStream, handler: Arc<dyn Handler>) {
        self.clients.fetch_add(1, Ordering::SeqCst);
        let (rd, mut wr) = stream.into_split();
        let (out, mut out_rx) = mpsc::unbounded_channel::<String>();
        let mut events = self.events.subscribe();
        let writer = tokio::spawn(async move {
            loop {
                let line = tokio::select! {
                    m = out_rx.recv() => match m { Some(m) => m, None => break },
                    e = events.recv() => match e {
                        Ok(e) => e,
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    },
                };
                if wr.write_all(line.as_bytes()).await.is_err() || wr.write_all(b"\n").await.is_err() {
                    break;
                }
            }
        });
        let mut lines = BufReader::new(rd).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(req) = serde_json::from_str::<Request>(&line) else { continue };
            let (handler, out) = (handler.clone(), out.clone());
            tokio::spawn(async move {
                let reply = match handler.call(req.cmd, snake_keys(req.args)).await {
                    Ok(v) => json!({ "id": req.id, "ok": v }),
                    Err(e) => json!({ "id": req.id, "err": e }),
                };
                let _ = out.send(reply.to_string());
            });
        }
        drop(out);
        writer.abort();
        self.clients.fetch_sub(1, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// Client (the window)
// ---------------------------------------------------------------------------

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub struct Client {
    tx: mpsc::UnboundedSender<String>,
    pending: Pending,
    next: AtomicU64,
}

impl Client {
    /// Connect; events arrive on the receiver, which closes when the daemon goes away.
    pub async fn connect(path: &std::path::Path) -> std::io::Result<(Client, mpsc::UnboundedReceiver<(String, Value)>)> {
        let stream = UnixStream::connect(path).await?;
        let (rd, mut wr) = stream.into_split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let (ev_tx, ev_rx) = mpsc::unbounded_channel();
        let pending: Pending = Arc::default();
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if wr.write_all(line.as_bytes()).await.is_err() || wr.write_all(b"\n").await.is_err() {
                    break;
                }
            }
        });
        let p2 = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(rd).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(event) = v.get("event").and_then(Value::as_str) {
                    let _ = ev_tx.send((event.to_string(), v.get("payload").cloned().unwrap_or(Value::Null)));
                } else if let Some(id) = v.get("id").and_then(Value::as_u64) {
                    if let Some(done) = p2.lock().unwrap().remove(&id) {
                        let _ = done.send(match v.get("err") {
                            Some(e) => Err(e.as_str().unwrap_or("error").to_string()),
                            None => Ok(v.get("ok").cloned().unwrap_or(Value::Null)),
                        });
                    }
                }
            }
            // Gone: whoever waits gets an error; the event receiver closes.
            for (_, done) in p2.lock().unwrap().drain() {
                let _ = done.send(Err("Paw's background process stopped".into()));
            }
        });
        Ok((Client { tx, pending, next: AtomicU64::new(1) }, ev_rx))
    }

    pub async fn call(&self, cmd: &str, args: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (done, wait) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, done);
        let line = json!({ "id": id, "cmd": cmd, "args": args }).to_string();
        if self.tx.send(line).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err("Paw's background process isn't running".into());
        }
        wait.await.map_err(|_| "Paw's background process stopped".to_string())?
    }
}

// ---------------------------------------------------------------------------
// The daemon in Tauri: commands run here, events go to the windows
// ---------------------------------------------------------------------------

use tauri::{AppHandle, Emitter, Listener, Manager};

/// What the menu bar asked the window to do while no window was there.
#[derive(Default, Clone, Serialize)]
pub struct PendingOpen {
    tab: Option<String>,
    settings: bool,
}

pub struct DaemonState {
    pub server: Arc<Server>,
    /// Changes when the daemon starts again: a window's old process ids mean
    /// nothing to a new daemon.
    pub instance: String,
    pending: Mutex<PendingOpen>,
}

fn new_instance() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.write_u32(std::process::id());
    format!("{:016x}", h.finish())
}

/// `paw --daemon`: start serving (called from setup).
pub fn start_daemon(app: &AppHandle) {
    let server = Arc::new(Server::default());
    app.manage(DaemonState { server: server.clone(), instance: new_instance(), pending: Mutex::default() });
    for &ev in EVENTS {
        let s = server.clone();
        app.listen_any(ev, move |e| {
            if let Ok(v) = serde_json::from_str::<Value>(e.payload()) {
                s.publish(ev, v);
            }
        });
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        match Server::bind(&socket_path()).await {
            Ok(listener) => server.serve(listener, Arc::new(TauriHandler { app: app2 })).await,
            Err(e) => {
                eprintln!("Paw daemon: {e}");
                app2.exit(0);
            }
        }
    });
}

/// The menu bar's Open Paw (or a tab picked there): the window shows, or starts.
pub fn open_window(app: &AppHandle, tab: Option<String>, settings: bool) {
    let st = app.state::<DaemonState>();
    if st.server.clients.load(Ordering::SeqCst) > 0 {
        st.server.publish("daemon:show", json!({ "tab": tab, "settings": settings }));
        return;
    }
    *st.pending.lock().unwrap() = PendingOpen { tab, settings };
    if let Err(e) = start_window() {
        eprintln!("Paw daemon: couldn't open the window: {e}");
    }
}

/// Quit everything: the windows first, then the daemon (its exit stops the agents).
pub fn quit_all(app: &AppHandle) {
    app.state::<DaemonState>().server.publish("daemon:quit", json!({}));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        app.exit(0);
    });
}

/// Launch the window app: through LaunchServices inside an app bundle (a new
/// instance, as the daemon is one too), else the executable itself.
fn start_window() -> std::io::Result<()> {
    let exe = std::env::current_exe()?;
    let bundle = exe.ancestors().nth(3).filter(|p| p.extension().is_some_and(|x| x == "app")).map(|p| p.to_path_buf());
    let mut cmd = match bundle {
        Some(b) => {
            let mut c = std::process::Command::new("/usr/bin/open");
            c.arg("-n").arg(b);
            c
        }
        None => std::process::Command::new(exe),
    };
    use std::os::unix::process::CommandExt;
    cmd.stdin(std::process::Stdio::null()).process_group(0).spawn().map(|_| ())
}

struct TauriHandler {
    app: AppHandle,
}

impl Handler for TauriHandler {
    fn call(&self, cmd: String, args: Value) -> BoxFut {
        let app = self.app.clone();
        Box::pin(async move { dispatch(app, cmd, args).await })
    }
}

fn factory_runner(app: &AppHandle) -> Arc<crate::factories::runner::Runner> {
    app.state::<Arc<crate::factories::runner::Runner>>().inner().clone()
}

fn arg<T: serde::de::DeserializeOwned>(a: &Value, k: &str) -> Result<T, String> {
    serde_json::from_value(a.get(k).cloned().unwrap_or(Value::Null)).map_err(|e| format!("{k}: {e}"))
}

fn ok<T: Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

async fn dispatch(app: AppHandle, cmd: String, a: Value) -> Result<Value, String> {
    use crate::{agents, paw_agent, shell};
    match cmd.as_str() {
        "daemon_hello" => {
            let st = app.state::<DaemonState>();
            let pending = std::mem::take(&mut *st.pending.lock().unwrap());
            Ok(json!({
                "instance": st.instance,
                "version": env!("CARGO_PKG_VERSION"),
                "pid": std::process::id(),
                "last": st.server.log.lock().unwrap().last(),
                "open": pending,
            }))
        }
        // A window that comes back: which of its processes still run, and what it missed.
        "daemon_attach" => {
            let procs: Vec<u32> = arg(&a, "procs")?;
            let shells: Vec<u32> = arg(&a, "shells")?;
            let after: u64 = arg::<Option<u64>>(&a, "after")?.unwrap_or(0);
            let mut alive = serde_json::Map::new();
            for id in &procs {
                let info = app.state::<agents::AgentManager>().info(*id).map(|i| json!({ "info": i, "paw": false }))
                    .or_else(|| app.state::<paw_agent::PawAgents>().get(*id).map(|s| json!({ "info": s.info(), "paw": true, "working": s.working() })));
                if let Some(v) = info {
                    alive.insert(id.to_string(), v);
                }
            }
            let shells_alive: Vec<u32> = shells.iter().copied().filter(|id| app.state::<shell::ShellManager>().alive(*id)).collect();
            let events = app.state::<DaemonState>().server.log.lock().unwrap().since(&procs, &shells_alive, after);
            Ok(json!({ "procs": alive, "shells": shells_alive, "events": events }))
        }
        "tray_update" => {
            crate::menubar::tray_update(app.clone(), arg(&a, "tabs")?, arg(&a, "working")?)?;
            Ok(Value::Null)
        }
        // Deprecated: CLI agents (feature "cli-agents"). Without it these answer `agents::CLI_AGENTS_OFF`.
        "spawn_agent" => ok(agents::spawn_agent(
            app.clone(), app.state(), arg(&a, "name")?, arg(&a, "command")?, arg(&a, "cwd")?, arg(&a, "env")?, arg(&a, "no_stdin")?,
        )?),
        "send_input" => ok(agents::send_input(app.clone(), app.state(), arg(&a, "id")?, arg(&a, "text")?)?),
        "close_input" => ok(agents::close_input(app.state(), arg(&a, "id")?)?),
        "stop_agent" => ok(agents::stop_agent(app.state(), arg(&a, "id")?, arg(&a, "force")?)?),
        "remove_agent" => ok(agents::remove_agent(app.state(), arg(&a, "id")?)?),
        "list_agents" => ok(agents::list_agents(app.state())),
        "agent_output" => ok(agents::agent_output(app.state(), arg(&a, "id")?)),
        "shell_open" => ok(shell::shell_open(app.clone(), app.state(), arg(&a, "cwd")?)?),
        "shell_run" => ok(shell::shell_run(app.state(), arg(&a, "id")?, arg(&a, "command")?, arg(&a, "raw")?)?),
        "shell_write" => ok(shell::shell_write(app.state(), arg(&a, "id")?, arg(&a, "text")?)?),
        "shell_interrupt" => ok(shell::shell_interrupt(app.state(), arg(&a, "id")?)?),
        "shell_close" => {
            shell::shell_close(app.state(), arg(&a, "id")?);
            Ok(Value::Null)
        }
        "shell_write_raw" => ok(shell::shell_write_raw(app.state(), arg(&a, "id")?, arg(&a, "data")?)?),
        "shell_resize" => ok(shell::shell_resize(app.state(), arg(&a, "id")?, arg(&a, "cols")?, arg(&a, "rows")?)?),
        "shell_raw_exit" => ok(shell::shell_raw_exit(app.state(), arg(&a, "id")?)?),
        "paw_agent_start" => {
            // The window may have changed settings (skills, MCP) since.
            app.state::<crate::registry::Registry>().forget();
            ok(paw_agent::paw_agent_start(app.clone(), app.state(), app.state(), arg(&a, "opts")?).await?)
        }
        "paw_agent_send" => ok(paw_agent::paw_agent_send(app.state(), arg(&a, "id")?, arg(&a, "text")?).await?),
        "paw_agent_note" => ok(paw_agent::paw_agent_note(app.state(), arg(&a, "id")?, arg(&a, "text")?).await?),
        "paw_agent_cancel" => ok(paw_agent::paw_agent_cancel(app.state(), arg(&a, "id")?).await?),
        "paw_agent_close" => ok(paw_agent::paw_agent_close(app.state(), arg(&a, "id")?).await?),
        "paw_agent_approve" => ok(paw_agent::paw_agent_approve(app.state(), arg(&a, "id")?, arg(&a, "request")?, arg(&a, "decision")?, arg(&a, "rule")?).await?),
        // Factories (factories::runner): they run here, in the background.
        "factory_list" => {
            crate::factories::runner::remember_window_model(arg(&a, "model")?);
            let mut v = factory_runner(&app).list();
            v["triggers"] = app.state::<Arc<crate::factories::triggers::Triggers>>().status();
            Ok(v)
        }
        "factory_pause" => {
            app.state::<Arc<crate::factories::triggers::Triggers>>().set_paused(&arg::<String>(&a, "factory")?, arg(&a, "paused")?);
            Ok(Value::Null)
        }
        "factory_get" => ok(factory_runner(&app).get(&arg::<String>(&a, "run")?)),
        "factory_run" => {
            crate::factories::runner::remember_window_model(arg(&a, "model")?);
            // In the factory's folder, or another project's; payload: the task for this run.
            ok(factory_runner(&app).start(&arg::<String>(&a, "factory")?, "manual", arg(&a, "payload")?, arg(&a, "folder")?)?)
        }
        "factory_stop" => ok(factory_runner(&app).stop(&arg::<String>(&a, "run")?)?),
        "factory_retry" => ok(factory_runner(&app).retry(&arg::<String>(&a, "run")?, &arg::<String>(&a, "node")?)?),
        "factory_skip" => ok(factory_runner(&app).skip(&arg::<String>(&a, "run")?, &arg::<String>(&a, "node")?)?),
        "factory_new" => ok(crate::factories::create(&arg::<String>(&a, "name")?)?),
        other => Err(format!("The daemon doesn't run “{other}”")),
    }
}

// ---------------------------------------------------------------------------
// The window's side: connect (starting the daemon if needed), pass calls on
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct Link {
    client: tokio::sync::RwLock<Option<Arc<Client>>>,
    hello: Mutex<Option<Value>>,
    up: tokio::sync::Notify,
}

impl Link {
    async fn current(&self, wait: std::time::Duration) -> Result<Arc<Client>, String> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            if let Some(c) = self.client.read().await.clone() {
                return Ok(c);
            }
            if tokio::time::timeout_at(deadline, self.up.notified()).await.is_err() {
                return Err("Paw's background process didn't start".into());
            }
        }
    }
}

fn start_daemon_process() -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    let log_path = crate::paths::home().unwrap_or_else(std::env::temp_dir).join("daemon.log");
    if std::fs::metadata(&log_path).map(|m| m.len() > 5_000_000).unwrap_or(false) {
        let _ = std::fs::rename(&log_path, log_path.with_extension("log.1"));
    }
    let log = std::fs::OpenOptions::new().create(true).append(true).open(&log_path)?;
    std::process::Command::new(std::env::current_exe()?)
        .arg("--daemon")
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0)
        .spawn()
        .map(|_| ())
}

async fn connect_or_start() -> std::io::Result<(Client, mpsc::UnboundedReceiver<(String, Value)>)> {
    let path = socket_path();
    if let Ok(c) = Client::connect(&path).await {
        return Ok(c);
    }
    start_daemon_process()?;
    let mut last = None;
    for _ in 0..100 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        match Client::connect(&path).await {
            Ok(c) => return Ok(c),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("no daemon")))
}

/// The window: keep a connection to the daemon (starting it when it isn't
/// running) and turn its events into the window's events.
pub fn start_link(app: &AppHandle) {
    app.manage(Link::default());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let link = app.state::<Link>();
        let mut first = true;
        loop {
            let (client, mut events) = match connect_or_start().await {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Paw: can't reach the daemon: {e}");
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    continue;
                }
            };
            let client = Arc::new(client);
            let hello = client.call("daemon_hello", json!({})).await.unwrap_or(Value::Null);
            *link.hello.lock().unwrap() = Some(hello.clone());
            *link.client.write().await = Some(client);
            link.up.notify_waiters();
            if !first {
                let _ = app.emit("daemon:up", hello.clone());
            }
            first = false;
            follow_pending(&app, &hello["open"]);
            while let Some((name, payload)) = events.recv().await {
                match name.as_str() {
                    "daemon:show" => follow_pending(&app, &payload),
                    "daemon:quit" => app.exit(0),
                    _ => {
                        let _ = app.emit(&name, payload);
                    }
                }
            }
            // The daemon went away (it was quit, or crashed): start a new one.
            *link.client.write().await = None;
            *link.hello.lock().unwrap() = None;
            let _ = app.emit("daemon:lost", ());
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    });
}

/// "Show the window (on this tab, or Settings)" from the menu bar.
fn follow_pending(app: &AppHandle, v: &Value) {
    if v.is_null() || v.as_object().is_some_and(|m| m.is_empty()) {
        return;
    }
    crate::menubar::show_main(app);
    if let Some(tab) = v.get("tab").and_then(Value::as_str) {
        let _ = app.emit_to("main", "tray:open", tab.to_string());
    }
    if v.get("settings").and_then(Value::as_bool).unwrap_or(false) {
        let _ = crate::show_preferences(app, None);
    }
}

/// A daemon command from the window (JavaScript's `invoke` passes them here).
#[tauri::command]
pub async fn daemon_call(link: tauri::State<'_, Link>, cmd: String, args: Option<Value>) -> Result<Value, String> {
    if !COMMANDS.contains(&cmd.as_str()) {
        return Err(format!("“{cmd}” isn't a daemon command"));
    }
    let client = link.current(std::time::Duration::from_secs(15)).await?;
    client.call(&cmd, args.unwrap_or(Value::Null)).await
}

/// Which daemon the window talks to (its instance changes when it restarts).
#[tauri::command]
pub async fn daemon_hello(link: tauri::State<'_, Link>) -> Result<Value, String> {
    link.current(std::time::Duration::from_secs(15)).await?;
    Ok(link.hello.lock().unwrap().clone().unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_keeps_events_per_process() {
        let mut log = EventLog::default();
        let a = log.push("agent:output", &json!({ "id": 3, "text": "a" }));
        log.push("paw:delta", &json!({ "id": 3, "text": "typing" }));
        log.push("shell:output", &json!({ "id": 9, "lines": ["x"] }));
        let c = log.push("agent:status", &json!({ "id": 3, "status": "exited" }));
        log.push("shell:exit", &json!(9));
        assert_eq!(log.last(), 5);
        let got = log.since(&[3], &[], 0);
        assert_eq!(got.iter().map(|l| l.dseq).collect::<Vec<_>>(), vec![a, c], "deltas aren't kept");
        assert_eq!(log.since(&[3], &[9], a).len(), 3);
        assert!(log.since(&[42], &[], 0).is_empty());
        // Agent 9 and shell 9 are different processes.
        assert!(log.since(&[9], &[], 0).is_empty());
        assert_eq!(log.since(&[], &[9], 0).len(), 2);
        for i in 0..(LOG_PER_ID + 10) {
            log.push("agent:output", &json!({ "id": 7, "n": i }));
        }
        assert_eq!(log.since(&[7], &[], 0).len(), LOG_PER_ID);
    }

    #[test]
    fn javascript_names_become_rust_names() {
        let v = snake_keys(json!({ "noStdin": true, "id": 3, "pawSession": "x" }));
        assert_eq!(v, json!({ "no_stdin": true, "id": 3, "paw_session": "x" }));
    }

    struct Fake;
    impl Handler for Fake {
        fn call(&self, cmd: String, args: Value) -> BoxFut {
            Box::pin(async move {
                match cmd.as_str() {
                    "echo" => Ok(args),
                    _ => Err(format!("no {cmd}")),
                }
            })
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn window_and_daemon_talk() {
        let path = std::env::temp_dir().join(format!("paw-test-{}.sock", std::process::id()));
        let server = Arc::new(Server::default());
        let listener = Server::bind(&path).await.unwrap();
        assert!(Server::bind(&path).await.is_err(), "one daemon at a time");
        tokio::spawn(server.clone().serve(listener, Arc::new(Fake)));

        let (client, mut events) = Client::connect(&path).await.unwrap();
        assert_eq!(client.call("echo", json!({ "noStdin": 1 })).await.unwrap(), json!({ "no_stdin": 1 }));
        assert_eq!(client.call("nope", json!({})).await.unwrap_err(), "no nope");
        // Wait until the server has registered the client, then publish.
        for _ in 0..50 {
            if server.clients.load(Ordering::SeqCst) == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        server.publish("agent:output", json!({ "id": 1, "text": "hi" }));
        let (name, payload) = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv()).await.unwrap().unwrap();
        assert_eq!(name, "agent:output");
        assert_eq!((payload["text"].as_str(), payload["__dseq"].as_u64()), (Some("hi"), Some(1)));
        // Several at once, each answered.
        let calls = (0..20).map(|i| client.call("echo", json!({ "n": i })));
        let replies = futures::future::join_all(calls).await;
        assert!(replies.iter().enumerate().all(|(i, r)| r.as_ref().unwrap()["n"] == i));
        let _ = std::fs::remove_file(&path);
    }
}
