//! What starts factory runs besides Run now, in the background process:
//!
//! - `every: 15m`: a run every so often (the first one `every` after Paw starts).
//! - `at: "09:00, 17:30"`: a run at these times of day.
//! - `watch: <command>` + `every`: the command is checked that often; a run
//!   starts when it *starts* succeeding (it has to fail before it fires again,
//!   so a long spike starts one run, not one per check).
//! - `webhook: true` (or a secret): `POST http://127.0.0.1:<port>/factories/<id>`
//!   starts a run; the request's body goes to the nodes as the trigger payload.
//! - `file: <path>`: a run when the file (or anything in the folder) changes,
//!   once it has been quiet for a moment.
//!
//! A trigger has at most `parallel` runs of a factory going at once (default 1);
//! what fires beyond that waits its turn (one waiting run per project folder).
//! A webhook can name the project folder a run works in (`?folder=` or an
//! `X-Paw-Folder` header). A factory's trigger can be paused (kept in
//! `~/.paw/factories/.paused.json`).

use super::runner::Runner;
use super::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};
use tauri::{AppHandle, Manager};

pub const DEFAULT_PORT: u16 = 4747;
const RESCAN: Duration = Duration::from_secs(5);
const FILE_POLL: Duration = Duration::from_secs(2);
const FILE_QUIET: Duration = Duration::from_secs(2);
const BODY_LIMIT: usize = 1 << 20;
const FILE_LIMIT: usize = 5000; // files looked at under a watched folder

#[derive(Debug, Clone, Serialize, Default)]
pub struct Check {
    pub at: u64,
    pub ok: bool,
    pub output: String,
}

/// One factory's trigger, as windows see it.
#[derive(Debug, Clone, Serialize, Default)]
pub struct Status {
    pub kinds: Vec<String>,
    pub paused: bool,
    /// When `every` or `at` starts the next run (ms since the epoch).
    pub next: Option<u64>,
    pub last_fired: Option<u64>,
    /// What happened the last time it fired ("started", or why it didn't).
    pub last_note: String,
    pub last_check: Option<Check>,
    pub webhook: Option<String>,
    pub webhook_secret: bool,
    pub watching_file: Option<String>,
}

#[derive(Default)]
struct Entry {
    modified: u64,
    trigger: Option<Trigger>,
    folder: PathBuf,
    status: Status,
    next_due: Option<Instant>,
    next_check: Option<Instant>,
    checking: bool,
    was_ok: Option<bool>,
    fired_at: HashSet<String>, // "<day>-<hh:mm>" already fired
    file_sig: Option<(u64, usize)>,
    file_changed: Option<Instant>,
    next_file_poll: Option<Instant>,
    /// Runs triggers may have going at once (the factory's `parallel`).
    parallel: usize,
    /// Fired while there was no room: starts when a run ends.
    queued: Vec<Fired>,
}

/// A trigger that fired: why, its payload, the project folder ("": the factory's).
#[derive(Debug, Clone, Default)]
struct Fired {
    why: String,
    payload: Option<String>,
    folder: String,
}

const QUEUE_MAX: usize = 20;

impl Entry {
    /// Wait for room; a later event for the same folder replaces an earlier one.
    fn enqueue(&mut self, f: Fired) {
        self.queued.retain(|q| q.folder != f.folder);
        if self.queued.len() < QUEUE_MAX {
            self.queued.push(f);
        }
    }
}

pub struct Triggers {
    app: AppHandle,
    runner: Arc<Runner>,
    entries: Mutex<HashMap<String, Entry>>,
    paused: Mutex<HashSet<String>>,
    pub port: u16,
    server: Mutex<Option<String>>, // the webhook server's error, if it couldn't start
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Local time: (a day number, hour, minute).
fn local_now() -> (i64, u32, u32) {
    let t = unsafe { libc::time(std::ptr::null_mut()) };
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&t, &mut tm) };
    (tm.tm_year as i64 * 400 + tm.tm_yday as i64, tm.tm_hour as u32, tm.tm_min as u32)
}

/// When the next `at` time comes, in ms since the epoch.
fn next_at(times: &[(u32, u32)]) -> Option<u64> {
    let (_, h, m) = local_now();
    let now_min = h * 60 + m;
    let mins = times.iter().map(|(h, m)| h * 60 + m).map(|t| if t > now_min { t - now_min } else { t + 24 * 60 - now_min }).min()?;
    let secs = SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some((secs - secs % 60 + mins as u64 * 60) * 1000)
}

fn paused_path() -> Option<PathBuf> {
    super::runner::factories_dir().map(|d| d.join(".paused.json"))
}

/// (newest modification, how many files) of a file or a folder's files.
fn file_signature(path: &Path) -> Option<(u64, usize)> {
    let mtime = |m: &std::fs::Metadata| m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_dir() {
        return Some((mtime(&meta), 1));
    }
    let (mut newest, mut count) = (mtime(&meta), 0usize);
    let mut todo = vec![path.to_path_buf()];
    while let Some(dir) = todo.pop() {
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = e.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue; // .git and such
            }
            let Ok(m) = e.metadata() else { continue };
            newest = newest.max(mtime(&m));
            count += 1;
            if count > FILE_LIMIT {
                return Some((newest, count));
            }
            if m.is_dir() {
                todo.push(e.path());
            }
        }
    }
    Some((newest, count))
}

impl Triggers {
    pub fn new(app: &AppHandle, runner: Arc<Runner>) -> Arc<Triggers> {
        let paused: HashSet<String> = paused_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
            .unwrap_or_default()
            .into_iter()
            .collect();
        let port = crate::paths::home()
            .and_then(|h| std::fs::read_to_string(h.join("settings.json")).ok())
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.pointer("/factories/webhook_port").and_then(Value::as_u64))
            .and_then(|p| u16::try_from(p).ok())
            .unwrap_or(DEFAULT_PORT);
        for id in &paused {
            runner.set_paused(id, true);
        }
        let t = Arc::new(Triggers { app: app.clone(), runner, entries: Mutex::default(), paused: Mutex::new(paused), port, server: Mutex::default() });
        let me = t.clone();
        tauri::async_runtime::spawn(async move {
            let mut last_scan: Option<Instant> = None;
            loop {
                if last_scan.is_none_or(|s| s.elapsed() >= RESCAN) {
                    me.rescan();
                    last_scan = Some(Instant::now());
                }
                me.tick();
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
        let me = t.clone();
        tauri::async_runtime::spawn(async move { me.serve().await });
        t
    }

    /// Read the factory files again; a changed file starts its trigger afresh.
    fn rescan(&self) {
        let found = super::runner::factories_dir().as_deref().map(load_all).unwrap_or_default();
        let mut changed = false;
        {
            let mut entries = self.entries.lock().unwrap();
            let paused = self.paused.lock().unwrap().clone();
            let wants = |x: &Factory| x.trigger.is_some() || repeat_of(x).is_some();
            entries.retain(|id, _| found.iter().any(|f| &f.id == id && f.factory.as_ref().is_some_and(wants)));
            for f in &found {
                let Some(def) = f.factory.as_ref().filter(|d| wants(d)) else { continue };
                let none = Trigger::default();
                let trig = def.trigger.as_ref().unwrap_or(&none);
                if entries.get(&f.id).is_some_and(|e| e.modified == f.modified && e.trigger.as_ref() == Some(trig)) {
                    continue;
                }
                changed = true;
                let folder = {
                    let d = def.folder.trim();
                    crate::agents::expand_home(if d.is_empty() { "~" } else { d })
                };
                let every = trig.every.as_deref().and_then(parse_duration);
                let mut e = Entry { modified: f.modified, trigger: Some(trig.clone()), folder: folder.clone(), parallel: def.parallel_runs(), ..Default::default() };
                let mut old = entries.remove(&f.id);
                e.queued = old.as_mut().map(|o| std::mem::take(&mut o.queued)).unwrap_or_default();
                e.status = Status {
                    kinds: [
                        trig.watch.as_ref().map(|_| "watch"),
                        (trig.every.is_some() && trig.watch.is_none()).then_some("every"),
                        trig.at.as_ref().map(|_| "at"),
                        webhook_secret(trig).map(|_| "webhook"),
                        trig.file.as_ref().map(|_| "file"),
                        repeat_of(def).map(|_| "repeat"),
                    ]
                    .into_iter()
                    .flatten()
                    .map(String::from)
                    .collect(),
                    paused: paused.contains(&f.id),
                    last_fired: old.as_ref().and_then(|o| o.status.last_fired),
                    last_note: old.as_ref().map(|o| o.status.last_note.clone()).unwrap_or_default(),
                    webhook: webhook_secret(trig).map(|_| format!("http://127.0.0.1:{}/factories/{}", self.port, f.id)),
                    webhook_secret: webhook_secret(trig).is_some_and(|s| !s.is_empty()),
                    watching_file: trig.file.as_ref().map(|p| {
                        let p = p.trim();
                        if p.starts_with('/') || p.starts_with('~') { crate::agents::expand_home(p) } else { folder.join(p) }.to_string_lossy().into_owned()
                    }),
                    ..Default::default()
                };
                if trig.watch.is_some() {
                    e.next_check = Some(Instant::now()); // check right away
                } else if let Some(d) = every {
                    e.next_due = Some(Instant::now() + d);
                }
                if let Some(path) = &e.status.watching_file {
                    e.file_sig = file_signature(Path::new(path));
                    e.next_file_poll = Some(Instant::now() + FILE_POLL);
                }
                entries.insert(f.id.clone(), e);
            }
        }
        if changed {
            self.publish();
        }
    }

    /// Once a second: start what's due.
    fn tick(self: &Arc<Self>) {
        let now = Instant::now();
        let today = local_now();
        let mut fire: Vec<(String, Fired)> = vec![];
        let mut checks: Vec<(String, String, PathBuf)> = vec![];
        {
            let mut entries = self.entries.lock().unwrap();
            for (id, e) in entries.iter_mut() {
                let Some(t) = e.trigger.clone() else { continue };
                // The next `every`/`at` time, for the view.
                let next_every = e.next_due.map(|d| now_ms() + d.saturating_duration_since(now).as_millis() as u64);
                let next_at = t.at.as_deref().and_then(at_times).and_then(|ts| next_at(&ts));
                let next = [next_every, next_at].into_iter().flatten().min();
                if e.status.next != next {
                    e.status.next = next;
                }
                if e.status.paused {
                    continue;
                }
                // Fired when there was no room: their turn comes as runs end.
                if !e.queued.is_empty() {
                    let room = e.parallel.max(1).saturating_sub(self.runner.running(id));
                    for f in e.queued.drain(..room.min(e.queued.len())) {
                        fire.push((id.clone(), f));
                    }
                }
                if let (Some(cmd), Some(due)) = (&t.watch, e.next_check) {
                    if now >= due && !e.checking {
                        e.checking = true;
                        e.next_check = Some(now + t.every.as_deref().and_then(parse_duration).unwrap_or(Duration::from_secs(60)));
                        checks.push((id.clone(), cmd.clone(), e.folder.clone()));
                    }
                } else if let Some(due) = e.next_due {
                    if now >= due {
                        e.next_due = Some(now + t.every.as_deref().and_then(parse_duration).unwrap_or(Duration::from_secs(3600)));
                        fire.push((id.clone(), Fired { why: format!("every {}", t.every.as_deref().unwrap_or("")), ..Default::default() }));
                    }
                }
                if let Some(times) = t.at.as_deref().and_then(at_times) {
                    let (day, h, m) = today;
                    if let Some((h, m)) = times.into_iter().find(|&(th, tm)| th == h && tm == m) {
                        let key = format!("{day}-{h:02}:{m:02}");
                        if e.fired_at.insert(key) {
                            fire.push((id.clone(), Fired { why: format!("at {h:02}:{m:02}"), ..Default::default() }));
                        }
                    }
                }
                if let (Some(path), Some(poll)) = (e.status.watching_file.clone(), e.next_file_poll) {
                    if now >= poll {
                        e.next_file_poll = Some(now + FILE_POLL);
                        let sig = file_signature(Path::new(&path));
                        if sig != e.file_sig {
                            e.file_sig = sig;
                            e.file_changed = Some(now);
                        } else if e.file_changed.is_some_and(|c| now.duration_since(c) >= FILE_QUIET) {
                            e.file_changed = None;
                            fire.push((id.clone(), Fired { why: "a file change".into(), payload: Some(format!("{path} changed.")), ..Default::default() }));
                        }
                    }
                }
            }
        }
        for (id, cmd, folder) in checks {
            let me = self.clone();
            tauri::async_runtime::spawn(async move {
                let out = tauri::async_runtime::spawn_blocking(move || super::runner::check(&cmd, &folder)).await.unwrap_or_else(|e| (false, e.to_string()));
                let fire = {
                    let mut entries = me.entries.lock().unwrap();
                    let Some(e) = entries.get_mut(&id) else { return };
                    e.checking = false;
                    // fires: each — every success is a new event; else only a change to success.
                    let each = e.trigger.as_ref().and_then(|t| t.fires.as_deref()) == Some("each");
                    let rose = out.0 && (each || e.was_ok != Some(true));
                    e.was_ok = Some(out.0);
                    e.status.last_check = Some(Check { at: now_ms(), ok: out.0, output: out.1.chars().rev().take(400).collect::<String>().chars().rev().collect() });
                    rose && !e.status.paused
                };
                if fire {
                    me.fire(&id, Fired { why: "its watch".into(), payload: Some(out.1), ..Default::default() });
                }
                me.publish();
            });
        }
        for (id, f) in fire {
            self.fire(&id, f);
        }
    }

    /// Is there room for one more run from a trigger?
    fn room(&self, id: &str) -> bool {
        let parallel = self.entries.lock().unwrap().get(id).map_or(1, |e| e.parallel.max(1));
        self.runner.running(id) < parallel
    }

    /// Start a run (if there's room, else it waits its turn); what happened,
    /// and the run's execution id.
    fn fire(self: &Arc<Self>, id: &str, f: Fired) -> (String, Option<String>) {
        let why = f.why.clone();
        let (note, run) = if !self.room(id) {
            if let Some(e) = self.entries.lock().unwrap().get_mut(id) {
                e.enqueue(f);
            }
            (format!("{why}: runs were going, so another starts when one ends"), None)
        } else {
            let folder = Some(f.folder).filter(|s| !s.is_empty());
            match self.runner.start(id, &why, f.payload, folder) {
                Ok(run) => (format!("{why}: started a run"), Some(run)),
                Err(e) => (format!("{why}: couldn't start ({e})"), None),
            }
        };
        if let Some(e) = self.entries.lock().unwrap().get_mut(id) {
            e.status.last_fired = Some(now_ms());
            e.status.last_note = note.clone();
        }
        self.publish();
        (note, run)
    }

    pub fn set_paused(&self, id: &str, paused: bool) {
        self.runner.set_paused(id, paused);
        {
            let mut p = self.paused.lock().unwrap();
            if paused {
                p.insert(id.to_string());
            } else {
                p.remove(id);
            }
            if let Some(path) = paused_path() {
                let list: Vec<&String> = p.iter().collect();
                let _ = std::fs::write(path, serde_json::to_string(&list).unwrap_or_default());
            }
        }
        if let Some(e) = self.entries.lock().unwrap().get_mut(id) {
            e.status.paused = paused;
            if !paused {
                // Coming back: a watch looks again now; `every` counts afresh.
                e.was_ok = None;
                if e.trigger.as_ref().is_some_and(|t| t.watch.is_some()) {
                    e.next_check = Some(Instant::now());
                } else if let Some(d) = e.trigger.as_ref().and_then(|t| t.every.as_deref()).and_then(parse_duration) {
                    e.next_due = Some(Instant::now() + d);
                }
            }
        }
        self.publish();
    }

    pub fn status(&self) -> Value {
        let entries = self.entries.lock().unwrap();
        let map: serde_json::Map<String, Value> = entries.iter().map(|(id, e)| (id.clone(), serde_json::to_value(&e.status).unwrap_or(Value::Null))).collect();
        json!({ "port": self.port, "server_error": *self.server.lock().unwrap(), "factories": map })
    }

    fn publish(&self) {
        if let Some(d) = self.app.try_state::<crate::daemon::DaemonState>() {
            d.server.publish("factory:triggers", json!({ "triggers": self.status() }));
        }
    }

    // ---------- the webhook ----------

    async fn serve(self: Arc<Self>) {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", self.port)).await {
            Ok(l) => l,
            Err(e) => {
                *self.server.lock().unwrap() = Some(format!("Webhooks can't listen on port {}: {e}", self.port));
                return;
            }
        };
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let me = self.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(15), me.handle(stream)).await;
            });
        }
    }

    async fn handle(self: &Arc<Self>, mut stream: tokio::net::TcpStream) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        // Headers, then as much body as Content-Length says.
        let head_end = loop {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
            if buf.len() > 64 * 1024 {
                return;
            }
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
        let mut lines = head.lines();
        let mut first = lines.next().unwrap_or("").split_whitespace();
        let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
        let headers: HashMap<String, String> =
            lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
        let length: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
        let (code, body) = if length > BODY_LIMIT {
            (413, json!({ "error": "The body is too large (1 MB at most)." }))
        } else {
            while buf.len() < head_end + length {
                match stream.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
            let body = String::from_utf8_lossy(&buf[head_end..(head_end + length).min(buf.len())]).into_owned();
            self.route(method, target, &headers, body)
        };
        let text = body.to_string();
        let reason = match code {
            202 => "Accepted",
            200 => "OK",
            401 => "Unauthorized",
            404 => "Not Found",
            405 => "Method Not Allowed",
            409 => "Conflict",
            413 => "Payload Too Large",
            _ => "Error",
        };
        let reply = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
        let _ = stream.write_all(reply.as_bytes()).await;
        let _ = stream.shutdown().await;
    }

    fn route(self: &Arc<Self>, method: &str, target: &str, headers: &HashMap<String, String>, body: String) -> (u16, Value) {
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
        if parts.first() != Some(&"factories") {
            return (404, json!({ "error": "Use POST /factories/<id>." }));
        }
        let Some(id) = parts.get(1).filter(|id| valid_id(id)) else {
            // GET /factories: which factories take webhooks.
            let entries = self.entries.lock().unwrap();
            let ids: Vec<&String> = entries.iter().filter(|(_, e)| e.status.webhook.is_some()).map(|(id, _)| id).collect();
            return (200, json!({ "factories": ids }));
        };
        if method != "POST" {
            return (405, json!({ "error": "Use POST." }));
        }
        let secret = {
            let entries = self.entries.lock().unwrap();
            match entries.get(*id).and_then(|e| e.trigger.as_ref()).and_then(webhook_secret) {
                Some(s) => s,
                None => return (404, json!({ "error": format!("No factory “{id}” takes webhooks (give it trigger: webhook: true).") })),
            }
        };
        if !secret.is_empty() {
            let given = headers.get("x-paw-token").cloned().or_else(|| {
                query.split('&').find_map(|kv| kv.strip_prefix("token=")).map(str::to_string)
            });
            if given.as_deref() != Some(secret.as_str()) {
                return (401, json!({ "error": "Wrong or missing token (X-Paw-Token header, or ?token=)." }));
            }
        }
        if self.entries.lock().unwrap().get(*id).is_some_and(|e| e.status.paused) {
            return (409, json!({ "error": "This factory's trigger is paused." }));
        }
        // The project folder this run works in, if the caller names one.
        let folder = headers
            .get("x-paw-folder")
            .cloned()
            .or_else(|| query.split('&').find_map(|kv| kv.strip_prefix("folder=")).map(url_decode))
            .map(|f| f.trim().to_string())
            .unwrap_or_default();
        if !folder.is_empty() && !crate::agents::expand_home(&folder).is_dir() {
            return (400, json!({ "error": format!("The folder doesn't exist: {folder}") }));
        }
        let payload = (!body.trim().is_empty()).then_some(body);
        match self.fire(id, Fired { why: "its webhook".into(), payload, folder }) {
            (_, Some(run)) => (202, json!({ "run": run })),
            (note, None) if note.contains("couldn't start") => (500, json!({ "error": note })),
            _ => (202, json!({ "queued": true })),
        }
    }

}

/// `%xx` and `+` in a query value.
fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => match std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                Some(x) => {
                    out.push(x);
                    i += 2;
                }
                None => out.push(b'%'),
            },
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_values_are_decoded() {
        assert_eq!(url_decode("~%2FDeveloper%2Fmy+app"), "~/Developer/my app");
        assert_eq!(url_decode("100%"), "100%");
        assert_eq!(url_decode("a%zzb"), "a%zzb");
    }

    #[test]
    fn a_later_event_for_a_folder_replaces_its_earlier_one() {
        let mut e = Entry::default();
        e.enqueue(Fired { why: "1".into(), folder: "a".into(), ..Default::default() });
        e.enqueue(Fired { why: "2".into(), folder: "b".into(), ..Default::default() });
        e.enqueue(Fired { why: "3".into(), folder: "a".into(), ..Default::default() });
        assert_eq!(e.queued.iter().map(|f| f.why.as_str()).collect::<Vec<_>>(), ["2", "3"]);
    }

    #[test]
    fn next_at_is_within_a_day() {
        let n = next_at(&[(0, 0), (12, 0)]).unwrap();
        let now = now_ms();
        assert!(n > now && n <= now + 24 * 3600 * 1000);
    }

    #[test]
    fn a_folder_signature_changes_when_a_file_does() {
        let d = std::env::temp_dir().join(format!("paw-trig-{}", std::process::id()));
        std::fs::create_dir_all(d.join("sub")).unwrap();
        let a = file_signature(&d).unwrap();
        std::fs::write(d.join("sub/new.txt"), "x").unwrap();
        let b = file_signature(&d).unwrap();
        std::fs::remove_dir_all(&d).ok();
        assert_ne!(a, b);
    }
}
