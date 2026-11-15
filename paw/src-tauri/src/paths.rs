//! Where Paw keeps its files.
//!
//! Normally the app's config and data folders
//! (`~/Library/Application Support/net.reevik.paw`). For development,
//! `PAW_CONFIG_DIR=/some/folder` points every file Paw writes (settings,
//! workspace, shell history, skill lists, Paw Agent conversations) at that
//! folder instead, and the Keychain entries get their own service name, so a
//! second Paw never touches the data of the one you use.
//!
//! Paw used to be called Hive (`net.reevik.hive`); on the first start after
//! the rename, Hive's folder is copied over (see [`carry_over_from_hive`]).

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const HIVE_IDENTIFIER: &str = "net.reevik.hive";

/// `PAW_CONFIG_DIR`, when set.
pub fn override_dir() -> Option<PathBuf> {
    std::env::var_os("PAW_CONFIG_DIR").filter(|v| !v.is_empty()).map(PathBuf::from)
}

pub fn config_dir(app: &AppHandle) -> Option<PathBuf> {
    match override_dir() {
        Some(d) => Some(d),
        None => app.path().app_config_dir().ok(),
    }
}

pub fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    match override_dir() {
        Some(d) => Some(d.join("data")),
        None => app.path().app_data_dir().ok(),
    }
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

/// First start as Paw: copy Hive's folder (settings, workspace, history,
/// skill lists, catalogues) to Paw's. Hive's folder is left as it was, so a
/// Hive that is still installed keeps working. Does nothing once Paw has a
/// folder of its own, or with `PAW_CONFIG_DIR`.
pub fn carry_over_from_hive(app: &AppHandle) {
    if override_dir().is_some() {
        return;
    }
    let Ok(new) = app.path().app_config_dir() else { return };
    let Some(old) = new.parent().map(|p| p.join(HIVE_IDENTIFIER)) else { return };
    if let Err(e) = copy_app_folder(&old, &new) {
        eprintln!("Paw: couldn't copy Hive's settings from {}: {e}", old.display());
    }
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
