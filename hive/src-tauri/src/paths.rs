//! Where Hive keeps its files.
//!
//! Normally the app's config and data folders
//! (`~/Library/Application Support/net.reevik.hive`). For development,
//! `HIVE_CONFIG_DIR=/some/folder` points every file Hive writes (settings,
//! workspace, shell history, skill lists, Hive Agent conversations) at that
//! folder instead, and the Keychain entries get their own service name, so a
//! second Hive never touches the data of the one you use.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// `HIVE_CONFIG_DIR`, when set.
pub fn override_dir() -> Option<PathBuf> {
    std::env::var_os("HIVE_CONFIG_DIR").filter(|v| !v.is_empty()).map(PathBuf::from)
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

/// The Keychain service Hive stores API keys under.
pub fn keychain_service() -> &'static str {
    if override_dir().is_some() {
        "net.reevik.hive.dev"
    } else {
        "net.reevik.hive"
    }
}
