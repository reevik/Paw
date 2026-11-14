//! Shell command history (shared by all tabs, kept across launches) and
//! path completion for the prompt's autocomplete popup.

use crate::registry::Registry;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct History {
    /// Oldest first. `None` until loaded from disk.
    entries: Mutex<Option<Vec<String>>>,
}

fn history_path(app: &AppHandle) -> Option<PathBuf> {
    crate::paths::config_dir(&app).map(|d| d.join("shell_history.json"))
}

fn limit(app: &AppHandle) -> usize {
    app.state::<Registry>().settings(app).general.history_size
}

impl History {
    fn with<R>(&self, app: &AppHandle, f: impl FnOnce(&mut Vec<String>) -> R) -> R {
        let mut guard = self.entries.lock().unwrap();
        let list = guard.get_or_insert_with(|| {
            history_path(app)
                .and_then(|p| std::fs::read_to_string(p).ok())
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default()
        });
        f(list)
    }
}

fn save(app: &AppHandle, list: &[String]) -> Result<(), String> {
    let p = history_path(app).ok_or("No config directory")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, serde_json::to_string(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Append a command (moving an existing duplicate to the end) and trim to the
/// configured size.
pub fn push(list: &mut Vec<String>, command: &str, max: usize) {
    list.retain(|c| c != command);
    list.push(command.to_string());
    if list.len() > max {
        let extra = list.len() - max;
        list.drain(..extra);
    }
}

#[tauri::command]
pub fn history_list(app: AppHandle, h: State<'_, History>) -> Vec<String> {
    let max = limit(&app);
    h.with(&app, |list| {
        let start = list.len().saturating_sub(max);
        list[start..].to_vec()
    })
}

#[tauri::command]
pub fn history_add(app: AppHandle, h: State<'_, History>, command: String) -> Result<(), String> {
    let command = command.trim();
    if command.is_empty() || command.contains('\n') {
        return Ok(());
    }
    let max = limit(&app);
    let snapshot = h.with(&app, |list| {
        push(list, command, max);
        list.clone()
    });
    save(&app, &snapshot)
}

#[tauri::command]
pub fn history_clear(app: AppHandle, h: State<'_, History>) -> Result<(), String> {
    h.with(&app, |list| list.clear());
    save(&app, &[])
}

/// Re-apply the size limit right away (called when the setting changes).
#[tauri::command]
pub fn history_trim(app: AppHandle, h: State<'_, History>) -> Result<usize, String> {
    let max = limit(&app);
    let snapshot = h.with(&app, |list| {
        if list.len() > max {
            let extra = list.len() - max;
            list.drain(..extra);
        }
        list.clone()
    });
    save(&app, &snapshot)?;
    Ok(snapshot.len())
}

#[derive(Serialize)]
pub struct PathCompletion {
    /// Replacement for the word being completed (dirs end with `/`).
    pub value: String,
    pub is_dir: bool,
}

/// Complete a path-like word relative to `cwd`: "src/ma" → "src/main.rs".
#[tauri::command]
pub fn complete_path(cwd: String, word: String) -> Vec<PathCompletion> {
    let home = std::env::var("HOME").unwrap_or_default();
    let (dir_part, prefix) = match word.rfind('/') {
        Some(i) => (&word[..=i], &word[i + 1..]),
        None => ("", word.as_str()),
    };
    let base = if dir_part.starts_with('/') {
        PathBuf::from(dir_part)
    } else if let Some(rest) = dir_part.strip_prefix("~/") {
        PathBuf::from(&home).join(rest)
    } else if word == "~" {
        return vec![PathCompletion { value: "~/".into(), is_dir: true }];
    } else {
        PathBuf::from(&cwd).join(dir_part)
    };
    let Ok(rd) = std::fs::read_dir(&base) else { return vec![] };
    let mut out: Vec<PathCompletion> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.starts_with(prefix) || (name.starts_with('.') && !prefix.starts_with('.')) {
                return None;
            }
            let is_dir = e.path().is_dir(); // follows symlinks
            let value = format!("{dir_part}{name}{}", if is_dir { "/" } else { "" });
            Some(PathCompletion { value, is_dir })
        })
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.value.to_lowercase().cmp(&b.value.to_lowercase())));
    out.truncate(60);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_dedupes_and_trims() {
        let mut l = vec!["a".to_string(), "b".into(), "c".into()];
        push(&mut l, "a", 3);
        assert_eq!(l, ["b", "c", "a"]);
        push(&mut l, "d", 3);
        assert_eq!(l, ["c", "a", "d"]);
        push(&mut l, "e", 0);
        assert!(l.is_empty());
    }

    #[test]
    fn completes_paths() {
        let dir = std::env::temp_dir().join(format!("hive-complete-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "").unwrap();
        std::fs::write(dir.join("src/lib.rs"), "").unwrap();
        std::fs::write(dir.join(".hidden"), "").unwrap();
        let cwd = dir.display().to_string();
        let names = |w: &str| complete_path(cwd.clone(), w.into()).into_iter().map(|c| c.value).collect::<Vec<_>>();
        assert_eq!(names("s"), ["src/"]);
        assert_eq!(names("src/m"), ["src/main.rs"]);
        assert_eq!(names("src/"), ["src/lib.rs", "src/main.rs"]);
        assert_eq!(names(""), ["src/"]); // dotfiles hidden unless asked for
        assert_eq!(names(".h"), [".hidden"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
