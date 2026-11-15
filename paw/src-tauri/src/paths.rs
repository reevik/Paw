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

/// The Keychain service Paw stores API keys under.
pub fn keychain_service() -> &'static str {
    if override_dir().is_some() {
        "net.reevik.paw.dev"
    } else {
        "net.reevik.paw"
    }
}

/// The service keys were saved under before the rename.
pub fn legacy_keychain_service() -> &'static str {
    if override_dir().is_some() {
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
