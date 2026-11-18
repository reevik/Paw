//! The native menus' texts (the app menu, the menu bar's) in the language
//! picked in Settings › General › Language. The web UI translates itself
//! (ui/i18n.js); these few are built here.

/// The language Settings has: "en", "de" or "tr".
pub fn lang() -> String {
    crate::paths::home()
        .and_then(|h| std::fs::read_to_string(h.join("settings.json")).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.pointer("/general/language").and_then(|l| l.as_str()).map(str::to_string))
        .filter(|l| l == "de" || l == "tr")
        .unwrap_or_else(|| "en".into())
}

/// A menu text in the user's language; `{n}` filled in by the caller.
pub fn t(en: &'static str) -> String {
    tr_in(&lang(), en).to_string()
}

fn tr_in(lang: &str, en: &'static str) -> &'static str {
    let (de, tr) = match en {
        "About Paw" => ("Über Paw", "Paw Hakkında"),
        "Settings…" => ("Einstellungen…", "Ayarlar…"),
        "Settings" => ("Einstellungen", "Ayarlar"),
        "Quit Paw" => ("Paw beenden", "Paw'dan Çık"),
        "Toggle Sidebar" => ("Seitenleiste ein-/ausblenden", "Kenar Çubuğunu Göster/Gizle"),
        "Toggle Right Panel" => ("Rechtes Panel ein-/ausblenden", "Sağ Paneli Göster/Gizle"),
        "Split Side by Side" => ("Nebeneinander teilen", "Yan Yana Böl"),
        "Split Stacked" => ("Untereinander teilen", "Alt Alta Böl"),
        "Open Paw" => ("Paw öffnen", "Paw'ı Aç"),
        "No tabs open" => ("Keine Tabs offen", "Açık sekme yok"),
        " — working" => (" — arbeitet", " — çalışıyor"),
        " — needs your approval" => (" — wartet auf deine Freigabe", " — onayınızı bekliyor"),
        " — waiting for a free agent" => (" — wartet auf einen freien Agenten", " — boş bir ajan bekliyor"),
        "{n} more…" => ("{n} weitere…", "{n} tane daha…"),
        _ => return en,
    };
    match lang {
        "de" => de,
        "tr" => tr,
        _ => en,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_texts_follow_the_language() {
        assert_eq!(tr_in("de", "Quit Paw"), "Paw beenden");
        assert_eq!(tr_in("tr", "Settings…"), "Ayarlar…");
        assert_eq!(tr_in("en", "Quit Paw"), "Quit Paw");
        assert_eq!(tr_in("de", "something new"), "something new", "unknown texts stay English");
    }
}
