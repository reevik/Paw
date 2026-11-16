//! Specs for spec-driven development: Markdown files the user imports into
//! named groups in the sidebar, then attaches to a session's prompt.
//!
//! Paw links the originals: `~/.paw/specs.json` keeps each group's name and
//! its files' paths, never their text, so an edit to a spec is what the
//! agent reads next time. A file that moved or was deleted is listed as
//! missing until it's back or removed.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// A group as it's stored, and as the sidebar sends it back after an edit.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Group {
    pub name: String,
    pub specs: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    groups: Vec<Group>,
}

/// One spec as the sidebar shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SpecView {
    pub path: String,
    /// Its first `# ` heading, else the file's name without `.md`.
    pub title: String,
    pub missing: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GroupView {
    pub name: String,
    pub specs: Vec<SpecView>,
}

fn store_path(home: &Path) -> PathBuf {
    home.join("specs.json")
}

fn load(home: &Path) -> Store {
    std::fs::read_to_string(store_path(home)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save(home: &Path, store: &Store) -> Result<(), String> {
    std::fs::create_dir_all(home).map_err(|e| format!("{}: {e}", home.display()))?;
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(store_path(home), json).map_err(|e| format!("Couldn't save the specs: {e}"))
}

fn paw_home() -> Result<PathBuf, String> {
    crate::paths::home().ok_or_else(|| "Paw's folder (~/.paw) isn't known: HOME isn't set.".to_string())
}

/// Names trimmed and unique (a group renamed to another's name joins it),
/// no unnamed group, each spec once per group.
fn tidy(groups: Vec<Group>) -> Vec<Group> {
    let mut out: Vec<Group> = Vec::new();
    for g in groups {
        let name = g.name.trim();
        if name.is_empty() {
            continue;
        }
        let i = match out.iter().position(|o| o.name == name) {
            Some(i) => i,
            None => {
                out.push(Group { name: name.to_string(), specs: vec![] });
                out.len() - 1
            }
        };
        for s in g.specs {
            if !s.is_empty() && !out[i].specs.contains(&s) {
                out[i].specs.push(s);
            }
        }
    }
    out
}

fn title(path: &Path) -> String {
    let heading = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| text.lines().take(40).find_map(|l| l.strip_prefix("# ").map(|t| t.trim().to_string())).filter(|t| !t.is_empty()));
    heading.unwrap_or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string()))
}

fn view(groups: &[Group]) -> Vec<GroupView> {
    groups
        .iter()
        .map(|g| GroupView {
            name: g.name.clone(),
            specs: g
                .specs
                .iter()
                .map(|s| {
                    let p = Path::new(s);
                    SpecView { path: s.clone(), title: title(p), missing: !p.is_file() }
                })
                .collect(),
        })
        .collect()
}

/// Add `files` to `group` (made when it's new), after its specs.
fn import(store: &mut Store, group: &str, files: Vec<String>) {
    let mut groups = std::mem::take(&mut store.groups);
    groups.push(Group { name: group.to_string(), specs: files });
    store.groups = tidy(groups);
}

#[tauri::command]
pub async fn specs_list() -> Result<Vec<GroupView>, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(view(&load(&paw_home()?).groups))).await.map_err(|e| e.to_string())?
}

/// Pick Markdown files and add them to `group`. Answers every group.
#[tauri::command]
pub async fn specs_import(app: AppHandle, group: String) -> Result<Vec<GroupView>, String> {
    use tauri_plugin_dialog::DialogExt;
    let group = group.trim().to_string();
    if group.is_empty() {
        return Err("Name the group first.".into());
    }
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title(format!("Import Specs into “{group}”")).add_filter("Markdown", &["md", "markdown"]).blocking_pick_files().map(|f| (group, f))
    })
    .await
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let home = paw_home()?;
        let mut store = load(&home);
        if let Some((group, files)) = picked {
            let files = files.into_iter().filter_map(|f| f.into_path().ok()).map(|p| p.display().to_string()).collect();
            import(&mut store, &group, files);
            save(&home, &store)?;
        }
        Ok(view(&store.groups))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The groups as the sidebar edited them (renamed, reordered, a spec moved
/// or removed, a group deleted). Answers them as stored.
#[tauri::command]
pub async fn specs_save(groups: Vec<Group>) -> Result<Vec<GroupView>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = paw_home()?;
        let store = Store { groups: tidy(groups) };
        save(&home, &store)?;
        Ok(view(&store.groups))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(name: &str, specs: &[&str]) -> Group {
        Group { name: name.into(), specs: specs.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn groups_are_named_unique_and_list_each_spec_once() {
        let out = tidy(vec![g(" Auth ", &["/a.md", "/a.md"]), g("", &["/x.md"]), g("Billing", &[]), g("Auth", &["/b.md", "/a.md"])]);
        assert_eq!(out, [g("Auth", &["/a.md", "/b.md"]), g("Billing", &[])]);
    }

    #[test]
    fn import_appends_to_a_group_or_makes_it() {
        let mut store = Store { groups: vec![g("Auth", &["/a.md"])] };
        import(&mut store, "Auth", vec!["/b.md".into(), "/a.md".into()]);
        import(&mut store, "New", vec!["/c.md".into()]);
        assert_eq!(store.groups, [g("Auth", &["/a.md", "/b.md"]), g("New", &["/c.md"])]);
    }

    #[test]
    fn specs_are_linked_titled_and_missing_when_gone() {
        let home = std::env::temp_dir().join(format!("paw-specs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let (titled, plain) = (home.join("login.md"), home.join("billing-flow.md"));
        std::fs::write(&titled, "intro\n# Login with SSO\nbody").unwrap();
        std::fs::write(&plain, "no heading").unwrap();
        let store = Store { groups: vec![g("Auth", &[&titled.display().to_string(), &plain.display().to_string(), "/gone/x.md"])] };
        save(&home, &store).unwrap();
        let shown = view(&load(&home).groups);
        let specs: Vec<(&str, bool)> = shown[0].specs.iter().map(|s| (s.title.as_str(), s.missing)).collect();
        assert_eq!(specs, [("Login with SSO", false), ("billing-flow", false), ("x", true)]);
        // Linked, not copied: an edit shows.
        std::fs::write(&titled, "# Login with passkeys").unwrap();
        assert_eq!(view(&load(&home).groups)[0].specs[0].title, "Login with passkeys");
        std::fs::remove_dir_all(home).ok();
    }
}
