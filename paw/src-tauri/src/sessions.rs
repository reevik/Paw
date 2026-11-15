//! The session folders in `~/.paw/session`: one per tab, kept after the tab
//! is closed (a closed session can be reopened in a new tab). Settings ›
//! General sets how many closed sessions are kept; the oldest go first.

use crate::paths;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// One stored session, for `/sessions` and the status bar.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct StoredSession {
    pub id: String,
    /// What the tab was about: the task's title, the first prompt, or the agent.
    pub description: String,
    pub agent: String,
    pub cwd: String,
    /// When something last happened in it (ms since the epoch).
    pub last_active: u64,
    /// Everything in its folder, in bytes.
    pub size: u64,
    pub task: bool,
}

fn read_json(p: &Path) -> Option<Value> {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok())
}

/// Bytes in a folder and the newest modification time in it (ms).
fn walk(dir: &Path) -> (u64, u64) {
    let (mut size, mut newest) = (0u64, 0u64);
    let Ok(entries) = std::fs::read_dir(dir) else { return (0, 0) };
    for e in entries.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            let (s, n) = walk(&e.path());
            size += s;
            newest = newest.max(n);
        } else {
            size += meta.len();
            if let Some(ms) = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()) {
                newest = newest.max(ms.as_millis() as u64);
            }
        }
    }
    (size, newest)
}

fn describe(tab: &Value) -> String {
    let s = |v: &Value| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    if let Some(d) = s(&tab["summary"]) {
        return d;
    }
    if let Some(t) = s(&tab["task"]["title"]).or_else(|| s(&tab["task"]["goal"])) {
        return t;
    }
    let first_prompt = tab["lines"].as_array().and_then(|ls| ls.iter().find(|l| l["stream"] == "stdin" && l["local"] != true).and_then(|l| s(&l["text"])));
    first_prompt.map(|p| p.lines().next().unwrap_or("").to_string()).unwrap_or_default()
}

pub fn list_in(home: &Path) -> Vec<StoredSession> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(home.join("session")) else { return out };
    for e in entries.flatten() {
        let Some(id) = e.file_name().to_str().map(str::to_string) else { continue };
        let dir = e.path();
        if !paths::valid_session_id(&id) || !dir.is_dir() {
            continue;
        }
        let tab = read_json(&dir.join("session.json")).unwrap_or(Value::Null);
        let (size, newest) = walk(&dir);
        out.push(StoredSession {
            description: describe(&tab),
            agent: tab["agent"].as_str().unwrap_or("").to_string(),
            cwd: tab["cwd"].as_str().unwrap_or("").to_string(),
            last_active: tab["lastActive"].as_u64().filter(|&t| t > 0).unwrap_or(newest),
            size,
            task: tab["task"].is_object(),
            id,
        });
    }
    out.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    out
}

/// Delete the oldest closed sessions (not in `open`) beyond `max`; 0 keeps all.
/// Returns the ids deleted.
pub fn prune_in(home: &Path, max: usize, open: &HashSet<String>) -> Vec<String> {
    if max == 0 {
        return vec![];
    }
    let closed: Vec<StoredSession> = list_in(home).into_iter().filter(|s| !open.contains(&s.id)).collect();
    let mut gone = Vec::new();
    for s in closed.into_iter().skip(max) {
        if let Some(dir) = paths::session_dir_in(home, &s.id) {
            if std::fs::remove_dir_all(&dir).is_ok() {
                gone.push(s.id);
            }
        }
    }
    gone
}

fn home() -> Result<std::path::PathBuf, String> {
    paths::home().ok_or_else(|| "No home folder".to_string())
}

#[tauri::command]
pub fn list_sessions() -> Result<Vec<StoredSession>, String> {
    Ok(list_in(&home()?))
}

#[tauri::command]
pub fn prune_sessions(max: usize, open: Vec<String>) -> Result<Vec<String>, String> {
    Ok(prune_in(&home()?, max, &open.into_iter().collect()))
}

/// A tab's last state, written when it closes (workspace.json no longer lists it).
#[tauri::command]
pub fn save_session(id: String, tab: Value) -> Result<(), String> {
    let dir = paths::ensure_session_dir(&id)?;
    let tmp = dir.join("session.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&tab).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("session.json")).map_err(|e| e.to_string())
}

/// A closed session's state, to reopen it in a new tab.
#[tauri::command]
pub fn load_session(id: String) -> Result<Value, String> {
    let dir = paths::session_dir(&id).ok_or("Not a valid session id")?;
    read_json(&dir.join("session.json")).ok_or_else(|| "That session has nothing to reopen".to_string())
}

/// Remove a session folder (a tab closed before anything happened in it).
#[tauri::command]
pub fn delete_session(id: String) -> Result<(), String> {
    let dir = paths::session_dir(&id).ok_or("Not a valid session id")?;
    match std::fs::remove_dir_all(&dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn home(tag: &str) -> std::path::PathBuf {
        let h = std::env::temp_dir().join(format!("paw-sessions-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&h);
        h
    }

    fn make(home: &Path, id: &str, tab: Value) {
        let dir = home.join("session").join(id);
        std::fs::create_dir_all(dir.join("files")).unwrap();
        std::fs::write(dir.join("session.json"), tab.to_string()).unwrap();
    }

    #[test]
    fn lists_newest_first_with_descriptions_and_sizes() {
        let h = home("list");
        make(&h, "aaaaaaaa-1", json!({ "agent": "claude", "cwd": "~/a", "lastActive": 1000, "lines": [{ "stream": "stdin", "text": "fix the tests\nplease" }] }));
        make(&h, "bbbbbbbb-2", json!({ "agent": "paw", "lastActive": 3000, "task": { "title": "OAuth login" } }));
        make(&h, "cccccccc-3", json!({ "agent": "paw", "lastActive": 2000, "summary": "Explain the parser" }));
        std::fs::write(h.join("session/aaaaaaaa-1/files/notes.txt"), "x".repeat(100)).unwrap();
        std::fs::create_dir_all(h.join("session/not a session")).unwrap();
        let l = list_in(&h);
        assert_eq!(l.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["bbbbbbbb-2", "cccccccc-3", "aaaaaaaa-1"]);
        assert_eq!(l[0].description, "OAuth login");
        assert!(l[0].task);
        assert_eq!(l[1].description, "Explain the parser");
        assert_eq!(l[2].description, "fix the tests");
        assert!(l[2].size > 100, "the copied file counts");
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn prunes_the_oldest_closed_sessions() {
        let h = home("prune");
        for (i, id) in ["11111111", "22222222", "33333333", "44444444"].iter().enumerate() {
            make(&h, id, json!({ "lastActive": (i as u64 + 1) * 1000 }));
        }
        // 4444 is open: never counted or deleted. Keep 2 closed: 3333, 2222.
        let open: HashSet<String> = ["44444444".to_string()].into();
        assert_eq!(prune_in(&h, 2, &open), vec!["11111111".to_string()]);
        let left: Vec<String> = list_in(&h).into_iter().map(|s| s.id).collect();
        assert_eq!(left, ["44444444", "33333333", "22222222"]);
        assert!(prune_in(&h, 0, &HashSet::new()).is_empty(), "0 keeps everything");
        let _ = std::fs::remove_dir_all(&h);
    }
}
