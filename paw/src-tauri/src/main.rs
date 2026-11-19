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
mod specs;
mod sessions;
mod stats;
mod plugins;
mod menubar;
mod daemon;
mod factories;
mod i18n;

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

/// Open a folder in Finder (the status bar's folder).
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    // A folder opens in Finder; a file (a factory's YAML) in its app.
    let dir = agents::expand_home(path.trim());
    if !dir.exists() {
        return Err(format!("{} isn't there any more", dir.display()));
    }
    std::process::Command::new("/usr/bin/open").arg(&dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// A tab's session folder (`~/.paw/session/<id>`), created if needed;
/// `reveal` also opens it in Finder.
#[tauri::command]
fn session_dir(id: String, reveal: Option<bool>) -> Result<String, String> {
    let dir = paths::ensure_session_dir(&id)?;
    if reveal.unwrap_or(false) {
        std::process::Command::new("/usr/bin/open").arg(&dir).spawn().map_err(|e| e.to_string())?;
    }
    Ok(dir.display().to_string())
}

/// The command Paw last started the tab's agent with, as `launch.sh`.
#[tauri::command]
fn session_launch(id: String, cwd: String, command: String) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let dir = paths::ensure_session_dir(&id)?;
    let q = |s: &str| format!("'{}'", s.replace('\'', r"'\''"));
    let script = format!(
        "#!/bin/sh\n# How Paw last started this tab's agent. Running it starts the agent the same way.\ncd {} || exit 1\nPAW_SESSION_DIR={} exec {command}\n",
        q(&cwd),
        q(&dir.display().to_string()),
    );
    let path = dir.join("launch.sh");
    std::fs::write(&path, script).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())
}

/// Add lines to a tab's `commands.log` (commands you and the agent ran).
#[tauri::command]
fn session_log(id: String, text: String) -> Result<(), String> {
    use std::io::Write;
    let dir = paths::ensure_session_dir(&id)?;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("commands.log")).map_err(|e| e.to_string())?;
    let mut text = text;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())
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

pub(crate) fn show_preferences(app: &AppHandle, tab: Option<&str>) -> tauri::Result<()> {
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
        .title(i18n::t("Settings"))
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
        .build()?
        .on_window_event({
            let app = app.clone();
            // Closed while recording a shortcut: the menu gets its keys back.
            move |e| {
                if matches!(e, tauri::WindowEvent::Destroyed) && MENU_KEYS_OFF.load(std::sync::atomic::Ordering::SeqCst) {
                    let _ = menu_shortcuts(app.clone(), true);
                }
            }
        });
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
        .title(i18n::t("About Paw"))
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

/// Off while Settings › Keys records a shortcut: the menu's keys would act
/// (⌘Q quits) before Settings sees them.
static MENU_KEYS_OFF: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Settings › Keys: the menu without its shortcuts while one is recorded, and back.
#[tauri::command]
fn menu_shortcuts(app: AppHandle, on: bool) -> Result<(), String> {
    MENU_KEYS_OFF.store(!on, std::sync::atomic::Ordering::SeqCst);
    let menu = if on {
        build_menu(&app)
    } else {
        // Nothing with a key (not even ⌘H, ⌘M, ⌘W or ⌘Q) while recording.
        let quit = MenuItem::with_id(&app, "quit", i18n::t("Quit Paw"), true, None::<&str>).map_err(|e| e.to_string())?;
        Submenu::with_items(&app, "Paw", true, &[&quit]).and_then(|paw| Menu::with_items(&app, &[&paw]))
    }
    .map_err(|e| e.to_string())?;
    app.set_menu(menu).map(|_| ()).map_err(|e| e.to_string())
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    // The first submenu on macOS is the application menu ("Paw").
    if let Some(app_menu) = menu.items()?.first().and_then(|i| i.as_submenu().cloned()) {
        // Paw's own About window instead of the standard panel.
        let about = MenuItem::with_id(app, "about", i18n::t("About Paw"), true, None::<&str>)?;
        app_menu.remove_at(0)?;
        app_menu.insert(&about, 0)?;
        let settings = keyed_item(app, "preferences", "settings", i18n::t("Settings…"), "Cmd+,")?;
        app_menu.insert(&PredefinedMenuItem::separator(app)?, 1)?;
        app_menu.insert(&settings, 2)?;
        // Quits the window only: the agents keep running in the daemon.
        let n = app_menu.items()?.len();
        if n > 0 {
            app_menu.remove_at(n - 1)?;
        }
        let quit_key = (!MENU_KEYS_OFF.load(std::sync::atomic::Ordering::SeqCst)).then_some("CmdOrCtrl+Q");
        app_menu.append(&MenuItem::with_id(app, "quit", i18n::t("Quit Paw"), true, quit_key)?)?;
    }
    let sep = || PredefinedMenuItem::separator(app);
    // An item with its shortcut (Settings › Keys can change it), or without one.
    let key = |id: &str, text: &'static str, default: &str| keyed_item(app, id, id, i18n::t(text), default);
    let item = |id: &str, text: &'static str| MenuItem::with_id(app, id, i18n::t(text), true, None::<&str>);
    let submenu = |title: &str| -> Option<Submenu<tauri::Wry>> {
        menu.items().ok()?.into_iter().filter_map(|i| i.as_submenu().cloned()).find(|s| s.text().map(|t| t == title).unwrap_or(false))
    };
    // Paw: the shortcuts, right under Settings.
    if let Some(app_menu) = menu.items()?.first().and_then(|i| i.as_submenu().cloned()) {
        app_menu.insert(&item("settings-keys", "Keyboard Shortcuts…")?, 3)?;
    }
    // File: tabs, plans, factories and attachments. (Its Close Window would
    // take ⌘W, which closes a tab in Paw; the window's red button closes it.)
    if let Some(file) = submenu("File") {
        while !file.items()?.is_empty() {
            file.remove_at(0)?;
        }
        file.append_items(&[
            &key("new-tab", "New Tab", "Cmd+T")?,
            &key("new-tab-with", "New Tab with Another Model…", "Shift+Cmd+T")?,
            &sep()?,
            &item("new-plan", "New Plan…")?,
            &item("new-factory", "New Factory…")?,
            &sep()?,
            &item("attach-files", "Attach Files…")?,
            &item("session-folder", "Open the Tab's Folder")?,
            &sep()?,
            &key("close-tab", "Close Tab", "Cmd+W")?,
        ])?;
        file.set_text(i18n::t("File"))?;
    }
    if let Some(edit) = submenu("Edit") {
        edit.set_text(i18n::t("Edit"))?;
    }
    // View: the splits (⌘D, ⌘⇧D, like iTerm2), the side panels (⌃⌘S, the
    // macOS convention for a sidebar; ⌃⌘M), the text size and clearing. In
    // the menu, the keys work wherever the focus is, a terminal included.
    let view_items = [
        &key("split-row", "Split Side by Side", "Cmd+D")? as &dyn tauri::menu::IsMenuItem<tauri::Wry>,
        &key("split-column", "Split Stacked", "Shift+Cmd+D")?,
        &sep()?,
        &key("toggle-sidebar", "Toggle Sidebar", "Ctrl+Cmd+S")?,
        &key("toggle-panel", "Toggle Right Panel", "Ctrl+Cmd+M")?,
        &sep()?,
        &key("font-bigger", "Bigger Text", "Cmd+=")?,
        &key("font-smaller", "Smaller Text", "Cmd+-")?,
        &key("font-reset", "Actual Size", "Cmd+0")?,
        &sep()?,
        &key("clear", "Clear the Screen", "Cmd+K")?,
        &key("interrupt", "Stop the Agent or Command", "Cmd+.")?,
        &item("sandbox-toggle", "Turn the Tab's Sandbox On or Off")?,
        &sep()?,
    ];
    let view = match submenu("View") {
        Some(view) => {
            for (i, it) in view_items.iter().enumerate() {
                view.insert(*it, i)?;
            }
            view
        }
        None => {
            let v = Submenu::with_items(app, "View", true, &view_items)?;
            menu.append(&v)?;
            v
        }
    };
    view.set_text(i18n::t("View"))?;
    // Factory: what the factory tab you're in does (its buttons, here too).
    let factory = Submenu::with_items(
        app,
        i18n::t("Factory"),
        true,
        &[
            &item("factory-run", "Run a Task")?,
            &item("factory-stop", "Stop Task")?,
            &sep()?,
            &item("factory-lock", "Lock or Unlock the Diagram")?,
            &item("factory-reset-layout", "Reset the Layout…")?,
            &sep()?,
            &item("factory-edit", "Edit the File")?,
            &item("factory-delete", "Delete Factory…")?,
        ],
    )?;
    let at = menu.items()?.iter().position(|i| i.as_submenu().is_some_and(|s| s.text().map(|t| t == i18n::t("View")).unwrap_or(false))).map_or(menu.items()?.len(), |i| i + 1);
    menu.insert(&factory, at)?;
    // Window: next and previous tab; not Close Window (⌘W is Close Tab).
    if let Some(window) = submenu("Window") {
        for (i, it) in window.items()?.iter().enumerate().rev() {
            if it.as_predefined_menuitem().is_some_and(|p| p.text().map(|t| t == "Close Window").unwrap_or(false)) {
                window.remove_at(i)?;
            }
        }
        window.append_items(&[&key("next-tab", "Next Tab", "Shift+Cmd+]")?, &key("prev-tab", "Previous Tab", "Shift+Cmd+[")?])?;
        window.set_text(i18n::t("Window"))?;
    }
    // Help: the guides.
    if let Some(help) = submenu("Help") {
        help.append_items(&[
            &item("help-readme", "Paw Help")?,
            &item("help-factories", "Factories Guide")?,
            &item("help-sandbox", "Sandbox Guide")?,
            &sep()?,
            &item("help-issue", "Report an Issue…")?,
        ])?;
        help.set_text(i18n::t("Help"))?;
    }
    apply_menu_state(&menu);
    Ok(menu)
}

/// Which of the menu's items apply now (the window says, as you switch tabs
/// and runs come and go): {id: enabled}. Kept for a menu built again later.
static MENU_ENABLED: std::sync::Mutex<Option<std::collections::HashMap<String, bool>>> = std::sync::Mutex::new(None);

#[tauri::command]
fn menu_state(app: AppHandle, enabled: std::collections::HashMap<String, bool>) {
    *MENU_ENABLED.lock().unwrap() = Some(enabled);
    if let Some(menu) = app.menu() {
        apply_menu_state(&menu);
    }
}

/// Enable or disable the menu's items as the window last said.
fn apply_menu_state(menu: &Menu<tauri::Wry>) {
    fn walk(items: Vec<tauri::menu::MenuItemKind<tauri::Wry>>, on: &std::collections::HashMap<String, bool>) {
        for it in items {
            match it {
                tauri::menu::MenuItemKind::MenuItem(i) => {
                    if let Some(&e) = on.get(i.id().as_ref()) {
                        let _ = i.set_enabled(e);
                    }
                }
                tauri::menu::MenuItemKind::Submenu(s) => walk(s.items().unwrap_or_default(), on),
                _ => {}
            }
        }
    }
    if let Some(on) = MENU_ENABLED.lock().unwrap().as_ref() {
        walk(menu.items().unwrap_or_default(), on);
    }
}

/// The menu's items the window acts on (ui:menu): Paw's own, by id.
const MENU_ACTIONS: &[&str] = &[
    "new-tab", "new-tab-with", "new-plan", "new-factory", "attach-files", "session-folder", "close-tab",
    "split-row", "split-column", "toggle-panel", "font-bigger", "font-smaller", "font-reset", "clear", "interrupt", "sandbox-toggle",
    "factory-run", "factory-stop", "factory-lock", "factory-reset-layout", "factory-edit", "factory-delete",
    "next-tab", "prev-tab", "help-readme", "help-factories", "help-sandbox", "help-issue",
];

/// The focused window, when it's another than the main one (Settings, About): closed.
fn close_other_window(app: &AppHandle) -> bool {
    match app.webview_windows().into_values().find(|w| w.label() != "main" && w.is_focused().unwrap_or(false)) {
        Some(w) => w.close().is_ok(),
        None => false,
    }
}

/// The shortcuts set in Settings › Keys (`keys` in settings.json).
fn menu_keys() -> serde_json::Value {
    paths::home()
        .and_then(|h| std::fs::read_to_string(h.join("settings.json")).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("keys").cloned())
        .unwrap_or(serde_json::Value::Null)
}

/// A menu item with its shortcut: the one set in Settings › Keys for `action`
/// (none if you removed it), else `default`. A key the menu can't take falls
/// back to the default.
fn keyed_item(app: &AppHandle, id: &str, action: &str, text: String, default: &str) -> tauri::Result<MenuItem<tauri::Wry>> {
    let mine = menu_keys().get(action).and_then(|k| k.as_array().cloned());
    let key = match &mine {
        _ if MENU_KEYS_OFF.load(std::sync::atomic::Ordering::SeqCst) => None,
        Some(list) => list.first().and_then(|k| k.as_str()).map(str::to_string),
        None => Some(default.to_string()),
    };
    MenuItem::with_id(app, id, &text, true, key.as_deref())
        .or_else(|_| MenuItem::with_id(app, id, &text, true, Some(default)))
        .or_else(|_| MenuItem::with_id(app, id, &text, true, None::<&str>))
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

/// The main window (created here rather than in tauri.conf.json, so the
/// daemon, which shares the binary, never opens one).
fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let mode = app.state::<Registry>().settings(app).appearance.mode;
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .theme(registry::window_theme(&mode))
        .title("Paw")
        .inner_size(1200.0, 780.0)
        .min_inner_size(760.0, 480.0)
        .transparent(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(18.0, 22.0))
        .effects(WindowEffectsConfig {
            effects: vec![Effect::Sidebar],
            state: Some(EffectState::FollowsWindowActiveState),
            radius: Some(12.0),
            color: None,
            ..Default::default()
        })
        .build()?;
    Ok(())
}

fn main() {
    // `paw --daemon` runs the agents and the menu bar; `paw` is the window.
    let daemon_mode = std::env::args().any(|a| a == "--daemon");
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AgentManager::default())
        .manage(Registry::default())
        .manage(ShellManager::default())
        .manage(History::default())
        .manage(PawAgents::default())
        .manage(menubar::MenuBar::default());
    let builder = if daemon_mode { builder } else { builder.menu(build_menu) };
    let app = builder
        .on_menu_event(|app, event| {
            if event.id() == "about" {
                let _ = show_about(app, None);
            } else if event.id() == "preferences" {
                let _ = show_preferences(app, None);
            } else if event.id() == "settings-keys" {
                let _ = show_preferences(app, Some("keys"));
            } else if event.id() == "toggle-sidebar" {
                let _ = app.emit_to("main", "ui:toggle-sidebar", ());
            } else if event.id() == "close-tab" && close_other_window(app) {
                // ⌘W in Settings or About closes that window, not a tab.
            } else if MENU_ACTIONS.contains(&event.id().as_ref()) {
                let _ = app.emit_to("main", "ui:menu", event.id().as_ref());
            } else if event.id() == "quit" {
                // The window quits; the agents keep running in the daemon.
                app.exit(0);
            }
        })
        .setup(move |app| {
            if daemon_mode {
                // No window, no Dock icon: the menu bar, the socket, the agents.
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                menubar::setup(app.handle())?;
                daemon::start_daemon(app.handle());
                // Factories run here, whether a window is open or not, and
                // their triggers (schedules, watches, webhooks, files) start them.
                let runner = factories::runner::Runner::new(app.handle());
                app.manage(factories::triggers::Triggers::new(app.handle(), runner.clone()));
                app.manage(runner);
                return Ok(());
            }
            // First start after the rename: bring Hive's settings along.
            paths::move_to_paw_home(app.handle());
            // Another language or other shortcuts in Settings: the app menu follows.
            {
                use tauri::Listener;
                let handle = app.handle().clone();
                // The language, and the shortcuts (Settings › Keys).
                let shown = std::sync::Mutex::new((i18n::lang(), menu_keys().to_string()));
                app.listen_any("settings:changed", move |_| {
                    let now = (i18n::lang(), menu_keys().to_string());
                    let mut was = shown.lock().unwrap();
                    if *was != now {
                        *was = now;
                        if let Ok(menu) = build_menu(&handle) {
                            let _ = handle.set_menu(menu);
                        }
                    }
                });
            }
            // Detect Paw Agent's providers (and, with "cli-agents", agent CLIs) in the background right away.
            registry::start_scan(app.handle().clone());
            create_main_window(app.handle())?;
            #[cfg(target_os = "macos")]
            menubar::set_dock_icon(app.handle());
            // Talk to the daemon (starting it when it isn't running).
            daemon::start_link(app.handle());
            // Closing the window only hides it.
            if let Some(w) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                w.on_window_event(move |e| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                        api.prevent_close();
                        menubar::hide_main(&handle);
                    }
                });
            }
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
            attachments::save_pasted_text,
            session_dir,
            session_log,
            open_folder,
            session_launch,
            plugins::plugins_catalog,
            plugins::plugins_installed,
            plugins::plugin_install,
            plugins::plugin_set_enabled,
            plugins::plugin_remove,
            plugins::plugin_storage_get,
            plugins::plugin_storage_set,
            plugins::plugins_folder,
            plugins::plugin_log,
            stats::stats_record,
            stats::stats_summary,
            sessions::list_sessions,
            sessions::prune_sessions,
            sessions::save_session,
            sessions::load_session,
            sessions::delete_session,
            attachments::describe_attachment,
            menu_shortcuts,
            menu_state,
            attachments::attach_paths,
            specs::specs_list,
            specs::specs_import,
            specs::specs_save,
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
            paw_agent::paw_agent_sandbox,
            paw_agent::paw_key_status,
            paw_agent::paw_key_sources,
            paw_agent::paw_key_set,
            paw_agent::paw_key_delete,
            paw_agent::paw_copilot_status,
            paw_agent::paw_copilot_sign_in,
            paw_agent::paw_copilot_cancel_sign_in,
            paw_agent::paw_copilot_sign_out,
            paw_agent::paw_claude_status,
            paw_agent::paw_claude_sign_in,
            paw_agent::paw_claude_cancel_sign_in,
            paw_agent::paw_claude_sign_out,
            paw_agent::paw_chatgpt_status,
            paw_agent::paw_chatgpt_sign_in,
            paw_agent::paw_chatgpt_cancel_sign_in,
            paw_agent::paw_chatgpt_sign_out,
            paw_agent::paw_openrouter_sign_in,
            paw_agent::paw_openrouter_cancel_sign_in,
            mcp::mcp_list,
            mcp::mcp_add,
            mcp::mcp_remove,
            mcp::mcp_set_enabled,
            menubar::tray_update,
            daemon::daemon_call,
            daemon::daemon_hello,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Paw");

    app.run(move |handle, event| match event {
        // The Dock icon clicked (or Paw opened again): the window comes back.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if daemon_mode {
                daemon::open_window(handle, None, false);
            } else {
                menubar::show_main(handle);
            }
        }
        // The daemon quit from the Dock or at logout: ask first when agents are working.
        RunEvent::ExitRequested { api, code, .. } if daemon_mode && code.is_none() && !menubar::quit_allowed(handle) => {
            api.prevent_exit();
            menubar::request_quit(handle);
        }
        RunEvent::Exit => {
            // Never leave orphaned agent processes behind.
            handle.state::<AgentManager>().kill_all();
            handle.state::<ShellManager>().kill_all();
            handle.state::<PawAgents>().close_all();
        }
        _ => {}
    });
}
