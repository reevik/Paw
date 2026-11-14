//! Agent process management.
//!
//! Every agent is a plain child process with piped stdin/stdout/stderr — no PTY.
//! It runs through the user's login shell (`$SHELL -lc <command>`) so that PATH
//! and friends match what the user has in their terminal (GUI apps on macOS get a
//! minimal environment otherwise). Each agent gets its own process group, so
//! stopping it also stops anything it spawned.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const MAX_BUFFERED_LINES: usize = 10_000;

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Running,
    Exited,
    Failed,
    Stopped,
}

#[derive(Clone, Serialize, Debug)]
pub struct AgentInfo {
    pub id: u32,
    pub name: String,
    pub command: String,
    pub cwd: String,
    pub pid: i32,
    pub status: Status,
    pub exit_code: Option<i32>,
    pub started_at: u64,
    pub ended_at: Option<u64>,
}

#[derive(Clone, Serialize, Debug)]
pub struct OutputLine {
    pub id: u32,
    pub seq: u64,
    pub stream: &'static str, // "stdout" | "stderr" | "stdin" | "system"
    pub text: String,
    pub ts: u64,
}

struct Agent {
    info: AgentInfo,
    stdin: Option<ChildStdin>,
    lines: VecDeque<OutputLine>,
    seq: u64,
    stop_requested: bool,
}

#[derive(Default)]
pub struct AgentManager {
    next_id: AtomicU32,
    agents: Arc<Mutex<HashMap<u32, Agent>>>,
}

impl AgentManager {
    /// A process id for the UI; Hive Agent sessions take theirs from here too,
    /// so the two never collide.
    pub fn alloc_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn kill_all(&self) {
        let agents = self.agents.lock().unwrap();
        for a in agents.values() {
            if a.info.status == Status::Running {
                unsafe { libc::killpg(a.info.pid, libc::SIGTERM) };
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn expand_home(p: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    if p.is_empty() || p == "~" {
        PathBuf::from(home)
    } else if let Some(rest) = p.strip_prefix("~/") {
        PathBuf::from(home).join(rest)
    } else {
        PathBuf::from(p)
    }
}

/// Record a line in the agent's buffer and push it to the UI.
fn push_line(
    app: &AppHandle,
    agents: &Arc<Mutex<HashMap<u32, Agent>>>,
    id: u32,
    stream: &'static str,
    text: String,
) {
    let line = {
        let mut map = agents.lock().unwrap();
        let Some(agent) = map.get_mut(&id) else { return };
        agent.seq += 1;
        let line = OutputLine { id, seq: agent.seq, stream, text, ts: now_ms() };
        agent.lines.push_back(line.clone());
        if agent.lines.len() > MAX_BUFFERED_LINES {
            agent.lines.pop_front();
        }
        line
    };
    let _ = app.emit("agent:output", line);
}

/// Collapse one line of terminal output to the text a terminal would show,
/// keeping its colors.
///
/// Many CLIs emit spinners and progress bars even when stdout is a pipe. We
/// apply the cursor movements that matter on a single line — `\r`, `\b`,
/// CSI `G` (column), CSI `K` (erase line) — and drop other escape sequences
/// (cursor visibility, OSC titles/links, …). SGR color/style sequences
/// (`ESC [ … m`) are kept: every character remembers the style it was written
/// with, and the result re-emits `ESC [ 0;… m` wherever the style changes, so
/// the UI can paint it with the theme's palette.
pub fn render_terminal_line(input: &str) -> String {
    // styles[0] is the default style; cells point into it.
    let mut styles: Vec<String> = vec![String::new()];
    let mut style = 0usize;
    let mut line: Vec<(char, usize)> = Vec::new();
    let mut cur = 0usize;
    let mut chars = input.chars().peekable();
    let put = |line: &mut Vec<(char, usize)>, cur: &mut usize, c: char, st: usize| {
        if *cur < line.len() {
            line[*cur] = (c, st);
        } else {
            while line.len() < *cur {
                line.push((' ', 0));
            }
            line.push((c, st));
        }
        *cur += 1;
    };
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                Some('[') => {
                    // CSI: parameters/intermediates, then a final byte in @..~
                    let mut params = String::new();
                    let mut fin = None;
                    for p in chars.by_ref() {
                        if ('@'..='~').contains(&p) {
                            fin = Some(p);
                            break;
                        }
                        params.push(p);
                    }
                    let n = |default: usize| -> usize {
                        params.trim_start_matches('?').split(';').next().and_then(|s| s.parse().ok()).unwrap_or(default)
                    };
                    match fin {
                        Some('m') if !params.starts_with('?') && !params.starts_with('>') => {
                            // Accumulate SGR parameters since the last reset.
                            let current = &styles[style];
                            let next = if params.is_empty() || params == "0" {
                                String::new()
                            } else if let Some(rest) = params.strip_prefix("0;") {
                                rest.to_string()
                            } else if current.is_empty() {
                                params.clone()
                            } else {
                                format!("{current};{params}")
                            };
                            style = match styles.iter().position(|s| *s == next) {
                                Some(i) => i,
                                None => {
                                    styles.push(next);
                                    styles.len() - 1
                                }
                            };
                        }
                        Some('G') => cur = n(1).saturating_sub(1),
                        Some('C') => cur += n(1),
                        Some('D') => cur = cur.saturating_sub(n(1)),
                        Some('K') => match n(0) {
                            0 => line.truncate(cur),
                            1 => line.iter_mut().take(cur).for_each(|cell| *cell = (' ', 0)),
                            _ => line.clear(),
                        },
                        _ => {}
                    }
                }
                Some(']') => {
                    // OSC: until BEL or ESC \
                    while let Some(p) = chars.next() {
                        if p == '\x07' {
                            break;
                        }
                        if p == '\x1b' {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {} // two-character escape (ESC 7, ESC =, …): ignore
            },
            '\r' => cur = 0,
            '\x08' => cur = cur.saturating_sub(1),
            '\t' => {
                let next = (cur / 8 + 1) * 8;
                while cur < next {
                    put(&mut line, &mut cur, ' ', style);
                }
            }
            c if c.is_control() => {}
            c => put(&mut line, &mut cur, c, style),
        }
    }
    while matches!(line.last(), Some((c, _)) if c.is_whitespace()) {
        line.pop();
    }
    let mut out = String::with_capacity(line.len());
    let mut active = 0usize;
    for (c, st) in line {
        if st != active {
            if styles[st].is_empty() {
                out.push_str("\x1b[0m");
            } else {
                out.push_str("\x1b[0;");
                out.push_str(&styles[st]);
                out.push('m');
            }
            active = st;
        }
        out.push(c);
    }
    if active != 0 {
        out.push_str("\x1b[0m");
    }
    out
}

fn spawn_reader<R: Read + Send + 'static>(
    app: AppHandle,
    agents: Arc<Mutex<HashMap<u32, Agent>>>,
    id: u32,
    stream: &'static str,
    src: R,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(src);
        let mut buf = Vec::with_capacity(4096);
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    while matches!(buf.last(), Some(b'\n' | b'\r')) {
                        buf.pop();
                    }
                    let text = render_terminal_line(&String::from_utf8_lossy(&buf));
                    // A line that was only a spinner/progress redraw renders to nothing.
                    if text.is_empty() && !buf.is_empty() {
                        continue;
                    }
                    push_line(&app, &agents, id, stream, text);
                }
            }
        }
    })
}

#[tauri::command]
pub fn spawn_agent(
    app: AppHandle,
    state: State<'_, AgentManager>,
    name: String,
    command: String,
    cwd: String,
    env: Option<HashMap<String, String>>,
    // One-shot runs get /dev/null as stdin: several CLIs (e.g. `ollama run`)
    // read a piped stdin to EOF before doing anything.
    no_stdin: Option<bool>,
) -> Result<AgentInfo, String> {
    if command.trim().is_empty() {
        return Err("Command is empty".into());
    }
    let dir = expand_home(cwd.trim());
    if !dir.is_dir() {
        return Err(format!("Working directory does not exist: {}", dir.display()));
    }

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = Command::new(&shell);
    cmd.arg("-lc")
        .arg(&command)
        .current_dir(&dir)
        .stdin(if no_stdin.unwrap_or(false) { Stdio::null() } else { Stdio::piped() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Not a terminal: ask tools to keep their output plain.
        .env("TERM", "dumb")
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .process_group(0);
    if let Some(env) = env {
        cmd.envs(env);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to start: {e}"))?;
    let id = state.alloc_id();
    let info = AgentInfo {
        id,
        name: if name.trim().is_empty() { format!("Agent {id}") } else { name },
        command,
        cwd: dir.display().to_string(),
        pid: child.id() as i32,
        status: Status::Running,
        exit_code: None,
        started_at: now_ms(),
        ended_at: None,
    };

    let agents = state.agents.clone();
    agents.lock().unwrap().insert(
        id,
        Agent {
            info: info.clone(),
            stdin: child.stdin.take(),
            lines: VecDeque::new(),
            seq: 0,
            stop_requested: false,
        },
    );

    let out = spawn_reader(app.clone(), agents.clone(), id, "stdout", child.stdout.take().unwrap());
    let err = spawn_reader(app.clone(), agents.clone(), id, "stderr", child.stderr.take().unwrap());

    // Waiter: drain output first, then report the exit so the UI sees every line.
    let app2 = app.clone();
    thread::spawn(move || {
        let result = child.wait();
        let _ = out.join();
        let _ = err.join();
        let updated = {
            let mut map = agents.lock().unwrap();
            let Some(agent) = map.get_mut(&id) else { return };
            agent.stdin = None;
            agent.info.ended_at = Some(now_ms());
            match result {
                Ok(status) => {
                    agent.info.exit_code = status.code();
                    agent.info.status = if agent.stop_requested {
                        Status::Stopped
                    } else if status.success() {
                        Status::Exited
                    } else {
                        Status::Failed
                    };
                }
                Err(_) => agent.info.status = Status::Failed,
            }
            agent.info.clone()
        };
        let msg = match (updated.status, updated.exit_code) {
            (Status::Stopped, _) => "Process stopped".to_string(),
            (_, Some(c)) => format!("Process exited with code {c}"),
            _ => "Process terminated by signal".to_string(),
        };
        push_line(&app2, &agents, id, "system", msg);
        let _ = app2.emit("agent:status", updated);
    });

    let _ = app.emit("agent:status", info.clone());
    Ok(info)
}

#[tauri::command]
pub fn send_input(
    app: AppHandle,
    state: State<'_, AgentManager>,
    id: u32,
    text: String,
) -> Result<(), String> {
    {
        let mut map = state.agents.lock().unwrap();
        let agent = map.get_mut(&id).ok_or("Unknown agent")?;
        let stdin = agent.stdin.as_mut().ok_or("Input is closed for this agent")?;
        stdin
            .write_all(text.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("Write failed: {e}"))?;
    }
    push_line(&app, &state.agents, id, "stdin", text);
    Ok(())
}

/// Close the agent's stdin (sends EOF) — useful for tools that read until EOF.
#[tauri::command]
pub fn close_input(state: State<'_, AgentManager>, id: u32) -> Result<(), String> {
    let mut map = state.agents.lock().unwrap();
    let agent = map.get_mut(&id).ok_or("Unknown agent")?;
    agent.stdin = None;
    Ok(())
}

#[tauri::command]
pub fn stop_agent(state: State<'_, AgentManager>, id: u32, force: Option<bool>) -> Result<(), String> {
    let mut map = state.agents.lock().unwrap();
    let agent = map.get_mut(&id).ok_or("Unknown agent")?;
    if agent.info.status != Status::Running {
        return Ok(());
    }
    agent.stop_requested = true;
    let sig = if force.unwrap_or(false) { libc::SIGKILL } else { libc::SIGTERM };
    let rc = unsafe { libc::killpg(agent.info.pid, sig) };
    if rc != 0 {
        return Err(format!("kill failed: {}", std::io::Error::last_os_error()));
    }
    Ok(())
}

#[tauri::command]
pub fn remove_agent(state: State<'_, AgentManager>, id: u32) -> Result<(), String> {
    let mut map = state.agents.lock().unwrap();
    if let Some(agent) = map.get(&id) {
        if agent.info.status == Status::Running {
            unsafe { libc::killpg(agent.info.pid, libc::SIGKILL) };
        }
    }
    map.remove(&id);
    Ok(())
}

#[tauri::command]
pub fn list_agents(state: State<'_, AgentManager>) -> Vec<AgentInfo> {
    let map = state.agents.lock().unwrap();
    let mut v: Vec<_> = map.values().map(|a| a.info.clone()).collect();
    v.sort_by_key(|a| a.id);
    v
}

#[tauri::command]
pub fn agent_output(state: State<'_, AgentManager>, id: u32) -> Vec<OutputLine> {
    let map = state.agents.lock().unwrap();
    map.get(&id).map(|a| a.lines.iter().cloned().collect()).unwrap_or_default()
}

#[tauri::command]
pub fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

/// Resolve a `cd`-style path (absolute, `~`, or relative to `base`) to an
/// existing directory.
#[tauri::command]
pub fn resolve_dir(path: String, base: String) -> Result<String, String> {
    let path = path.trim();
    let target = if path.is_empty() || path == "~" || path.starts_with("~/") || path.starts_with('/') {
        expand_home(path)
    } else {
        expand_home(base.trim()).join(path)
    };
    let canon = target.canonicalize().map_err(|_| format!("no such directory: {path}"))?;
    if !canon.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    Ok(canon.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::render_terminal_line as r;

    #[test]
    fn plain_and_colors() {
        assert_eq!(r("hello"), "hello");
        // colors are kept (normalized), everything else is dropped
        assert_eq!(r("\x1b[1;32mok\x1b[0m done"), "\x1b[0;1;32mok\x1b[0m done");
        assert_eq!(r("\x1b[1m\x1b[31mA\x1b[mB"), "\x1b[0;1;31mA\x1b[0mB");
        assert_eq!(r("\x1b[?25l\x1b[32mgo\x1b[?25h"), "\x1b[0;32mgo\x1b[0m");
        assert_eq!(r("\x1b]8;;https://x.y\x07link\x1b]8;;\x07"), "link");
    }

    #[test]
    fn spinners_and_carriage_returns() {
        // Captured from `ollama run` with a piped stdout.
        let raw = "\x1b[?2026h\x1b[?25l\x1b[1G\u{2819} \x1b[K\x1b[?25h\x1b[?2026l\x1b[?2026h\x1b[?25l\x1b[1G\x1b[K\x1b[?25h\x1b[?2026l\x1b[?25l\x1b[2K\x1b[1G\x1b[?25hhi\x1b[?25l\x1b[?25h";
        assert_eq!(r(raw), "hi");
        assert_eq!(r("10%\r50%\r100%"), "100%");
        assert_eq!(r("abc\x08\x08X"), "aXc");
        // a redraw keeps the color of what was last written
        assert_eq!(r("\x1b[33m50%\r\x1b[32m100%"), "\x1b[0;33;32m100%\x1b[0m");
        assert_eq!(r("\x1b[1G\u{2819} \x1b[K"), "\u{2819}");
    }
}
