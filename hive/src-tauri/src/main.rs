#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod attachments;
mod history;
mod hive_agent;
mod mcp;
mod paths;
mod registry;
mod shell;
mod skills;

use agents::AgentManager;
use history::History;
use hive_agent::HiveAgents;
use registry::Registry;
use shell::ShellManager;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::utils::config::WindowEffectsConfig;
use tauri::window::{Effect, EffectState};
use tauri::{AppHandle, Emitter, Manager, RunEvent, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};

const PREFS_LABEL: &str = "prefs";

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

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    // The first submenu on macOS is the application menu ("Hive").
    if let Some(app_menu) = menu.items()?.first().and_then(|i| i.as_submenu().cloned()) {
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

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AgentManager::default())
        .manage(Registry::default())
        .manage(ShellManager::default())
        .manage(History::default())
        .manage(HiveAgents::default())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id() == "preferences" {
                let _ = show_preferences(app, None);
            } else if event.id() == "toggle-sidebar" {
                let _ = app.emit_to("main", "ui:toggle-sidebar", ());
            }
        })
        .setup(|app| {
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
            hive_agent::hive_agent_start,
            hive_agent::hive_agent_send,
            hive_agent::hive_agent_cancel,
            hive_agent::hive_agent_note,
            hive_agent::hive_agent_close,
            hive_agent::hive_agent_approve,
            hive_agent::hive_key_status,
            hive_agent::hive_key_sources,
            hive_agent::hive_key_set,
            hive_agent::hive_key_delete,
            mcp::mcp_list,
            mcp::mcp_add,
            mcp::mcp_remove,
            mcp::mcp_set_enabled,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Hive");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Never leave orphaned agent processes behind.
            handle.state::<AgentManager>().kill_all();
            handle.state::<ShellManager>().kill_all();
            handle.state::<HiveAgents>().close_all();
        }
    });
}
