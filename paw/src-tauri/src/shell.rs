//! A hidden login shell per session, running in a real PTY.
//!
//! The shell is the user's own (`$SHELL -l -i`, zsh or bash) so aliases,
//! functions and PATH match their terminal. Right after it starts we send a
//! setup line that silences prompts/echo and defines `__paw_run`:
//!
//! ```text
//! __paw_run '<command>'   →  eval the command in the shell itself (so `cd`,
//!                              `export`, aliases all work), then print
//!                              ESC ] 7770 ; done ; <exit code> ; <cwd> BEL
//! ```
//!
//! The reader thread splits PTY output into lines, cleans terminal escapes,
//! and turns the invisible OSC 7770 markers into `shell:ready` / `shell:done`
//! events. Everything printed before `ready` (rc-file noise) is dropped.

use crate::agents::render_terminal_line;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use base64::Engine;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const MARK: &[u8] = b"\x1b]7770;";

struct Shell {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    /// Set by the UI before running an interactive command (ssh, python…).
    want_raw: Arc<AtomicBool>,
    /// Set by the UI to drop back to line mode ("Back to prompt").
    leave_raw: Arc<AtomicBool>,
    child: Box<dyn Child + Send + Sync>,
    pid: Option<i32>,
    ready: bool,
    busy: bool,
    /// Commands submitted before the shell finished starting.
    queued: Vec<String>,
}

#[derive(Default)]
pub struct ShellManager {
    next_id: AtomicU32,
    shells: Arc<Mutex<HashMap<u32, Shell>>>,
}

impl ShellManager {
    pub fn kill_all(&self) {
        let mut map = self.shells.lock().unwrap();
        for (_, mut s) in map.drain() {
            kill_shell(&mut s);
        }
    }
}

fn kill_shell(s: &mut Shell) {
    if let Some(pid) = s.pid {
        unsafe { libc::killpg(pid, libc::SIGHUP) };
    }
    let _ = s.child.kill();
}

#[derive(Clone, Serialize)]
struct OutputEvent {
    id: u32,
    /// Complete lines, in order (one event per chunk read, not per line).
    lines: Vec<String>,
    /// An unfinished last line (e.g. "Continue? [y/N] "); replaced by the next event.
    partial: Option<String>,
}

/// After this many lines from one command, output is no longer forwarded to
/// the window (a runaway `yes` or `cat huge.log` must not freeze Paw).
const MAX_LINES_PER_COMMAND: usize = 10_000;

/// Collects lines for one event and enforces the per-command cap.
#[derive(Default)]
struct OutputBatch {
    lines: Vec<String>,
    partial: Option<String>,
    command_lines: usize,
    skipped: usize,
}

impl OutputBatch {
    fn line(&mut self, text: String) {
        self.command_lines += 1;
        self.partial = None;
        if self.command_lines <= MAX_LINES_PER_COMMAND {
            self.lines.push(text);
        } else {
            if self.skipped == 0 {
                self.lines.push(format!(
                    "… output truncated after {MAX_LINES_PER_COMMAND} lines — Ctrl-C (or ⌘.) stops the command"
                ));
            }
            self.skipped += 1;
        }
    }

    fn partial(&mut self, text: String) {
        if self.skipped == 0 {
            self.partial = Some(text);
        }
    }

    /// The command finished: report what was held back, start counting afresh.
    fn command_done(&mut self) {
        if self.skipped > 0 {
            self.lines.push(format!("… {} more lines were not shown", self.skipped));
        }
        self.command_lines = 0;
        self.skipped = 0;
    }

    fn flush(&mut self, app: &AppHandle, id: u32) {
        if self.lines.is_empty() && self.partial.is_none() {
            return;
        }
        let ev = OutputEvent { id, lines: std::mem::take(&mut self.lines), partial: self.partial.take() };
        let _ = app.emit("shell:output", ev);
    }
}

#[derive(Clone, Serialize)]
struct NamesEvent {
    id: u32,
    names: Vec<String>,
}

#[derive(Clone, Serialize)]
struct RawEvent {
    id: u32,
    on: bool,
    forced: bool,
}

#[derive(Clone, Serialize)]
struct DataEvent {
    id: u32,
    /// Raw PTY bytes, base64-encoded (may split UTF-8 sequences; xterm.js copes).
    data: String,
}

#[derive(Clone, Serialize)]
struct DoneEvent {
    id: u32,
    code: i32,
    cwd: String,
}

fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

const MARKER_FN: &str = r#"printf '\033]7770;done;%s;%s\007' "$__rc" "$PWD""#;
const READY: &str = r#"printf '\033]7770;ready;0;%s\007' "$PWD""#;
/// zsh: report alias / function / builtin names (only when they changed), so
/// the UI can recognise `gs`, `ll`, `mkcd`… as commands. `_*` completion
/// functions are skipped.
const ZSH_NAMES_FN: &str = r#"__paw_names() { local n="${(k)aliases} ${(k)functions:#_*} ${(k)builtins}"; [[ "$n" == "$__paw_last_names" ]] && return; __paw_last_names="$n"; printf '\033]7770;names;0;%s\007' "$n"; }"#;
const BASH_NAMES_FN: &str = r#"__paw_names() { local n; n="$(compgen -A alias -A function -A builtin | grep -v '^_' | tr '\n' ' ')"; [[ "$n" == "$__paw_last_names" ]] && return; __paw_last_names="$n"; printf '\033]7770;names;0;%s\007' "$n"; }"#;

/// bash has no startup-dir trick as clean as zsh's, so its setup is typed in.
/// `unset HISTFILE` comes first: bash only writes history on exit (or via
/// PROMPT_COMMAND, cleared here), so none of this reaches ~/.bash_history.
fn bash_setup_line() -> String {
    format!(
        "unset HISTFILE; stty -echo 2>/dev/null; set +o emacs +o vi 2>/dev/null; PS1=''; PS2=''; PROMPT_COMMAND=''; \
         {BASH_NAMES_FN}; __paw_run() {{ eval \"$1\"; local __rc=$?; __paw_names; {MARKER_FN}; }}; __paw_names; {READY}\n"
    )
}

/// zsh: a private ZDOTDIR whose startup files load the user's own
/// (.zshenv, .zprofile, .zshrc, .zlogin — from their ZDOTDIR if they set one)
/// and then configure the hidden shell. Nothing is typed in, and history saving
/// is switched off, so the user's ~/.zsh_history is never touched. Paw keeps
/// its own history.
fn prepare_zdotdir() -> std::io::Result<PathBuf> {
    let uid = unsafe { libc::getuid() };
    let dir = std::env::temp_dir().join(format!("paw-zdotdir-{uid}"));
    std::fs::create_dir_all(&dir)?;
    let chain = |name: &str| {
        format!(
            "ZDOTDIR=\"$PAW_USER_ZDOTDIR\"\n[[ -r \"$ZDOTDIR/{name}\" ]] && source \"$ZDOTDIR/{name}\"\nZDOTDIR=\"$PAW_ZDOTDIR\"\n"
        )
    };
    std::fs::write(
        dir.join(".zshenv"),
        "PAW_ZDOTDIR=\"$ZDOTDIR\"\nZDOTDIR=\"$HOME\"\n[[ -r \"$HOME/.zshenv\" ]] && source \"$HOME/.zshenv\"\n\
         PAW_USER_ZDOTDIR=\"${ZDOTDIR:-$HOME}\"\nZDOTDIR=\"$PAW_ZDOTDIR\"\n",
    )?;
    std::fs::write(dir.join(".zprofile"), chain(".zprofile"))?;
    std::fs::write(dir.join(".zshrc"), chain(".zshrc"))?;
    let setup = format!(
        "{chain}\
         # Paw's hidden shell: no history file, no prompt, no echo, no line editor.\n\
         unset HISTFILE; SAVEHIST=0\n\
         setopt no_inc_append_history no_share_history no_append_history 2>/dev/null\n\
         stty -echo 2>/dev/null; unsetopt zle prompt_cr prompt_sp 2>/dev/null\n\
         PROMPT=''; PS1=''; RPROMPT=''; RPS1=''; PS2=''; precmd_functions=(); preexec_functions=()\n\
         # `always` runs even when Ctrl-C aborts the command.\n\
         {ZSH_NAMES_FN}\n\
         __paw_run() {{ {{ eval \"$1\" }} always {{ local __rc=$?; (( TRY_BLOCK_INTERRUPT )) && __rc=130; \
         TRY_BLOCK_INTERRUPT=0; __paw_names; {MARKER_FN}; }} }}\n\
         if [[ \"$PAW_USER_ZDOTDIR\" == \"$HOME\" ]]; then unset ZDOTDIR; else ZDOTDIR=\"$PAW_USER_ZDOTDIR\"; fi\n\
         unset PAW_ZDOTDIR PAW_USER_ZDOTDIR\n\
         __paw_names\n\
         {READY}\n",
        chain = chain(".zlogin"),
    );
    std::fs::write(dir.join(".zlogin"), setup)?;
    Ok(dir)
}

fn pick_shell() -> String {
    let user = std::env::var("SHELL").unwrap_or_default();
    if user.ends_with("/zsh") || user.ends_with("/bash") {
        user
    } else {
        "/bin/zsh".into()
    }
}

fn write_cmd(s: &mut Shell, command: &str) -> std::io::Result<()> {
    s.busy = true;
    s.writer.write_all(format!("__paw_run {}\n", sq(command)).as_bytes())?;
    s.writer.flush()
}

/// Split PTY output into lines and markers — or, in raw mode, pass bytes
/// straight through for the embedded terminal emulator.
///
/// Raw mode starts when a program switches to the alternate screen (vim, top,
/// less…), when the UI asks for it (ssh, REPLs…), or when the line protocol is
/// clearly broken (we ended up inside a shell that has no `__paw_run`). It ends
/// when the program leaves the alternate screen (unless forced) or when the
/// end-of-command marker arrives.
struct Parser {
    pending: Vec<u8>,
    ready: bool,
    raw: bool,
    /// Raw mode requested explicitly; only the end marker (or the UI) ends it.
    raw_forced: bool,
}

enum Item {
    Line(String),
    Partial(String),
    Ready(String),
    Done(i32, String),
    /// Alias / function / builtin names known to the shell.
    Names(String),
    RawOn { forced: bool },
    RawOff,
    Data(Vec<u8>),
}

const ALT_ENTER: [&[u8]; 3] = [b"\x1b[?1049h", b"\x1b[?1047h", b"\x1b[?47h"];
const ALT_EXIT: [&[u8]; 3] = [b"\x1b[?1049l", b"\x1b[?1047l", b"\x1b[?47l"];

fn find_any(hay: &[u8], needles: &[&[u8]]) -> Option<(usize, usize)> {
    needles
        .iter()
        .filter_map(|n| find(hay, n).map(|p| (p, n.len())))
        .min_by_key(|(p, _)| *p)
}

/// Length of the longest suffix of `hay` that is a proper prefix of any needle
/// (bytes we must hold back because a sequence may continue in the next read).
fn held_back(hay: &[u8], needles: &[&[u8]]) -> usize {
    let mut keep = 0;
    for n in needles {
        for k in (1..n.len()).rev() {
            if k <= hay.len() && hay.ends_with(&n[..k]) {
                keep = keep.max(k);
                break;
            }
        }
    }
    keep
}

impl Parser {
    fn new() -> Self {
        Parser { pending: Vec::new(), ready: false, raw: false, raw_forced: false }
    }

    fn enter_raw(&mut self, forced: bool, out: &mut Vec<Item>) {
        if !self.raw {
            self.raw = true;
            self.raw_forced = forced;
            out.push(Item::RawOn { forced });
        }
    }

    fn leave_raw(&mut self, out: &mut Vec<Item>) {
        if self.raw {
            self.raw = false;
            self.raw_forced = false;
            out.push(Item::RawOff);
        }
    }

    fn feed(&mut self, data: &[u8]) -> Vec<Item> {
        self.pending.extend_from_slice(data);
        let mut out = Vec::new();
        loop {
            let progressed = if self.raw { self.step_raw(&mut out) } else { self.step_line(&mut out) };
            if !progressed {
                break;
            }
        }
        if !self.raw && self.ready && !self.pending.is_empty() && find(&self.pending, b"\x1b]").is_none()
            && held_back(&self.pending, &ALT_ENTER) == 0
        {
            let text = render_terminal_line(&String::from_utf8_lossy(&self.pending));
            if !text.is_empty() {
                out.push(Item::Partial(text));
            }
        }
        out
    }

    fn parse_marker(&mut self, m: usize, end: usize, out: &mut Vec<Item>) {
        let body = String::from_utf8_lossy(&self.pending[m + MARK.len()..m + end]).into_owned();
        self.pending.drain(..m + end + 1);
        let mut parts = body.splitn(3, ';');
        let kind = parts.next().unwrap_or("");
        let code = parts.next().and_then(|c| c.parse().ok()).unwrap_or(0);
        let cwd = parts.next().unwrap_or("").to_string();
        match kind {
            "ready" => {
                self.ready = true;
                out.push(Item::Ready(cwd));
            }
            "done" if self.ready => out.push(Item::Done(code, cwd)),
            "names" => out.push(Item::Names(cwd)),
            _ => {}
        }
    }

    fn push_line(&mut self, raw: &[u8], out: &mut Vec<Item>) {
        let raw = String::from_utf8_lossy(raw).into_owned();
        let text = render_terminal_line(&raw);
        // Skip lines that were only spinner redraws; keep real blank lines.
        if !text.is_empty() || raw.trim_matches('\r').is_empty() {
            // We are talking to a shell that doesn't know our wrapper (e.g. an
            // ssh session that outlived its command): hand over to the terminal.
            let foreign = text.contains("__paw_run") && text.contains("not found");
            out.push(Item::Line(text));
            if foreign {
                self.enter_raw(true, out);
            }
        }
    }

    fn step_line(&mut self, out: &mut Vec<Item>) -> bool {
        let nl = self.pending.iter().position(|&b| b == b'\n');
        let mk = find(&self.pending, MARK);
        let alt = if self.ready { find_any(&self.pending, &ALT_ENTER) } else { None };
        let first = |x: Option<usize>| x.unwrap_or(usize::MAX);

        if let Some((a, _)) = alt {
            if a < first(mk) && a < first(nl) {
                let before: Vec<u8> = self.pending.drain(..a).collect();
                let text = render_terminal_line(&String::from_utf8_lossy(&before));
                if !text.is_empty() {
                    out.push(Item::Line(text));
                }
                self.enter_raw(false, out);
                return true;
            }
        }
        if let Some(m) = mk {
            if m < first(nl) {
                let Some(end) = self.pending[m..].iter().position(|&b| b == 0x07) else { return false };
                let before: Vec<u8> = self.pending[..m].to_vec();
                if self.ready {
                    let text = render_terminal_line(&String::from_utf8_lossy(&before));
                    if !text.is_empty() {
                        out.push(Item::Line(text));
                    }
                }
                self.parse_marker(m, end, out);
                return true;
            }
        }
        if let Some(n) = nl {
            let raw: Vec<u8> = self.pending.drain(..=n).collect();
            if self.ready {
                self.push_line(&raw[..raw.len() - 1], out);
            }
            return true;
        }
        false
    }

    fn step_raw(&mut self, out: &mut Vec<Item>) -> bool {
        if self.pending.is_empty() {
            return false;
        }
        let mk = find(&self.pending, MARK);
        let exit = if self.raw_forced { None } else { find_any(&self.pending, &ALT_EXIT) };
        if let Some((e, len)) = exit {
            if mk.map_or(true, |m| e < m) {
                let data: Vec<u8> = self.pending.drain(..e + len).collect();
                out.push(Item::Data(data));
                self.leave_raw(out);
                return true;
            }
        }
        if let Some(m) = mk {
            let Some(end) = self.pending[m..].iter().position(|&b| b == 0x07) else {
                if m > 0 {
                    out.push(Item::Data(self.pending.drain(..m).collect()));
                }
                return false;
            };
            if m > 0 {
                out.push(Item::Data(self.pending[..m].to_vec()));
            }
            self.leave_raw(out);
            self.parse_marker(m, end, out);
            return true;
        }
        let mut needles: Vec<&[u8]> = vec![MARK];
        if !self.raw_forced {
            needles.extend_from_slice(&ALT_EXIT);
        }
        let keep = held_back(&self.pending, &needles);
        let n = self.pending.len() - keep;
        if n > 0 {
            out.push(Item::Data(self.pending.drain(..n).collect()));
        }
        false
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn expand_home(p: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    match p.strip_prefix("~/") {
        Some(rest) => PathBuf::from(home).join(rest),
        None if p.is_empty() || p == "~" => PathBuf::from(home),
        None => PathBuf::from(p),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn shell_open(app: AppHandle, state: State<'_, ShellManager>, cwd: String) -> Result<u32, String> {
    let shell = pick_shell();
    let pair = native_pty_system()
        .openpty(PtySize { rows: 50, cols: 160, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(&shell);
    cmd.args(["-l", "-i"]);
    cmd.cwd(expand_home(&cwd));
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("PAGER", "cat");
    cmd.env("GIT_PAGER", "cat");
    cmd.env("MANPAGER", "cat");
    cmd.env("PAW_SHELL", "1");
    let is_bash = shell.ends_with("bash");
    if !is_bash {
        let zdot = prepare_zdotdir().map_err(|e| format!("could not prepare shell startup files: {e}"))?;
        cmd.env("ZDOTDIR", zdot);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    if is_bash {
        writer.write_all(bash_setup_line().as_bytes()).map_err(|e| e.to_string())?;
        let _ = writer.flush();
    }

    let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let pid = child.process_id().map(|p| p as i32);
    let want_raw = Arc::new(AtomicBool::new(false));
    let leave_raw = Arc::new(AtomicBool::new(false));
    state.shells.lock().unwrap().insert(
        id,
        Shell {
            writer,
            master: pair.master,
            want_raw: want_raw.clone(),
            leave_raw: leave_raw.clone(),
            child,
            pid,
            ready: false,
            busy: false,
            queued: vec![],
        },
    );

    let shells = state.shells.clone();
    thread::spawn(move || {
        let mut parser = Parser::new();
        let mut batch = OutputBatch::default();
        let mut buf = [0u8; 16384];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let mut items = Vec::new();
            if leave_raw.swap(false, Ordering::SeqCst) {
                parser.leave_raw(&mut items);
            }
            if want_raw.swap(false, Ordering::SeqCst) {
                parser.enter_raw(true, &mut items);
            }
            items.extend(parser.feed(&buf[..n]));
            for item in items {
                // Lines and partials accumulate; anything else first sends them.
                match &item {
                    Item::Line(_) | Item::Partial(_) => {}
                    _ => batch.flush(&app, id),
                }
                match item {
                    Item::RawOn { forced } => {
                        let _ = app.emit("shell:raw", RawEvent { id, on: true, forced });
                    }
                    Item::Names(list) => {
                        let names: Vec<String> = list.split_whitespace().map(String::from).collect();
                        let _ = app.emit("shell:names", NamesEvent { id, names });
                    }
                    Item::RawOff => {
                        let _ = app.emit("shell:raw", RawEvent { id, on: false, forced: false });
                    }
                    Item::Data(bytes) => {
                        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                        let _ = app.emit("shell:data", DataEvent { id, data });
                    }
                    Item::Line(text) => batch.line(text),
                    Item::Partial(text) => batch.partial(text),
                    Item::Ready(cwd) => {
                        let queued = {
                            let mut map = shells.lock().unwrap();
                            map.get_mut(&id).map(|s| {
                                s.ready = true;
                                std::mem::take(&mut s.queued)
                            })
                        };
                        let _ = app.emit("shell:ready", DoneEvent { id, code: 0, cwd });
                        for c in queued.unwrap_or_default() {
                            if let Some(s) = shells.lock().unwrap().get_mut(&id) {
                                let _ = write_cmd(s, &c);
                            }
                        }
                    }
                    Item::Done(code, cwd) => {
                        batch.command_done();
                        batch.flush(&app, id);
                        if let Some(s) = shells.lock().unwrap().get_mut(&id) {
                            s.busy = false;
                        }
                        let _ = app.emit("shell:done", DoneEvent { id, code, cwd });
                    }
                }
            }
            // One event per chunk read, however many lines it held.
            batch.flush(&app, id);
        }
        batch.flush(&app, id);
        shells.lock().unwrap().remove(&id);
        let _ = app.emit("shell:exit", id);
    });
    Ok(id)
}

/// Run a command line in the session's shell.
#[tauri::command]
pub fn shell_run(state: State<'_, ShellManager>, id: u32, command: String, raw: Option<bool>) -> Result<(), String> {
    let mut map = state.shells.lock().unwrap();
    let s = map.get_mut(&id).ok_or("shell is not running")?;
    if raw.unwrap_or(false) {
        // Interactive program: its output goes to the embedded terminal.
        s.want_raw.store(true, Ordering::SeqCst);
    }
    if !s.ready {
        s.queued.push(command);
        s.busy = true;
        return Ok(());
    }
    if s.busy {
        return Err("a command is still running".into());
    }
    write_cmd(s, &command).map_err(|e| e.to_string())
}

/// Type a line into the running command (e.g. answering a y/N question).
#[tauri::command]
pub fn shell_write(state: State<'_, ShellManager>, id: u32, text: String) -> Result<(), String> {
    let mut map = state.shells.lock().unwrap();
    let s = map.get_mut(&id).ok_or("shell is not running")?;
    s.writer.write_all(format!("{text}\n").as_bytes()).and_then(|_| s.writer.flush()).map_err(|e| e.to_string())
}

/// Ctrl-C for the running command.
#[tauri::command]
pub fn shell_interrupt(state: State<'_, ShellManager>, id: u32) -> Result<(), String> {
    {
        let mut map = state.shells.lock().unwrap();
        let s = map.get_mut(&id).ok_or("shell is not running")?;
        s.writer.write_all(b"\x03").and_then(|_| s.writer.flush()).map_err(|e| e.to_string())?;
    }
    // Safety net: if the shell didn't report back (e.g. bash aborting the
    // wrapper function), emit the end-of-command marker ourselves.
    let shells = state.shells.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(600));
        if let Some(s) = shells.lock().unwrap().get_mut(&id) {
            if s.busy {
                let _ = s
                    .writer
                    .write_all(b"printf '\\033]7770;done;130;%s\\007' \"$PWD\"\n")
                    .and_then(|_| s.writer.flush());
            }
        }
    });
    Ok(())
}

/// Keystrokes from the embedded terminal, written as-is.
#[tauri::command]
pub fn shell_write_raw(state: State<'_, ShellManager>, id: u32, data: String) -> Result<(), String> {
    let mut map = state.shells.lock().unwrap();
    let s = map.get_mut(&id).ok_or("shell is not running")?;
    s.writer.write_all(data.as_bytes()).and_then(|_| s.writer.flush()).map_err(|e| e.to_string())
}

/// Match the PTY to the embedded terminal's size (programs get SIGWINCH).
#[tauri::command]
pub fn shell_resize(state: State<'_, ShellManager>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.shells.lock().unwrap();
    let s = map.get(&id).ok_or("shell is not running")?;
    s.master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

/// "Back to prompt": leave terminal mode and re-sync with our shell by asking
/// whatever shell is in the foreground to print the end marker.
#[tauri::command]
pub fn shell_raw_exit(state: State<'_, ShellManager>, id: u32) -> Result<(), String> {
    let mut map = state.shells.lock().unwrap();
    let s = map.get_mut(&id).ok_or("shell is not running")?;
    s.leave_raw.store(true, Ordering::SeqCst);
    let _ = s.master.resize(PtySize { rows: 50, cols: 160, pixel_width: 0, pixel_height: 0 });
    s.writer
        .write_all(b"\nprintf '\\033]7770;done;130;%s\\007' \"$PWD\"\n")
        .and_then(|_| s.writer.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn shell_close(state: State<'_, ShellManager>, id: u32) {
    if let Some(mut s) = state.shells.lock().unwrap().remove(&id) {
        kill_shell(&mut s);
    }
}

fn is_executable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let ok = std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false);
    // macOS file systems ignore case: "Yes" would open /usr/bin/yes. Only an
    // entry with exactly this name counts, so "Yes, start" stays a prompt.
    ok && match (p.parent(), p.file_name()) {
        (Some(dir), Some(name)) => std::fs::read_dir(dir)
            .map(|rd| rd.flatten().any(|e| e.file_name() == name))
            .unwrap_or(false),
        _ => false,
    }
}

/// Background check for a word the UI doesn't know: is it an executable on
/// PATH right now, or a path (`./run.sh`, `bin/tool`, `~/x`) to one?
#[tauri::command]
pub fn command_exists(word: String, cwd: String) -> bool {
    let word = word.trim();
    if word.is_empty() || word.len() > 255 {
        return false;
    }
    if word.contains('/') {
        let p = if word.starts_with('/') || word.starts_with('~') {
            expand_home(word)
        } else {
            expand_home(&cwd).join(word)
        };
        return is_executable(&p);
    }
    crate::registry::login_path().split(':').any(|dir| is_executable(&PathBuf::from(dir).join(word)))
}

/// Executable names on the login PATH plus common shell builtins — used by the
/// UI to tell commands from prompts.
#[tauri::command]
pub fn shell_commands() -> Vec<String> {
    let mut names: Vec<String> = BUILTINS.iter().map(|s| s.to_string()).collect();
    for dir in crate::registry::login_path().split(':') {
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            use std::os::unix::fs::PermissionsExt;
            // follow symlinks: Homebrew, nix, asdf… install commands as links
            let Ok(meta) = std::fs::metadata(e.path()) else { continue };
            if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                if let Some(n) = e.file_name().to_str() {
                    names.push(n.to_string());
                }
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

const BUILTINS: &[&str] = &[
    "cd", "pwd", "echo", "export", "unset", "source", ".", "alias", "unalias", "set", "type", "which",
    "history", "jobs", "fg", "bg", "kill", "exit", "pushd", "popd", "dirs", "printf", "read", "eval",
    "exec", "test", "[", "ulimit", "umask", "wait", "true", "false", "builtin", "command", "hash",
    "rehash", "setopt", "unsetopt", "print", "whence", "where", "time",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(items: Vec<Item>) -> Vec<String> {
        items
            .into_iter()
            .map(|i| match i {
                Item::Line(t) => format!("L:{t}"),
                Item::Partial(t) => format!("P:{t}"),
                Item::Ready(c) => format!("R:{c}"),
                Item::Done(code, c) => format!("D:{code}:{c}"),
                Item::RawOn { forced } => format!("RAW-ON{}", if forced { "!" } else { "" }),
                Item::RawOff => "RAW-OFF".into(),
                Item::Data(d) => format!("B:{}", String::from_utf8_lossy(&d)),
                Item::Names(n) => format!("N:{n}"),
            })
            .collect()
    }

    #[test]
    fn parses_protocol() {
        let mut p = Parser::new();
        // rc noise before ready is dropped
        assert_eq!(lines(p.feed(b"Last login: x\r\n\x1b]7770;ready;0;/Users/me\x07")), vec!["R:/Users/me"]);
        // output split across reads, colors stripped
        assert_eq!(lines(p.feed(b"hel")), vec!["P:hel"]);
        assert_eq!(lines(p.feed(b"lo\r\n\x1b[35m/tmp\x1b[0m\r\n")), vec!["L:hello", "L:\x1b[0;35m/tmp\x1b[0m"]);
        // output without trailing newline right before the marker
        assert_eq!(
            lines(p.feed(b"no newline\x1b]7770;done;0;/tmp\x07")),
            vec!["L:no newline", "D:0:/tmp"]
        );
        // marker split across reads
        assert!(lines(p.feed(b"\x1b]7770;done;1")).is_empty());
        assert_eq!(lines(p.feed(b"30;/tmp\x07")), vec!["D:130:/tmp"]);
    }

    #[test]
    fn alternate_screen_switches_to_raw() {
        let mut p = Parser::new();
        p.feed(b"\x1b]7770;ready;0;/\x07");
        // vim/top: everything from the alt-screen switch on is raw
        assert_eq!(lines(p.feed(b"before\r\n\x1b[?1049h\x1b[2Jhello")),
            vec!["L:before", "RAW-ON", "B:\x1b[?1049h\x1b[2Jhello"]);
        // exit sequence split across reads is held back, then ends raw mode
        assert_eq!(lines(p.feed(b"bye\x1b[?10")), vec!["B:bye"]);
        assert_eq!(lines(p.feed(b"49l\r\n\x1b]7770;done;0;/\x07")), vec!["B:\x1b[?1049l", "RAW-OFF", "L:", "D:0:/"]);
    }

    #[test]
    fn forced_raw_ends_at_marker_and_foreign_shell_is_detected() {
        let mut p = Parser::new();
        p.feed(b"\x1b]7770;ready;0;/\x07");
        let mut out = vec![];
        p.enter_raw(true, &mut out);
        // ssh: alt-screen exit inside the session doesn't end forced raw mode
        assert_eq!(lines(p.feed(b"remote$ \x1b[?1049l")), vec!["B:remote$ \x1b[?1049l"]);
        assert_eq!(lines(p.feed(b"logout\r\n\x1b]7770;done;0;/home\x07")), vec!["B:logout\r\n", "RAW-OFF", "D:0:/home"]);
        // a shell without our wrapper → terminal mode
        assert_eq!(lines(p.feed(b"bash: __paw_run: command not found\r\nroot@box:~# ")),
            vec!["L:bash: __paw_run: command not found", "RAW-ON!", "B:root@box:~# "]);
    }
}

#[cfg(test)]
mod pty_tests {
    use super::*;

    /// Real PTY + the user's shell: `cargo test pty_roundtrip -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn pty_roundtrip() {
        let shell = pick_shell();
        let pair = native_pty_system().openpty(PtySize { rows: 50, cols: 160, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new(&shell);
        cmd.args(["-l", "-i"]);
        cmd.cwd(expand_home("~"));
        for (k, v) in std::env::vars() { cmd.env(k, v); }
        cmd.env("TERM", "xterm-256color");
        if !shell.ends_with("bash") {
            cmd.env("ZDOTDIR", prepare_zdotdir().unwrap());
        }
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        if shell.ends_with("bash") {
            writer.write_all(bash_setup_line().as_bytes()).unwrap();
        }
        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let mut p = Parser::new();
            let mut buf = [0u8; 8192];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 { break; }
                for it in p.feed(&buf[..n]) { let _ = tx.send(it); }
            }
        });
        let wait = |want_done: bool| -> Vec<String> {
            let mut got = vec![];
            while let Ok(it) = rx.recv_timeout(Duration::from_secs(15)) {
                match it {
                    Item::Line(t) => got.push(t),
                    Item::Partial(_) => {}
                    Item::Ready(c) => { got.push(format!("<ready {c}>")); if !want_done { break; } }
                    Item::Done(code, c) => { got.push(format!("<done {code} {c}>")); break; }
                    Item::RawOn { .. } => got.push("<raw on>".into()),
                    Item::RawOff => got.push("<raw off>".into()),
                    Item::Data(d) => got.push(format!("<{} raw bytes>", d.len())),
                    Item::Names(n) => got.push(format!("<{} names>", n.split_whitespace().count())),
                }
            }
            got
        };
        println!("{:?}", wait(false));
        for c in ["echo hello && pwd", "cd /tmp", "ls -d /tmp", "false", "printf 'x\\ny'", "echo \"HISTFILE=[$HISTFILE] ZDOTDIR=[$ZDOTDIR]\"", "alias | wc -l", "alias pawtest=true", "pwd"] {
            writer.write_all(format!("__paw_run {}\n", sq(c)).as_bytes()).unwrap();
            println!("{c:22} => {:?}", wait(true));
        }
        writer.write_all(format!("__paw_run {}\n", sq("sleep 5")).as_bytes()).unwrap();
        thread::sleep(Duration::from_millis(500));
        writer.write_all(b"\x03").unwrap();
        println!("{:22} => {:?}", "sleep 5 + ^C", wait(true));
        let _ = child.kill();
    }
}

#[cfg(test)]
mod raw_pty_tests {
    use super::*;

    /// `cargo test raw_programs -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn raw_programs() {
        let shell = pick_shell();
        let pair = native_pty_system().openpty(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new(&shell);
        cmd.args(["-l", "-i"]);
        cmd.cwd(expand_home("~"));
        for (k, v) in std::env::vars() { cmd.env(k, v); }
        cmd.env("TERM", "xterm-256color");
        if !shell.ends_with("bash") { cmd.env("ZDOTDIR", prepare_zdotdir().unwrap()); }
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let want_raw = Arc::new(AtomicBool::new(false));
        let wr = want_raw.clone();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        thread::spawn(move || {
            let mut p = Parser::new();
            let mut buf = [0u8; 8192];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 { break; }
                let mut items = vec![];
                if wr.swap(false, Ordering::SeqCst) { p.enter_raw(true, &mut items); }
                items.extend(p.feed(&buf[..n]));
                for it in items {
                    let s = match it {
                        Item::Line(t) => format!("line {t:?}"),
                        Item::Partial(_) => continue,
                        Item::Ready(_) => "ready".into(),
                        Item::Done(c, _) => format!("done {c}"),
                        Item::RawOn { forced } => format!("RAW ON (forced={forced})"),
                        Item::RawOff => "RAW OFF".into(),
                        Item::Data(d) => format!("data {}B", d.len()),
                        Item::Names(_) => continue,
                    };
                    let _ = tx.send(s);
                }
            }
        });
        let collect = |until: &str| -> Vec<String> {
            let mut got: Vec<String> = vec![];
            while let Ok(s) = rx.recv_timeout(Duration::from_secs(10)) {
                let stop = s.starts_with(until);
                // squash consecutive data chunks
                if s.starts_with("data") && got.last().map_or(false, |l| l.starts_with("data")) { continue; }
                got.push(s);
                if stop { break; }
            }
            got
        };
        println!("{:?}", collect("ready"));
        // 1. vim: alternate screen in, alternate screen out
        writer.write_all(format!("__paw_run {}\n", sq("vim -u NONE -N -c 'sleep 300m' -c q")).as_bytes()).unwrap();
        println!("vim      => {:?}", collect("done"));
        // 2. python REPL: forced raw, typed input, exits at the end marker
        want_raw.store(true, Ordering::SeqCst);
        writer.write_all(format!("__paw_run {}\n", sq("python3 -q")).as_bytes()).unwrap();
        thread::sleep(Duration::from_millis(800));
        writer.write_all(b"print(6*7)\r").unwrap();
        thread::sleep(Duration::from_millis(300));
        writer.write_all(b"exit()\r").unwrap();
        println!("python3  => {:?}", collect("done"));
        // 3. nested shell without our wrapper → terminal mode
        writer.write_all(format!("__paw_run {}\n", sq("bash --norc -i")).as_bytes()).unwrap();
        thread::sleep(Duration::from_millis(500));
        writer.write_all(format!("__paw_run {}\n", sq("ls")).as_bytes()).unwrap();
        let got = collect("RAW ON");
        println!("nested   => {:?}", got);
        let _ = child.kill();
    }
}

#[cfg(test)]
mod command_list_tests {
    /// `cargo test commands_include_symlinked -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn commands_include_symlinked() {
        let list = super::shell_commands();
        for c in ["nvim", "git", "node", "htop", "cargo"] {
            println!("{c:6} {}", if list.iter().any(|x| x == c) { "found" } else { "missing" });
        }
        println!("{} commands total", list.len());
    }
}

#[cfg(test)]
mod flood_tests {
    use super::*;

    #[test]
    fn caps_lines_per_command_and_reports_skipped() {
        let mut b = OutputBatch::default();
        for i in 0..(MAX_LINES_PER_COMMAND + 5) {
            b.line(format!("line {i}"));
        }
        assert_eq!(b.lines.len(), MAX_LINES_PER_COMMAND + 1); // + the truncation notice
        assert!(b.lines.last().unwrap().starts_with("… output truncated"));
        b.partial("Continue? ".into());
        assert!(b.partial.is_none(), "no partials once truncated");
        b.lines.clear();
        b.command_done();
        assert_eq!(b.lines, vec!["… 5 more lines were not shown".to_string()]);
        b.lines.clear();
        b.line("next command".into());
        assert_eq!(b.lines, vec!["next command".to_string()]);
    }

    #[test]
    fn executable_lookup_is_case_exact() {
        // /bin/ls exists; /bin/LS resolves on case-insensitive volumes but must not count.
        assert!(is_executable(std::path::Path::new("/bin/ls")));
        assert!(!is_executable(std::path::Path::new("/bin/LS")));
        assert!(!command_exists("Yes".into(), "/".into()));
        assert!(command_exists("yes".into(), "/".into()));
    }
}
