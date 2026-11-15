//! Plugins: small JavaScript programs that extend the terminal (slash
//! commands, status bar items, reacting to prompts and commands). The window
//! runs each in a sandboxed web worker (ui/plugins.js); this module finds,
//! installs and removes them.
//!
//! A catalog is a folder with `index.json` (the plugins, their authors and
//! versions) and a folder per plugin holding `plugin.json` and its files. The
//! official one is `plugins/` in Paw's repository, read from GitHub; Settings
//! can point at another URL or at a local folder (a checkout, while writing a
//! plugin). Installed plugins live in `~/.paw/plugins/<id>/`, with
//! `state.json` next to them saying which are on.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// Paw's own repository: its `plugins/` folder is the official catalog.
pub const OFFICIAL_SOURCE: &str = "https://raw.githubusercontent.com/reevik/Paw/main/plugins/";

/// What a plugin may do; Settings shows these before installing.
pub const PERMISSIONS: &[&str] = &["commands", "statusbar", "events", "prompt", "shell", "network", "tasks", "views"];

/// Largest plugin file Paw downloads.
const FILE_LIMIT: usize = 2 * 1024 * 1024;
/// Largest stored data per plugin.
const STORAGE_LIMIT: usize = 1024 * 1024;

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub license: String,
    pub homepage: String,
    /// The lowest Paw version it works with ("0.5.0").
    pub min_paw: String,
    pub permissions: Vec<String>,
    /// The catalog folder that holds it (catalog entries only).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub path: String,
    /// Its script, run in the worker (plugin.json only).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub main: String,
    /// Every file to download, `main` included (plugin.json only).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(default)]
pub struct Catalog {
    pub version: u32,
    pub plugins: Vec<Manifest>,
}

#[derive(Serialize, Debug)]
pub struct Installed {
    pub manifest: Manifest,
    pub enabled: bool,
    /// The script, for the window to run (enabled plugins only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

fn valid_id(id: &str) -> bool {
    (2..=48).contains(&id.len()) && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') && !id.starts_with('-')
}

/// A file name inside a plugin's folder: no folders, nothing hidden.
fn valid_file(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn check(m: &Manifest) -> Result<(), String> {
    if !valid_id(&m.id) {
        return Err(format!("“{}” isn't a valid plugin id (lowercase letters, digits and dashes)", m.id));
    }
    if m.name.trim().is_empty() || m.version.trim().is_empty() {
        return Err(format!("{}: a name and a version are required", m.id));
    }
    if let Some(p) = m.permissions.iter().find(|p| !PERMISSIONS.contains(&p.as_str())) {
        return Err(format!("{}: unknown permission “{p}”", m.id));
    }
    Ok(())
}

/// `a` is older than `b` ("0.4.0" < "0.10.0"). Settings compares the same way (prefs.js).
#[cfg(test)]
pub fn older(a: &str, b: &str) -> bool {
    let parse = |v: &str| v.trim_start_matches('v').split('.').map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (a, b) = (parse(a), parse(b));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x < y;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Reading a catalog (a URL or a folder)
// ---------------------------------------------------------------------------

fn is_url(source: &str) -> bool {
    source.starts_with("https://") || source.starts_with("http://")
}

fn join(source: &str, rel: &str) -> String {
    format!("{}/{}", source.trim_end_matches('/'), rel)
}

async fn read(source: &str, rel: &str) -> Result<Vec<u8>, String> {
    if is_url(source) {
        let url = join(source, rel);
        let resp = reqwest::get(&url).await.map_err(|e| format!("Couldn't reach {url}: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("{url}: {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        if bytes.len() > FILE_LIMIT {
            return Err(format!("{url} is bigger than {} MB", FILE_LIMIT / 1024 / 1024));
        }
        Ok(bytes.to_vec())
    } else {
        let path = crate::agents::expand_home(source).join(rel);
        std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))
    }
}

pub async fn catalog_from(source: &str) -> Result<Catalog, String> {
    let bytes = read(source, "index.json").await?;
    let catalog: Catalog = serde_json::from_slice(&bytes).map_err(|e| format!("The catalog's index.json isn't valid: {e}"))?;
    for m in &catalog.plugins {
        check(m)?;
    }
    Ok(catalog)
}

/// Download (or copy) a plugin from a catalog into `dir/<id>`, replacing an
/// older copy only once everything arrived.
pub async fn install_from(source: &str, id: &str, dir: &Path) -> Result<Manifest, String> {
    let catalog = catalog_from(source).await?;
    let entry = catalog.plugins.iter().find(|m| m.id == id).ok_or_else(|| format!("The catalog has no plugin “{id}”"))?;
    let folder = if entry.path.is_empty() { id.to_string() } else { entry.path.clone() };
    if folder.split('/').any(|p| p.is_empty() || p == ".." || p == ".") {
        return Err(format!("{id}: its path isn't valid"));
    }
    let manifest_bytes = read(source, &format!("{folder}/plugin.json")).await?;
    let mut m: Manifest = serde_json::from_slice(&manifest_bytes).map_err(|e| format!("{id}: plugin.json isn't valid: {e}"))?;
    check(&m)?;
    if m.id != id {
        return Err(format!("{id}: its plugin.json says it's “{}”", m.id));
    }
    if m.main.is_empty() {
        m.main = "main.js".into();
    }
    if !m.files.contains(&m.main) {
        m.files.push(m.main.clone());
    }
    if let Some(bad) = m.files.iter().find(|f| !valid_file(f)) {
        return Err(format!("{id}: “{bad}” isn't an allowed file name"));
    }
    let target = dir.join(id);
    let staging = dir.join(format!(".{id}.partial"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let result = async {
        std::fs::write(staging.join("plugin.json"), serde_json::to_vec_pretty(&m).unwrap()).map_err(|e| e.to_string())?;
        for f in &m.files {
            let bytes = read(source, &format!("{folder}/{f}")).await?;
            std::fs::write(staging.join(f), bytes).map_err(|e| e.to_string())?;
        }
        // Keep what the plugin stored.
        if target.join("data.json").is_file() {
            std::fs::copy(target.join("data.json"), staging.join("data.json")).map_err(|e| e.to_string())?;
        }
        Ok::<_, String>(())
    }
    .await;
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&staging, &target).map_err(|e| e.to_string())?;
    set_enabled_in(dir, id, true)?;
    Ok(m)
}

// ---------------------------------------------------------------------------
// Installed plugins
// ---------------------------------------------------------------------------

fn state(dir: &Path) -> BTreeMap<String, bool> {
    std::fs::read_to_string(dir.join("state.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn set_enabled_in(dir: &Path, id: &str, on: bool) -> Result<(), String> {
    let mut s = state(dir);
    s.insert(id.to_string(), on);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("state.json"), serde_json::to_vec_pretty(&s).unwrap()).map_err(|e| e.to_string())
}

pub fn installed_in(dir: &Path, with_code: bool) -> Vec<Installed> {
    let on = state(dir);
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for e in entries.flatten() {
        let Some(id) = e.file_name().to_str().map(str::to_string) else { continue };
        if !valid_id(&id) || !e.path().is_dir() {
            continue;
        }
        let Some(m) = std::fs::read_to_string(e.path().join("plugin.json")).ok().and_then(|t| serde_json::from_str::<Manifest>(&t).ok()) else { continue };
        if m.id != id || check(&m).is_err() {
            continue;
        }
        let enabled = on.get(&id).copied().unwrap_or(true);
        let code = (with_code && enabled).then(|| std::fs::read_to_string(e.path().join(if m.main.is_empty() { "main.js" } else { &m.main })).ok()).flatten();
        out.push(Installed { manifest: m, enabled, code });
    }
    out.sort_by(|a, b| a.manifest.name.to_lowercase().cmp(&b.manifest.name.to_lowercase()));
    out
}

pub fn remove_in(dir: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("Not a plugin id".into());
    }
    match std::fs::remove_dir_all(dir.join(id)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
        _ => {}
    }
    let mut s = state(dir);
    s.remove(id);
    std::fs::write(dir.join("state.json"), serde_json::to_vec_pretty(&s).unwrap()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn plugins_dir() -> Result<PathBuf, String> {
    crate::paths::home().map(|h| h.join("plugins")).ok_or_else(|| "No home folder".to_string())
}

fn source_or_official(source: Option<String>) -> String {
    source.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| OFFICIAL_SOURCE.to_string())
}

fn changed(app: &AppHandle) {
    let _ = app.emit("plugins:changed", ());
}

#[tauri::command]
pub async fn plugins_catalog(source: Option<String>) -> Result<Catalog, String> {
    catalog_from(&source_or_official(source)).await
}

#[tauri::command]
pub fn plugins_installed(with_code: Option<bool>) -> Result<Vec<Installed>, String> {
    Ok(installed_in(&plugins_dir()?, with_code.unwrap_or(false)))
}

#[tauri::command]
pub async fn plugin_install(app: AppHandle, source: Option<String>, id: String) -> Result<Manifest, String> {
    let m = install_from(&source_or_official(source), &id, &plugins_dir()?).await?;
    changed(&app);
    Ok(m)
}

#[tauri::command]
pub fn plugin_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("Not a plugin id".into());
    }
    set_enabled_in(&plugins_dir()?, &id, enabled)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn plugin_remove(app: AppHandle, id: String) -> Result<(), String> {
    remove_in(&plugins_dir()?, &id)?;
    changed(&app);
    Ok(())
}

/// What a plugin stored (`paw.storage`), as one JSON object.
#[tauri::command]
pub fn plugin_storage_get(id: String) -> Result<Value, String> {
    if !valid_id(&id) {
        return Err("Not a plugin id".into());
    }
    let p = plugins_dir()?.join(&id).join("data.json");
    Ok(std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Object(Default::default())))
}

#[tauri::command]
pub fn plugin_storage_set(id: String, data: Value) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("Not a plugin id".into());
    }
    let dir = plugins_dir()?.join(&id);
    if !dir.is_dir() {
        return Err("That plugin isn't installed".into());
    }
    let bytes = serde_json::to_vec(&data).map_err(|e| e.to_string())?;
    if bytes.len() > STORAGE_LIMIT {
        return Err(format!("A plugin can store up to {} KB", STORAGE_LIMIT / 1024));
    }
    std::fs::write(dir.join("data.json"), bytes).map_err(|e| e.to_string())
}

/// A line in Paw's log about a plugin (started, failed): the window's console
/// isn't visible in the app.
#[tauri::command]
pub fn plugin_log(id: String, message: String) {
    let id: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(48).collect();
    eprintln!("Paw plugin {id}: {}", message.chars().take(500).collect::<String>());
}

/// Reveal a plugin's folder (or the plugins folder) in Finder.
#[tauri::command]
pub fn plugins_folder(id: Option<String>) -> Result<String, String> {
    let mut dir = plugins_dir()?;
    if let Some(id) = id.filter(|i| valid_id(i)) {
        dir = dir.join(id);
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("paw-plugins-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn catalog(dir: &Path) {
        write(
            &dir.join("index.json"),
            r#"{"version":1,"plugins":[{"id":"hello","name":"Hello","version":"1.2.0","author":"Paw","permissions":["commands"],"path":"hello"}]}"#,
        );
        write(&dir.join("hello/plugin.json"), r#"{"id":"hello","name":"Hello","version":"1.2.0","permissions":["commands"],"main":"main.js","files":["main.js","notes.md"]}"#);
        write(&dir.join("hello/main.js"), "paw.command('hello', {}, () => 'hi');");
        write(&dir.join("hello/notes.md"), "# notes");
    }

    #[tokio::test]
    async fn installs_from_a_folder_catalog() {
        let (src, home) = (tmp("src"), tmp("home"));
        catalog(&src);
        let c = catalog_from(src.to_str().unwrap()).await.unwrap();
        assert_eq!((c.plugins.len(), c.plugins[0].author.as_str()), (1, "Paw"));

        let m = install_from(src.to_str().unwrap(), "hello", &home).await.unwrap();
        assert_eq!(m.version, "1.2.0");
        assert!(home.join("hello/main.js").is_file() && home.join("hello/notes.md").is_file());
        // Its data survives an update.
        write(&home.join("hello/data.json"), r#"{"n":1}"#);
        install_from(src.to_str().unwrap(), "hello", &home).await.unwrap();
        assert_eq!(std::fs::read_to_string(home.join("hello/data.json")).unwrap(), r#"{"n":1}"#);

        let list = installed_in(&home, true);
        assert_eq!(list.len(), 1);
        assert!(list[0].enabled && list[0].code.as_deref().unwrap().contains("paw.command"));
        set_enabled_in(&home, "hello", false).unwrap();
        let list = installed_in(&home, true);
        assert!(!list[0].enabled && list[0].code.is_none(), "a plugin that's off doesn't run");
        remove_in(&home, "hello").unwrap();
        assert!(installed_in(&home, false).is_empty() && !home.join("hello").exists());
        assert!(install_from(src.to_str().unwrap(), "nope", &home).await.is_err());
    }

    #[tokio::test]
    async fn refuses_unsafe_plugins() {
        let (src, home) = (tmp("bad"), tmp("badhome"));
        write(&src.join("index.json"), r#"{"plugins":[{"id":"evil","name":"Evil","version":"1","path":"evil"},{"id":"perm","name":"P","version":"1","permissions":["root"]}]}"#);
        assert!(catalog_from(src.to_str().unwrap()).await.unwrap_err().contains("unknown permission"));
        write(&src.join("index.json"), r#"{"plugins":[{"id":"evil","name":"Evil","version":"1","path":"evil"}]}"#);
        write(&src.join("evil/plugin.json"), r#"{"id":"evil","name":"Evil","version":"1","files":["../../.zshrc"]}"#);
        assert!(install_from(src.to_str().unwrap(), "evil", &home).await.unwrap_err().contains("allowed file name"));
        write(&src.join("evil/plugin.json"), r#"{"id":"other","name":"Evil","version":"1"}"#);
        assert!(install_from(src.to_str().unwrap(), "evil", &home).await.is_err());
        write(&src.join("index.json"), r#"{"plugins":[{"id":"evil","name":"Evil","version":"1","path":"../outside"}]}"#);
        assert!(install_from(src.to_str().unwrap(), "evil", &home).await.unwrap_err().contains("path"));
        assert!(!home.join("evil").exists());
        assert!(!valid_id("../x") && !valid_id("A") && valid_id("pomodoro"));
    }

    /// The official catalog in the repository (plugins/) stays installable.
    #[tokio::test]
    async fn official_catalog_is_valid() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins");
        let src = src.to_str().unwrap();
        let c = catalog_from(src).await.expect("plugins/index.json");
        assert!(!c.plugins.is_empty());
        let home = tmp("official");
        for m in &c.plugins {
            assert!(!m.author.is_empty() && !m.description.is_empty(), "{}: author and description", m.id);
            let got = install_from(src, &m.id, &home).await.unwrap_or_else(|e| panic!("{}: {e}", m.id));
            assert_eq!(got.version, m.version, "{}: index.json and plugin.json agree", m.id);
            assert_eq!(got.permissions, m.permissions, "{}: same permissions in both", m.id);
        }
        assert_eq!(installed_in(&home, true).len(), c.plugins.len());
    }

    #[test]
    fn versions() {
        assert!(older("0.4.0", "0.10.0"));
        assert!(older("1.0", "1.0.1"));
        assert!(!older("1.2.0", "1.2.0") && !older("2.0.0", "1.9.9"));
    }
}
