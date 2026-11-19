//! Files attached to a prompt: picked with the "+" button, pasted images
//! and pasted text. Each tab keeps copies in its session folder
//! (`~/.paw/session/<id>/files`), and the agent gets the copy.
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

/// Files bigger than this are passed by their own path, not copied.
const COPY_LIMIT: u64 = 256 * 1024 * 1024;

/// The session's `files/` folder (created), or the temp folder without a session.
fn files_dir(session: Option<&str>) -> Result<PathBuf, String> {
    match session.filter(|s| crate::paths::valid_session_id(s)) {
        Some(id) => Ok(crate::paths::ensure_session_dir(id)?.join("files")),
        None => {
            let uid = unsafe { libc::getuid() };
            let dir = std::env::temp_dir().join(format!("paw-attachments-{uid}"));
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            Ok(dir)
        }
    }
}

/// `dir/name`, or `dir/name-2.ext`… when that's taken.
fn free_name(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    (2..).map(|n| dir.join(format!("{stem}-{n}{ext}"))).find(|p| !p.exists()).unwrap()
}

/// Copy an attached file into `dir` (unless it's already there or too big).
pub fn keep_copy(path: &Path, dir: &Path) -> Result<PathBuf, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    if path.starts_with(dir) || meta.len() > COPY_LIMIT {
        return Ok(path.to_path_buf());
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let to = free_name(dir, &name);
    std::fs::copy(path, &to).map_err(|e| format!("couldn't copy {}: {e}", path.display()))?;
    Ok(to)
}

/// "+" button: native multi-file picker.
#[tauri::command]
pub async fn pick_attachments(app: AppHandle, session: Option<String>) -> Result<Vec<Attachment>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title("Attach Files").blocking_pick_files()
    })
    .await
    .map_err(|e| e.to_string())?;
    let dir = files_dir(session.as_deref())?;
    let mut out = Vec::new();
    for f in picked.unwrap_or_default() {
        let path = f.into_path().map_err(|e| e.to_string())?;
        out.push(describe(&keep_copy(&path, &dir)?)?);
    }
    Ok(out)
}

/// Files dropped on the prompt: attached like picked ones (copied into the
/// session). Folders and what can't be read are skipped, with the reason.
#[derive(Serialize)]
pub struct Dropped {
    pub attached: Vec<Attachment>,
    pub skipped: Vec<Skipped>,
}

#[derive(Serialize)]
pub struct Skipped {
    pub path: String,
    pub why: String,
}

#[tauri::command]
pub fn attach_paths(paths: Vec<String>, session: Option<String>) -> Result<Dropped, String> {
    let dir = files_dir(session.as_deref())?;
    let mut out = Dropped { attached: vec![], skipped: vec![] };
    for p in paths.into_iter().take(50) {
        let path = PathBuf::from(&p);
        let why = if path.is_dir() {
            Some("folder".to_string())
        } else if !path.is_file() {
            Some("missing".to_string())
        } else {
            match keep_copy(&path, &dir).and_then(|c| describe(&c)) {
                Ok(a) => {
                    out.attached.push(a);
                    None
                }
                Err(e) => Some(e),
            }
        };
        if let Some(why) = why {
            out.skipped.push(Skipped { path: p, why });
        }
    }
    Ok(out)
}

fn stamp() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// Pasted text that became a badge: kept as a file in the session too.
#[tauri::command]
pub fn save_pasted_text(text: String, session: Option<String>) -> Result<Attachment, String> {
    let dir = files_dir(session.as_deref())?;
    let path = free_name(&dir, &format!("pasted-{}.txt", stamp()));
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    describe(&path)
}

/// A pasted image: saved to a temp file so it also has a path.
#[tauri::command]
pub fn save_pasted_image(data: String, mime: String, session: Option<String>) -> Result<Attachment, String> {
    let ext = match mime.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        other => return Err(format!("unsupported image type {other}")),
    };
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| e.to_string())?;
    let dir = files_dir(session.as_deref())?;
    let path: PathBuf = free_name(&dir, &format!("pasted-{}.{ext}", stamp()));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    describe(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_images_and_files() {
        let dir = std::env::temp_dir().join(format!("paw-att-test-{}", std::process::id()));
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
        let a = save_pasted_image("iVBORw==".into(), "image/png".into(), None).unwrap();
        assert!(a.path.ends_with(".png") && a.size == 4);
        std::fs::remove_file(a.path).unwrap();
        assert!(save_pasted_image("AAAA".into(), "image/tiff".into(), None).is_err());
    }

    #[test]
    fn attached_files_are_copied_once() {
        let base = std::env::temp_dir().join(format!("paw-keep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (src, files) = (base.join("src"), base.join("files"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&files).unwrap();
        std::fs::write(src.join("notes.md"), "# a").unwrap();
        let a = keep_copy(&src.join("notes.md"), &files).unwrap();
        assert_eq!(a, files.join("notes.md"));
        let b = keep_copy(&src.join("notes.md"), &files).unwrap();
        assert_eq!(b, files.join("notes-2.md"), "a second copy doesn't overwrite the first");
        assert_eq!(keep_copy(&a, &files).unwrap(), a, "a copy isn't copied again");
        assert!(keep_copy(&src, &files).is_err());
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "# a");
        let _ = std::fs::remove_dir_all(&base);
    }
}
