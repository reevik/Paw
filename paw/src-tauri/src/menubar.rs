//! Paw in the menu bar. The 🐾 belongs to the daemon (daemon.rs), which runs
//! the agents: it lists the window's tabs (what's working, what waits for
//! approval), brings the window back, or starts it when it isn't running.
//! Closing the window hides it; quitting the window (⌘Q) leaves the agents
//! running here. Quit Paw in this menu stops everything, asking first while
//! agents are working.
//!
//! The window tells the daemon what its tabs are doing (`tray_update`);
//! picking a tab here asks the window to show it.

use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Runtime};

const MAIN: &str = "main";
const TRAY_ID: &str = "paw";
/// Tabs listed in the menu, at most.
const MAX_ITEMS: usize = 12;

#[derive(Deserialize, Clone, Debug, Default)]
pub struct TrayTab {
    /// The tab's id (its session folder).
    pub id: String,
    pub label: String,
    /// "working", "waiting" (queued), "needs" (approval), or "idle".
    pub state: String,
}

#[derive(Default)]
pub struct MenuBar {
    tabs: Mutex<Vec<TrayTab>>,
    /// Agents working now (for the title and the quit question).
    working: Mutex<usize>,
    /// Quitting was confirmed (or nothing was running): let it happen.
    quitting: AtomicBool,
}

fn icon() -> tauri::image::Image<'static> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png")).expect("icons/tray.png")
}

fn mark(state: &str) -> &'static str {
    match state {
        "working" => "●",
        "needs" => "⚠︎",
        "waiting" => "⏳",
        _ => "○",
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, tabs: &[TrayTab]) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "tray:open", "Open Paw", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    if tabs.is_empty() {
        menu.append(&MenuItem::with_id(app, "tray:none", "No tabs open", false, None::<&str>)?)?;
    }
    for t in tabs.iter().take(MAX_ITEMS) {
        let what = match t.state.as_str() {
            "working" => " — working",
            "needs" => " — needs your approval",
            "waiting" => " — waiting for a free agent",
            _ => "",
        };
        let label: String = t.label.chars().take(60).collect();
        menu.append(&MenuItem::with_id(app, format!("tray:tab:{}", t.id), format!("{} {label}{what}", mark(&t.state)), true, None::<&str>)?)?;
    }
    if tabs.len() > MAX_ITEMS {
        menu.append(&MenuItem::with_id(app, "tray:more", format!("{} more…", tabs.len() - MAX_ITEMS), true, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "tray:settings", "Settings…", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "tray:quit", "Quit Paw", true, None::<&str>)?)?;
    Ok(menu)
}

fn title(tabs: &[TrayTab], working: usize) -> Option<String> {
    let needs = tabs.iter().filter(|t| t.state == "needs").count();
    match (working, needs) {
        (0, 0) => None,
        (w, 0) => Some(format!("{w}")),
        (_, n) => Some(format!("{n}⚠︎")),
    }
}

/// The menu bar item, set up once at launch.
pub fn setup(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let menu = build_menu(app, &[])?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon())
        .icon_as_template(true)
        .tooltip("Paw")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "tray:open" | "tray:more" => crate::daemon::open_window(app, None, false),
                "tray:settings" => crate::daemon::open_window(app, None, true),
                "tray:quit" => request_quit(app),
                _ => {
                    if let Some(tab) = id.strip_prefix("tray:tab:") {
                        crate::daemon::open_window(app, Some(tab.to_string()), false);
                    }
                }
            }
        })
        .build(app)
}

/// Bring the window (and the Dock icon) back.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Closing the window hides it: Paw keeps running in the menu bar.
pub fn hide_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.hide();
    }
    // No Dock icon while there's no window: Paw lives in the menu bar.
    #[cfg(target_os = "macos")]
    if !app.webview_windows().values().any(|w| w.is_visible().unwrap_or(false)) {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
}

pub fn quit_allowed(app: &AppHandle) -> bool {
    app.state::<MenuBar>().quitting.load(Ordering::SeqCst)
}

/// ⌘Q, Quit in the menu bar or the Dock: asks first when agents are working.
pub fn request_quit(app: &AppHandle) {
    let working = *app.state::<MenuBar>().working.lock().unwrap();
    let app = app.clone();
    if working == 0 {
        app.state::<MenuBar>().quitting.store(true, Ordering::SeqCst);
        crate::daemon::quit_all(&app);
        return;
    }
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let msg = format!(
        "{working} agent{} still working. Quitting Paw stops {}.\n\nQuitting just the window (⌘Q there) keeps {} running in the menu bar.",
        if working == 1 { " is" } else { "s are" },
        if working == 1 { "it" } else { "them" },
        if working == 1 { "it" } else { "them" },
    );
    app.dialog()
        .message(msg)
        .title("Quit Paw?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Cancel".into()))
        .show(move |quit| {
            if quit {
                app.state::<MenuBar>().quitting.store(true, Ordering::SeqCst);
                crate::daemon::quit_all(&app);
            }
        });
}

/// The window's tabs changed: refresh the menu and the count beside the icon.
#[tauri::command]
pub fn tray_update(app: AppHandle, tabs: Vec<TrayTab>, working: usize) -> Result<(), String> {
    let state = app.state::<MenuBar>();
    *state.working.lock().unwrap() = working;
    *state.tabs.lock().unwrap() = tabs.clone();
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return Ok(()) };
    let menu = build_menu(&app, &tabs).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    tray.set_title(title(&tabs, working)).map_err(|e| e.to_string())?;
    let tip = match working {
        0 => "Paw".to_string(),
        n => format!("Paw — {n} agent{} working", if n == 1 { "" } else { "s" }),
    };
    tray.set_tooltip(Some(tip)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(state: &str) -> TrayTab {
        TrayTab { id: "1a2b3c4d".into(), label: "Claude Code · proj".into(), state: state.into() }
    }

    #[test]
    fn title_shows_work_and_approvals() {
        assert_eq!(title(&[tab("idle")], 0), None);
        assert_eq!(title(&[tab("working"), tab("working")], 2), Some("2".into()));
        assert_eq!(title(&[tab("working"), tab("needs")], 2), Some("1⚠︎".into()), "approvals come first");
        assert_eq!(mark("needs"), "⚠︎");
    }

    #[test]
    fn the_icon_loads() {
        let i = icon();
        assert_eq!((i.width(), i.height()), (44, 44));
    }
}
