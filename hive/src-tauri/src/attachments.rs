//! Files attached to a prompt: picked with the "+" button or pasted images.
//!
//! Images small enough to send inline come back base64-encoded (Claude gets
//! them as image content; the UI uses them for thumbnails). Everything else is
//! passed on by path.

use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// Claude accepts inline images up to 5 MB once base64-encoded (~3.75 MB raw).
const INLINE_IMAGE_LIMIT: u64 = 3_750_000;

#[derive(Serialize, Clone, Debug)]
pub struct Attachment {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// image/png, image/jpeg, image/gif or image/webp for images Claude can see.
    pub mime: Option<String>,
    /// Base64 contents for images up to the inline limit.
    pub data: Option<String>,
}

fn image_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

pub fn describe(path: &Path) -> Result<Attachment, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    let mime = image_mime(path);
    let data = match mime {
        Some(_) if meta.len() <= INLINE_IMAGE_LIMIT => {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            Some(base64::engine::general_purpose::STANDARD.encode(bytes))
        }
        _ => None,
    };
    Ok(Attachment {
        path: path.display().to_string(),
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        size: meta.len(),
        mime: mime.map(String::from),
        data,
    })
}

/// Re-read a file attached in an earlier run (thumbnails after a restart).
#[tauri::command]
pub fn describe_attachment(path: String) -> Result<Attachment, String> {
    describe(Path::new(&path))
}

/// "+" button: native multi-file picker.
#[tauri::command]
pub async fn pick_attachments(app: AppHandle) -> Result<Vec<Attachment>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title("Attach Files").blocking_pick_files()
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for f in picked.unwrap_or_default() {
        let path = f.into_path().map_err(|e| e.to_string())?;
        out.push(describe(&path)?);
    }
    Ok(out)
}

/// A pasted image: saved to a temp file so it also has a path.
#[tauri::command]
pub fn save_pasted_image(data: String, mime: String) -> Result<Attachment, String> {
    let ext = match mime.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        other => return Err(format!("unsupported image type {other}")),
    };
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| e.to_string())?;
    let uid = unsafe { libc::getuid() };
    let dir = std::env::temp_dir().join(format!("hive-attachments-{uid}"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path: PathBuf = dir.join(format!("pasted-{stamp}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    describe(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_images_and_files() {
        let dir = std::env::temp_dir().join(format!("hive-att-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("shot.PNG");
        std::fs::write(&png, [0x89, b'P', b'N', b'G']).unwrap();
        let txt = dir.join("notes.md");
        std::fs::write(&txt, "# hi").unwrap();
        let a = describe(&png).unwrap();
        assert_eq!(a.mime.as_deref(), Some("image/png"));
        assert_eq!(a.data.as_deref(), Some("iVBORw=="));
        let b = describe(&txt).unwrap();
        assert!(b.mime.is_none() && b.data.is_none());
        assert_eq!((b.name.as_str(), b.size), ("notes.md", 4));
        assert!(describe(&dir).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn saves_pasted_image() {
        let a = save_pasted_image("iVBORw==".into(), "image/png".into()).unwrap();
        assert!(a.path.ends_with(".png") && a.size == 4);
        std::fs::remove_file(a.path).unwrap();
        assert!(save_pasted_image("AAAA".into(), "image/tiff".into()).is_err());
    }
}
