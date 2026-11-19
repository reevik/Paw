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
        "Keyboard Shortcuts…" => ("Tastaturkurzbefehle…", "Klavye Kısayolları…"),
        "Check for Updates…" => ("Nach Updates suchen…", "Güncellemeleri Denetle…"),
        "File" => ("Ablage", "Dosya"),
        "Edit" => ("Bearbeiten", "Düzen"),
        "View" => ("Darstellung", "Görüntü"),
        "Window" => ("Fenster", "Pencere"),
        "Help" => ("Hilfe", "Yardım"),
        "Factory" => ("Fabrik", "Fabrika"),
        "New Tab" => ("Neuer Tab", "Yeni Sekme"),
        "New Tab with Another Model…" => ("Neuer Tab mit anderem Modell…", "Başka Modelle Yeni Sekme…"),
        "New Plan…" => ("Neuer Plan…", "Yeni Plan…"),
        "New Factory…" => ("Neue Fabrik…", "Yeni Fabrika…"),
        "Attach Files…" => ("Dateien anhängen…", "Dosya Ekle…"),
        "Open the Tab's Folder" => ("Ordner des Tabs öffnen", "Sekmenin Klasörünü Aç"),
        "Close Tab" => ("Tab schließen", "Sekmeyi Kapat"),
        "Bigger Text" => ("Größerer Text", "Daha Büyük Yazı"),
        "Smaller Text" => ("Kleinerer Text", "Daha Küçük Yazı"),
        "Actual Size" => ("Originalgröße", "Gerçek Boyut"),
        "Clear the Screen" => ("Bildschirm leeren", "Ekranı Temizle"),
        "Stop the Agent or Command" => ("Agent oder Befehl stoppen", "Ajanı ya da Komutu Durdur"),
        "Turn the Tab's Sandbox On or Off" => ("Sandbox des Tabs ein-/ausschalten", "Sekmenin Korumalı Alanını Aç/Kapat"),
        "Run a Task" => ("Aufgabe starten", "Görev Çalıştır"),
        "Stop Task" => ("Aufgabe stoppen", "Görevi Durdur"),
        "Lock or Unlock the Diagram" => ("Diagramm sperren/entsperren", "Diyagramı Kilitle/Kilidi Aç"),
        "Reset the Layout…" => ("Anordnung zurücksetzen…", "Yerleşimi Sıfırla…"),
        "Edit the File" => ("Datei bearbeiten", "Dosyayı Düzenle"),
        "Delete Factory…" => ("Fabrik löschen…", "Fabrikayı Sil…"),
        "Next Tab" => ("Nächster Tab", "Sonraki Sekme"),
        "Previous Tab" => ("Vorheriger Tab", "Önceki Sekme"),
        "Paw Help" => ("Paw-Hilfe", "Paw Yardımı"),
        "Factories Guide" => ("Anleitung: Fabriken", "Fabrikalar Rehberi"),
        "Sandbox Guide" => ("Anleitung: Sandbox", "Korumalı Alan Rehberi"),
        "Report an Issue…" => ("Problem melden…", "Sorun Bildir…"),
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
