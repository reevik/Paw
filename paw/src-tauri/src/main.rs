#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod attachments;
mod history;
mod paw_agent;
mod mcp;
mod paths;
mod registry;
mod shell;
mod skills;

use agents::AgentManager;
use history::History;
use paw_agent::PawAgents;
use registry::Registry;
use shell::ShellManager;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::utils::config::WindowEffectsConfig;
use tauri::window::{Effect, EffectState};
use tauri::{AppHandle, Emitter, Manager, RunEvent, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};

const PREFS_LABEL: &str = "prefs";
const ABOUT_LABEL: &str = "about";

/// Open an http(s)/mailto link from the transcript in the default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")) {
        return Err("only http(s) and mailto links can be opened".into());
    }
    std::process::Command::new("/usr/bin/open").arg(&url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Let the user pick a Ghostty / iTerm theme file; returns (file name, contents).
#[tauri::command]
async fn pick_theme_file(app: AppHandle) -> Result<Option<(String, String)>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Import Theme")
            .add_filter("Theme files", &["itermcolors", "conf", "txt", "toml"])
            .add_filter("All files", &["*"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(file) = picked else { return Ok(None) };
    let path = file.into_path().map_err(|e| e.to_string())?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 1_000_000 {
        return Err("That file is too large to be a theme.".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Could not read the file: {e}"))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Some((name, text)))
}

#[tauri::command]
fn open_preferences(app: AppHandle, tab: Option<String>) -> Result<(), String> {
    show_preferences(&app, tab.as_deref()).map_err(|e| e.to_string())
}

fn show_preferences(app: &AppHandle, tab: Option<&str>) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(PREFS_LABEL) {
        if let Some(tab) = tab {
            let _ = w.eval(&format!("window.selectTab && window.selectTab({:?})", tab));
        }
        w.unminimize()?;
        return w.set_focus();
    }
    let url = match tab {
        Some(t) => format!("prefs.html#{t}"),
        None => "prefs.html".into(),
    };
    let mode = app.state::<Registry>().settings(app).appearance.mode;
    WebviewWindowBuilder::new(app, PREFS_LABEL, WebviewUrl::App(url.into()))
        .theme(registry::window_theme(&mode))
        .title("Settings")
        .inner_size(820.0, 580.0)
        .min_inner_size(680.0, 460.0)
        .transparent(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .minimizable(false)
        .effects(WindowEffectsConfig {
            effects: vec![Effect::Sidebar],
            state: Some(EffectState::FollowsWindowActiveState),
            radius: Some(12.0),
            color: None,
            ..Default::default()
        })
        .center()
        .build()?;
    Ok(())
}

/// What the About window shows.
#[derive(serde::Serialize)]
struct AboutInfo {
    name: String,
    version: String,
    identifier: String,
    tauri: &'static str,
}

#[tauri::command]
fn about_info(app: AppHandle) -> AboutInfo {
    let info = app.package_info();
    AboutInfo {
        name: info.name.clone(),
        version: info.version.to_string(),
        identifier: app.config().identifier.clone(),
        tauri: tauri::VERSION,
    }
}

/// Open the About window, on `view` ("license", "oss") when given.
#[tauri::command]
fn open_about(app: AppHandle, view: Option<String>) -> Result<(), String> {
    show_about(&app, view.as_deref()).map_err(|e| e.to_string())
}

fn show_about(app: &AppHandle, view: Option<&str>) -> tauri::Result<()> {
    let view = view.filter(|v| matches!(*v, "license" | "oss"));
    if let Some(w) = app.get_webview_window(ABOUT_LABEL) {
        if let Some(v) = view {
            let _ = w.eval(&format!("window.showView && window.showView({v:?})"));
        }
        w.unminimize()?;
        return w.set_focus();
    }
    let url = match view {
        Some(v) => format!("about.html#{v}"),
        None => "about.html".into(),
    };
    let mode = app.state::<Registry>().settings(app).appearance.mode;
    WebviewWindowBuilder::new(app, ABOUT_LABEL, WebviewUrl::App(url.into()))
        .theme(registry::window_theme(&mode))
        .title("About Paw")
        .inner_size(440.0, 560.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .transparent(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .effects(WindowEffectsConfig {
            effects: vec![Effect::Sidebar],
            state: Some(EffectState::FollowsWindowActiveState),
            radius: Some(12.0),
            color: None,
            ..Default::default()
        })
        .center()
        .build()?;
    Ok(())
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    // The first submenu on macOS is the application menu ("Paw").
    if let Some(app_menu) = menu.items()?.first().and_then(|i| i.as_submenu().cloned()) {
        // Paw's own About window instead of the standard panel.
        let about = MenuItem::with_id(app, "about", "About Paw", true, None::<&str>)?;
        app_menu.remove_at(0)?;
        app_menu.insert(&about, 0)?;
        let settings = MenuItem::with_id(app, "preferences", "Settings…", true, Some("CmdOrCtrl+,"))?;
        app_menu.insert(&PredefinedMenuItem::separator(app)?, 1)?;
        app_menu.insert(&settings, 2)?;
    }
    // View › Show/Hide Sidebar (⌃⌘S, the macOS convention).
    let toggle = MenuItem::with_id(app, "toggle-sidebar", "Toggle Sidebar", true, Some("Ctrl+Cmd+S"))?;
    let view = menu
        .items()?
        .into_iter()
        .filter_map(|i| i.as_submenu().cloned())
        .find(|s| s.text().map(|t| t == "View").unwrap_or(false));
    match view {
        Some(view) => {
            view.prepend(&PredefinedMenuItem::separator(app)?)?;
            view.prepend(&toggle)?;
        }
        None => menu.append(&Submenu::with_items(app, "View", true, &[&toggle])?)?,
    }
    Ok(menu)
}

#[cfg(test)]
mod tests {
    #[test]
    fn about_window_license_matches_the_repository() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let repo = std::fs::read_to_string(root.join("../../LICENSE")).unwrap();
        let shown = std::fs::read_to_string(root.join("../ui/LICENSE.txt")).unwrap();
        assert_eq!(repo, shown, "copy LICENSE to paw/ui/LICENSE.txt");
        assert!(repo.starts_with("MIT License"));
    }

    #[test]
    fn about_window_lists_this_build_s_crates() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let list: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("../ui/licenses.json")).unwrap()).unwrap();
        let lock = std::fs::read_to_string(root.join("Cargo.lock")).unwrap();
        let rust = list["rust"].as_array().unwrap();
        for name in ["tauri", "rig-core", "rmcp", "tokio"] {
            let c = rust.iter().find(|c| c["name"] == name).unwrap_or_else(|| panic!("{name} missing: run paw/scripts/licenses.py"));
            let entry = format!("name = \"{name}\"\nversion = \"{}\"", c["version"].as_str().unwrap());
            assert!(lock.contains(&entry), "{name} changed version: run paw/scripts/licenses.py");
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AgentManager::default())
        .manage(Registry::default())
        .manage(ShellManager::default())
        .manage(History::default())
        .manage(PawAgents::default())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id() == "about" {
                let _ = show_about(app, None);
            } else if event.id() == "preferences" {
                let _ = show_preferences(app, None);
            } else if event.id() == "toggle-sidebar" {
                let _ = app.emit_to("main", "ui:toggle-sidebar", ());
            }
        })
        .setup(|app| {
            // First start after the rename: bring Hive's settings along.
            paths::carry_over_from_hive(app.handle());
            // Detect installed agent CLIs in the background right away.
            registry::start_scan(app.handle().clone());
            // Apply the saved light/dark choice before the first paint settles.
            let mode = app.state::<Registry>().settings(app.handle()).appearance.mode;
            registry::apply_window_theme(app.handle(), &mode);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agents::spawn_agent,
            agents::send_input,
            agents::close_input,
            agents::stop_agent,
            agents::remove_agent,
            agents::list_agents,
            agents::agent_output,
            agents::home_dir,
            agents::resolve_dir,
            registry::get_settings,
            registry::save_settings,
            registry::get_detections,
            registry::is_scanning,
            registry::render_command,
            registry::reset_agent,
            registry::load_workspace,
            registry::save_workspace,
            shell::shell_open,
            shell::shell_run,
            shell::shell_write,
            shell::shell_interrupt,
            shell::shell_close,
            shell::shell_write_raw,
            shell::shell_resize,
            shell::shell_raw_exit,
            shell::shell_commands,
            shell::command_exists,
            history::history_list,
            history::history_add,
            history::history_clear,
            history::history_trim,
            history::complete_path,
            open_preferences,
            open_about,
            about_info,
            pick_theme_file,
            open_url,
            attachments::pick_attachments,
            attachments::save_pasted_image,
            attachments::describe_attachment,
            skills::skills_scan,
            skills::skills_pick_folder,
            skills::skills_add_source,
            skills::skills_remove_source,
            skills::skills_install,
            skills::skills_uninstall,
            skills::reveal_path,
            skills::skills_external_add,
            skills::skills_external_remove,
            skills::skills_external_setup,
            paw_agent::paw_agent_start,
            paw_agent::paw_agent_send,
            paw_agent::paw_agent_cancel,
            paw_agent::paw_agent_note,
            paw_agent::paw_agent_close,
            paw_agent::paw_agent_approve,
            paw_agent::paw_key_status,
            paw_agent::paw_key_sources,
            paw_agent::paw_key_set,
            paw_agent::paw_key_delete,
            mcp::mcp_list,
            mcp::mcp_add,
            mcp::mcp_remove,
            mcp::mcp_set_enabled,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Paw");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Never leave orphaned agent processes behind.
            handle.state::<AgentManager>().kill_all();
            handle.state::<ShellManager>().kill_all();
            handle.state::<PawAgents>().close_all();
        }
    });
}
