//! Where Paw keeps its files: `~/.paw`.
//!
//! ```text
//! ~/.paw/
//!   settings.json  workspace.json  shell_history.json  mcp_servers.json
//!   skill_sources.json  external_skills.json  skill-catalogue/  external-skills-plugin/
//!   session/<id>/            one folder per tab
//!     session.json           the tab: agent, folder, transcript, task…
//!     conversations/<c>.json Paw Agent's conversations
//!     files/                 copies of attached and pasted files
//!     scripts/               helper scripts the agents write for this session
//!     commands.log           every command run in the tab, yours and the agent's
//!     launch.sh              the command the tab's agent was last started with
//! ```
//!
//! For development, `PAW_CONFIG_DIR=/some/folder` points every file Paw
//! writes at that folder instead, and the Keychain entries get their own
//! service name, so a second Paw never touches the data of the one you use.
//!
//! Earlier versions kept everything in `~/Library/Application Support`
//! (`net.reevik.paw`, before that Hive's `net.reevik.hive`); the first start
//! copies that folder to `~/.paw` (see [`move_to_paw_home`]).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;
use tauri::{AppHandle, Manager};

const HIVE_IDENTIFIER: &str = "net.reevik.hive";
const PAW_IDENTIFIER: &str = "net.reevik.paw";

/// `PAW_CONFIG_DIR`, when set.
pub fn override_dir() -> Option<PathBuf> {
    std::env::var_os("PAW_CONFIG_DIR").filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// `~/.paw`, or `PAW_CONFIG_DIR`.
pub fn home() -> Option<PathBuf> {
    override_dir().or_else(|| std::env::var_os("HOME").filter(|h| !h.is_empty()).map(|h| PathBuf::from(h).join(".paw")))
}

pub fn config_dir(_app: &AppHandle) -> Option<PathBuf> {
    home()
}

pub fn data_dir(_app: &AppHandle) -> Option<PathBuf> {
    match override_dir() {
        Some(d) => Some(d.join("data")),
        None => home(),
    }
}

/// A tab's id: letters, digits and dashes (a UUID), so it's safe as a folder name.
pub fn valid_session_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// `~/.paw/session/<id>` (not created).
pub fn session_dir_in(home: &Path, id: &str) -> Option<PathBuf> {
    valid_session_id(id).then(|| home.join("session").join(id))
}

pub fn session_dir(id: &str) -> Option<PathBuf> {
    session_dir_in(&home()?, id)
}

/// A tab's folder, with its `files/` and `scripts/`, created if needed.
pub fn ensure_session_dir(id: &str) -> Result<PathBuf, String> {
    let dir = session_dir(id).ok_or("Not a valid session id")?;
    for sub in ["files", "scripts", "conversations"] {
        std::fs::create_dir_all(dir.join(sub)).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    Ok(dir)
}

/// The file a path names, as of now: when it was written and its size.
fn stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.modified().ok()?, m.len()))
}

/// This process's binary as it was when it started (see `note_binary`).
static BINARY_AT_START: OnceLock<Option<(PathBuf, (SystemTime, u64))>> = OnceLock::new();

/// Note this process's binary, first thing in `main`.
pub fn note_binary() {
    BINARY_AT_START.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        stamp(&exe).map(|s| (exe, s))
    });
}

/// Was this process's binary replaced (an update, a rebuild) since it
/// started? Then macOS no longer trusts the running process with Paw's
/// Keychain items: it isn't the code on disk any more.
pub fn binary_replaced() -> bool {
    match BINARY_AT_START.get() {
        Some(Some((exe, at_start))) => stamp(exe).as_ref() != Some(at_start),
        _ => false,
    }
}

/// The Keychain service Paw stores API keys under.
/// For trying a first start (`PAW_HIDE_PROVIDERS=1`, with `PAW_CONFIG_DIR`):
/// what Paw would find outside its own settings is left out (Claude's and
/// Copilot CLI's sign-ins, API keys in the environment and other tools'
/// files, Ollama), so only what's connected in this Paw counts. Its own keys
/// and sign-ins go in a Keychain service of their own (`keychain_service`).
/// Never without `PAW_CONFIG_DIR`: it can't hide anything from the real Paw.
pub fn outside_hidden() -> bool {
    override_dir().is_some() && std::env::var_os("PAW_HIDE_PROVIDERS").is_some_and(|v| !v.is_empty() && v != "0")
}

pub fn keychain_service() -> &'static str {
    // A first-start try keeps its own (emptied by scripts/first-run.sh).
    if outside_hidden() {
        "net.reevik.paw.first-run"
    } else if override_dir().is_some() {
        "net.reevik.paw.dev"
    } else {
        "net.reevik.paw"
    }
}

/// The service keys were saved under before the rename.
pub fn legacy_keychain_service() -> &'static str {
    if outside_hidden() {
        "net.reevik.hive.first-run"
    } else if override_dir().is_some() {
        "net.reevik.hive.dev"
    } else {
        HIVE_IDENTIFIER
    }
}

/// First start with `~/.paw`: copy the folder earlier versions used
/// (`~/Library/Application Support/net.reevik.paw`, or Hive's
/// `net.reevik.hive`) to `~/.paw`. The old folder is left as it was, so an
/// older Paw or Hive that is still installed keeps working. Then bring the
/// folder to the current layout (Paw Agent's conversations into the session
/// folders). Copying does nothing once `~/.paw` exists, or with `PAW_CONFIG_DIR`.
pub fn move_to_paw_home(app: &AppHandle) {
    let Some(home) = home() else { return };
    if override_dir().is_none() {
        if let Some(support) = app.path().app_config_dir().ok().and_then(|d| d.parent().map(Path::to_path_buf)) {
            let old = [PAW_IDENTIFIER, HIVE_IDENTIFIER].iter().map(|id| support.join(id)).find(|d| d.is_dir());
            if let Some(old) = old {
                if let Err(e) = copy_app_folder(&old, &home) {
                    eprintln!("Paw: couldn't copy {} to {}: {e}", old.display(), home.display());
                }
            }
        }
    }
    if let Err(e) = move_conversations(&home) {
        eprintln!("Paw: couldn't move Paw Agent's conversations: {e}");
    }
    if let Err(e) = shorten_session_ids(&home) {
        eprintln!("Paw: couldn't shorten the session folders' names: {e}");
    }
}

/// Session folders were named by a UUID; now by 8 characters. A folder with
/// a long name becomes `session/<first 8>` (unless that's taken), and the
/// references to it follow: the tab's id in session.json and workspace.json,
/// and paths into the folder inside session.json.
fn shorten_session_ids(home: &Path) -> std::io::Result<()> {
    let root = home.join("session");
    if !root.is_dir() {
        return Ok(());
    }
    let mut renamed: Vec<(String, String)> = Vec::new();
    for e in std::fs::read_dir(&root)? {
        let e = e?;
        let Some(old) = e.file_name().to_str().map(str::to_string) else { continue };
        if old.len() <= 8 || !valid_session_id(&old) || !e.path().is_dir() {
            continue;
        }
        let short: String = old.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect::<String>().to_ascii_lowercase();
        let to = root.join(&short);
        if short.len() < 8 || to.exists() {
            continue;
        }
        std::fs::rename(e.path(), &to)?;
        let file = to.join("session.json");
        if let Ok(text) = std::fs::read_to_string(&file) {
            let text = text.replace(&format!("/session/{old}/"), &format!("/session/{short}/"));
            let text = match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(mut v) if v["id"] == old.as_str() => {
                    v["id"] = short.clone().into();
                    v.to_string()
                }
                _ => text,
            };
            std::fs::write(&file, text)?;
        }
        renamed.push((old, short));
    }
    let ws = home.join("workspace.json");
    if renamed.is_empty() || !ws.is_file() {
        return Ok(());
    }
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(&ws)?) else { return Ok(()) };
    if let Some(tabs) = v.get_mut("tabs").and_then(|t| t.as_array_mut()) {
        for t in tabs {
            if let Some((_, short)) = renamed.iter().find(|(old, _)| t["id"] == old.as_str()) {
                t["id"] = short.clone().into();
            }
        }
    }
    std::fs::write(&ws, v.to_string())
}

/// `paw-agent/<c>.json` (one folder for every conversation) becomes
/// `session/<c>/conversations/<c>.json`: a tab restored from before the
/// session folders takes its conversation's id as its own.
fn move_conversations(home: &Path) -> std::io::Result<()> {
    let old = home.join("paw-agent");
    if !old.is_dir() {
        return Ok(());
    }
    for e in std::fs::read_dir(&old)? {
        let p = e?.path();
        let Some(id) = p.file_stem().and_then(|s| s.to_str()).filter(|_| p.extension().is_some_and(|x| x == "json")) else { continue };
        let Some(dir) = session_dir_in(home, id) else { continue };
        let to = dir.join("conversations").join(format!("{id}.json"));
        if to.exists() {
            continue;
        }
        std::fs::create_dir_all(to.parent().unwrap())?;
        std::fs::rename(&p, &to)?;
    }
    // Gone once it's empty (anything else in it stays).
    let _ = std::fs::remove_dir(&old);
    Ok(())
}

/// Copy `old` to `new` when only `old` exists. Paths to `old` inside JSON
/// files (e.g. a cloned catalogue) are pointed at `new`. The copy is made
/// next to `new` and renamed into place, so a failed copy leaves nothing.
fn copy_app_folder(old: &Path, new: &Path) -> std::io::Result<bool> {
    if new.exists() || !old.is_dir() {
        return Ok(false);
    }
    let tmp = new.with_extension("partial");
    if tmp.exists() {
        std::fs::remove_dir_all(&tmp)?;
    }
    let (from, to) = (old.to_string_lossy().into_owned(), new.to_string_lossy().into_owned());
    if let Err(e) = copy_tree(old, &tmp, &from, &to) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, new)?;
    Ok(true)
}

fn copy_tree(src: &Path, dst: &Path, from: &str, to: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let (s, d) = (e.path(), dst.join(e.file_name()));
        let kind = e.file_type()?;
        if kind.is_symlink() {
            std::os::unix::fs::symlink(std::fs::read_link(&s)?, &d)?;
        } else if kind.is_dir() {
            copy_tree(&s, &d, from, to)?;
        } else if s.extension().is_some_and(|x| x == "json") {
            let bytes = std::fs::read(&s)?;
            match String::from_utf8(bytes) {
                Ok(text) => std::fs::write(&d, text.replace(from, to))?,
                Err(b) => std::fs::write(&d, b.into_bytes())?,
            }
            std::fs::set_permissions(&d, std::fs::metadata(&s)?.permissions())?;
        } else {
            std::fs::copy(&s, &d)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_rewritten_file_has_a_new_stamp() {
        let dir = std::env::temp_dir().join(format!("paw-stamp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("paw");
        std::fs::write(&f, "old build").unwrap();
        let before = super::stamp(&f);
        assert!(before.is_some());
        assert_eq!(super::stamp(&f), before);
        std::fs::write(&f, "the new build").unwrap();
        assert_ne!(super::stamp(&f), before);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(super::stamp(&f), None);
    }

    use super::*;

    #[test]
    fn conversations_move_into_session_folders() {
        let home = std::env::temp_dir().join(format!("paw-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let id = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
        std::fs::create_dir_all(home.join("paw-agent")).unwrap();
        std::fs::write(home.join("paw-agent").join(format!("{id}.json")), "{}").unwrap();
        std::fs::write(home.join("paw-agent/notes.txt"), "keep").unwrap();
        move_conversations(&home).unwrap();
        assert!(home.join("session").join(id).join("conversations").join(format!("{id}.json")).is_file());
        assert!(home.join("paw-agent/notes.txt").is_file(), "other files stay");
        std::fs::remove_file(home.join("paw-agent/notes.txt")).unwrap();
        move_conversations(&home).unwrap();
        assert!(!home.join("paw-agent").exists(), "the empty folder goes");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn long_session_folders_get_short_names() {
        let home = std::env::temp_dir().join(format!("paw-short-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let old = "f4fa73bf-fdcf-40fa-8c3f-6caade59cedd";
        let dir = home.join("session").join(old);
        std::fs::create_dir_all(dir.join("files")).unwrap();
        let tab = format!(
            r#"{{"id":"{old}","session":"{old}","lines":[{{"stream":"stdin","attachments":[{{"path":"/h/.paw/session/{old}/files/a.png"}}]}}]}}"#
        );
        std::fs::write(dir.join("session.json"), tab).unwrap();
        // Taken already: stays as it is.
        std::fs::create_dir_all(home.join("session/0f1e2d3c")).unwrap();
        std::fs::create_dir_all(home.join("session/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b")).unwrap();
        std::fs::write(home.join("workspace.json"), format!(r#"{{"tabs":[{{"id":"{old}"}},{{"agent":"paw"}}]}}"#)).unwrap();

        shorten_session_ids(&home).unwrap();
        let new = home.join("session/f4fa73bf");
        assert!(new.join("files").is_dir() && !dir.exists());
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(new.join("session.json")).unwrap()).unwrap();
        assert_eq!(v["id"], "f4fa73bf");
        assert_eq!(v["session"], old, "the agent's own conversation id stays");
        assert_eq!(v["lines"][0]["attachments"][0]["path"], "/h/.paw/session/f4fa73bf/files/a.png");
        let ws: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(home.join("workspace.json")).unwrap()).unwrap();
        assert_eq!(ws["tabs"][0]["id"], "f4fa73bf");
        assert!(home.join("session/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b").is_dir(), "a taken short name keeps the long one");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_ids_are_folder_safe() {
        let h = Path::new("/h");
        assert_eq!(session_dir_in(h, "0f1e2d3c-4b5a"), Some(PathBuf::from("/h/session/0f1e2d3c-4b5a")));
        for bad in ["../../etc", "a/b/c/d/e", "short", "with space here", ""] {
            assert_eq!(session_dir_in(h, bad), None, "{bad}");
        }
    }

    #[test]
    fn hive_folder_is_copied_once() {
        let base = std::env::temp_dir().join(format!("paw-carry-over-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (old, new) = (base.join("net.reevik.hive"), base.join("net.reevik.paw"));
        std::fs::create_dir_all(old.join("skill-catalogue/repo/.git")).unwrap();
        std::fs::write(old.join("skill-catalogue/repo/.git/HEAD"), "ref: main").unwrap();
        let src = format!(r#"{{"sources":[{{"dir":"{}/skill-catalogue/repo"}}]}}"#, old.display());
        std::fs::write(old.join("skill-sources.json"), &src).unwrap();
        std::fs::write(old.join("settings.json"), r#"{"general":{}}"#).unwrap();

        assert!(copy_app_folder(&old, &new).unwrap());
        let moved = std::fs::read_to_string(new.join("skill-sources.json")).unwrap();
        assert_eq!(moved, format!(r#"{{"sources":[{{"dir":"{}/skill-catalogue/repo"}}]}}"#, new.display()));
        assert!(new.join("skill-catalogue/repo/.git/HEAD").is_file());
        assert!(old.join("settings.json").is_file(), "Hive's folder stays");
        assert!(!new.with_extension("partial").exists());

        // Paw has its own folder now: never copied again.
        std::fs::write(new.join("settings.json"), r#"{"paw":1}"#).unwrap();
        assert!(!copy_app_folder(&old, &new).unwrap());
        assert_eq!(std::fs::read_to_string(new.join("settings.json")).unwrap(), r#"{"paw":1}"#);
        // No Hive folder: nothing to do.
        assert!(!copy_app_folder(&base.join("missing"), &base.join("other")).unwrap());
        let _ = std::fs::remove_dir_all(&base);
    }
}
