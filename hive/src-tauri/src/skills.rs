//! Skills: what the agents load (system, user, project) and Hive's catalogue
//! of external skills the user can add to or remove from their setup.
//!
//! A skill is a folder with a `SKILL.md` whose front matter has a `name` and a
//! `description`. Agents read them from fixed folders; Hive only lists them.
//! Adding a catalogue skill copies its folder into the shared user folders
//! (`~/.claude/skills`, `~/.agents/skills`) with a `.hive-installed` marker, and
//! removing it deletes only copies carrying that marker.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const MARKER: &str = ".hive-installed";

#[derive(Serialize, Clone, Default)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// Which agents read it, e.g. "Claude Code", "Codex", "Shared".
    pub agents: Vec<String>,
    /// The skill folder(s).
    pub paths: Vec<String>,
    /// Put there by Hive (so Hive may remove it).
    pub hive: bool,
    /// Catalogue only: where it comes from.
    pub source: Option<String>,
    /// Catalogue only: Hive installed it.
    pub installed: bool,
    /// Catalogue only: a user skill of the same name exists that Hive didn't install.
    pub conflict: bool,
    /// Catalogue only: why it can't be added on its own.
    pub blocked: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SkillSource {
    pub id: String,
    pub label: String,
    /// "detected" (found on this Mac), "folder", or "git".
    pub kind: String,
    /// Folder path or Git URL as the user gave it.
    pub location: String,
    /// The local folder that is scanned.
    pub dir: String,
}

#[derive(Serialize, Clone)]
pub struct ExternalFolder {
    pub path: String,
    /// Skills found in it (0 when it's gone or empty).
    pub found: usize,
    pub missing: bool,
}

/// What a session needs to use the external skills.
#[derive(Serialize, Default)]
pub struct ExternalSetup {
    /// A Claude Code plugin folder whose `skills/` links to every external
    /// skill (for agents with a `skills_template`). None when there are none.
    pub plugin_dir: Option<String>,
    /// Changes whenever the set of external skills (or a SKILL.md) changes.
    pub signature: String,
    pub count: usize,
    /// For agents that can read files: names, descriptions and SKILL.md paths.
    pub index: String,
    /// For agents that can't: the skills' instructions themselves.
    pub inline: String,
}

#[derive(Serialize, Default)]
pub struct SkillsReport {
    pub system: Vec<Skill>,
    pub user: Vec<Skill>,
    pub project: Vec<Skill>,
    pub catalogue: Vec<Skill>,
    pub sources: Vec<SkillSource>,
    /// Skills in folders the user pointed Hive at; used where they are.
    pub external: Vec<Skill>,
    pub external_folders: Vec<ExternalFolder>,
    /// The folder project skills were found in (or the session folder).
    pub project_root: Option<String>,
}

fn home() -> PathBuf {
    #[cfg(test)]
    if let Some(h) = TEST_HOME.lock().unwrap().clone() {
        return h;
    }
    dirs_home().unwrap_or_else(|| PathBuf::from("/"))
}

/// Tests point the skill folders at a throwaway home (never the real one).
#[cfg(test)]
static TEST_HOME: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Folders that the user's own skills go into when Hive adds one.
fn install_targets() -> Vec<PathBuf> {
    let h = home();
    vec![h.join(".claude/skills"), h.join(".agents/skills")]
}

// ---------- reading SKILL.md ----------

/// `name` and `description` from YAML front matter (plain, quoted or block values).
pub fn parse_front_matter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let body: Vec<&str> = lines.take_while(|l| l.trim() != "---").collect();
    let value = |key: &str| -> Option<String> {
        let i = body.iter().position(|l| {
            l.starts_with(key) && l[key.len()..].trim_start().starts_with(':')
        })?;
        let raw = body[i][key.len()..].trim_start()[1..].trim();
        let block = raw.is_empty() || raw.starts_with('|') || raw.starts_with('>');
        let v = if block {
            body[i + 1..]
                .iter()
                .take_while(|l| l.trim().is_empty() || l.starts_with(' ') || l.starts_with('\t'))
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        } else if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
            raw[1..raw.len() - 1].replace("\\\"", "\"").replace("\\n", " ")
        } else if raw.len() >= 2 && raw.starts_with('\'') && raw.ends_with('\'') {
            raw[1..raw.len() - 1].replace("''", "'")
        } else {
            raw.to_string()
        };
        let v = v.trim().to_string();
        (!v.is_empty()).then_some(v)
    };
    (value("name"), value("description"))
}

/// Read one skill folder (it must contain SKILL.md).
fn read_skill(dir: &Path) -> Option<(Skill, String)> {
    let text = std::fs::read_to_string(dir.join("SKILL.md")).ok()?;
    let (name, description) = parse_front_matter(&text);
    let folder = dir.file_name()?.to_string_lossy().to_string();
    let skill = Skill {
        name: name.unwrap_or(folder),
        description: description.unwrap_or_default(),
        paths: vec![dir.to_string_lossy().to_string()],
        hive: dir.join(MARKER).exists(),
        ..Default::default()
    };
    Some((skill, text))
}

/// Skills directly inside `root` (one folder per skill).
fn skills_in(root: &Path, skip_hidden: bool) -> Vec<Skill> {
    let Ok(rd) = std::fs::read_dir(root) else { return vec![] };
    let mut out: Vec<Skill> = rd
        .flatten()
        .filter(|e| !(skip_hidden && e.file_name().to_string_lossy().starts_with('.')))
        .filter_map(|e| read_skill(&e.path()).map(|(s, _)| s))
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Every SKILL.md below `root` (catalogues are often nested, e.g. plugins/x/skills/y).
fn find_skills_deep(root: &Path, depth: usize, out: &mut Vec<(Skill, String)>) {
    if root.join("SKILL.md").is_file() {
        if let Some(s) = read_skill(root) {
            out.push(s);
        }
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name == ".git" || name == "node_modules" || name == "target" {
            continue;
        }
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            find_skills_deep(&e.path(), depth - 1, out);
        }
    }
}

/// Merge skills of the same name found in several folders of one scope.
fn merge(groups: Vec<(&str, Vec<Skill>)>) -> Vec<Skill> {
    let mut by_name: BTreeMap<String, Skill> = BTreeMap::new();
    for (agent, skills) in groups {
        for s in skills {
            let e = by_name.entry(s.name.to_lowercase()).or_insert_with(|| Skill {
                name: s.name.clone(),
                description: s.description.clone(),
                ..Default::default()
            });
            if e.description.is_empty() {
                e.description = s.description.clone();
            }
            if !e.agents.iter().any(|a| a == agent) {
                e.agents.push(agent.to_string());
            }
            e.paths.extend(s.paths);
            e.hive |= s.hive;
        }
    }
    by_name.into_values().collect()
}

// ---------- scopes ----------

fn system_skills() -> Vec<Skill> {
    let h = home();
    let mut groups = vec![
        ("Codex", skills_in(&h.join(".codex/skills/.system"), false)),
        ("Codex", skills_in(Path::new("/etc/codex/skills"), true)),
    ];
    // Skills of Claude Code plugins that are installed.
    if let Ok(text) = std::fs::read_to_string(h.join(".claude/plugins/installed_plugins.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            let mut paths = Vec::new();
            collect_install_paths(&v, &mut paths);
            for p in paths {
                groups.push(("Claude Code", skills_in(&Path::new(&p).join("skills"), true)));
            }
        }
    }
    merge(groups)
}

fn collect_install_paths(v: &serde_json::Value, out: &mut Vec<String>) {
    match v {
        serde_json::Value::Object(m) => {
            for (k, x) in m {
                if k == "installPath" {
                    if let Some(s) = x.as_str() {
                        out.push(s.to_string());
                    }
                } else {
                    collect_install_paths(x, out);
                }
            }
        }
        serde_json::Value::Array(a) => a.iter().for_each(|x| collect_install_paths(x, out)),
        _ => {}
    }
}

fn user_skills() -> Vec<Skill> {
    let h = home();
    merge(vec![
        ("Claude Code", skills_in(&h.join(".claude/skills"), true)),
        ("Codex", skills_in(&h.join(".codex/skills"), true)),
        ("Shared", skills_in(&h.join(".agents/skills"), true)),
        ("opencode", skills_in(&h.join(".config/opencode/skill"), true)),
        ("opencode", skills_in(&h.join(".config/opencode/skills"), true)),
    ])
}

/// Project skills: the session folder and its parents, up to the repository
/// root (a folder with `.git`) but never the home folder itself.
fn project_skills(cwd: &Path) -> (Vec<Skill>, Option<String>) {
    let h = home();
    let mut groups = Vec::new();
    let mut root: Option<PathBuf> = None;
    let mut dir = Some(cwd.to_path_buf());
    while let Some(d) = dir {
        if d == h || d.parent().is_none() {
            break;
        }
        for (sub, agent) in [
            (".claude/skills", "Claude Code"),
            (".codex/skills", "Codex"),
            (".agents/skills", "Shared"),
            (".opencode/skill", "opencode"),
            (".opencode/skills", "opencode"),
        ] {
            let found = skills_in(&d.join(sub), true);
            if !found.is_empty() {
                root.get_or_insert_with(|| d.clone());
                groups.push((agent, found));
            }
        }
        if d.join(".git").exists() {
            root.get_or_insert_with(|| d.clone());
            break;
        }
        dir = d.parent().map(Path::to_path_buf);
    }
    let label = root.unwrap_or_else(|| cwd.to_path_buf()).to_string_lossy().to_string();
    (merge(groups), Some(label))
}

// ---------- catalogue ----------

fn sources_file(app: &AppHandle) -> Option<PathBuf> {
    crate::paths::config_dir(&app).map(|d| d.join("skill_sources.json"))
}

fn clones_dir(app: &AppHandle) -> Option<PathBuf> {
    crate::paths::data_dir(&app).map(|d| d.join("skill-catalogue"))
}

fn load_sources(app: &AppHandle) -> Vec<SkillSource> {
    sources_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_sources(app: &AppHandle, sources: &[SkillSource]) -> Result<(), String> {
    let p = sources_file(app).ok_or("No config directory")?;
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(sources).map_err(|e| e.to_string())?;
    std::fs::write(p, text).map_err(|e| e.to_string())
}

/// Catalogues found on this Mac: Claude Code plugin marketplaces.
fn detected_sources() -> Vec<SkillSource> {
    let dir = home().join(".claude/plugins/marketplaces");
    let Ok(rd) = std::fs::read_dir(&dir) else { return vec![] };
    let mut out: Vec<SkillSource> = rd
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            SkillSource {
                id: format!("marketplace:{name}"),
                label: format!("{name} (Claude plugin marketplace)"),
                kind: "detected".into(),
                location: e.path().to_string_lossy().to_string(),
                dir: e.path().to_string_lossy().to_string(),
            }
        })
        .collect();
    out.sort_by(|a, b| a.label.cmp(&b.label));
    out
}

fn catalogue(sources: &[SkillSource], user: &[Skill]) -> Vec<Skill> {
    let mut out = Vec::new();
    for src in sources {
        let mut found = Vec::new();
        find_skills_deep(Path::new(&src.dir), 6, &mut found);
        for (mut s, text) in found {
            // Plugin catalogues: name the plugin (several plugins ship a skill called "access").
            let plugin = Path::new(&s.paths[0])
                .strip_prefix(&src.dir)
                .ok()
                .and_then(|rel| {
                    let parts: Vec<_> = rel.iter().map(|c| c.to_string_lossy().to_string()).collect();
                    let i = parts.iter().position(|c| c == "skills")?;
                    (i > 0).then(|| parts[i - 1].clone())
                });
            s.source = Some(match plugin {
                Some(p) if src.kind == "detected" => format!("{p} · {}", src.label.trim_end_matches(" (Claude plugin marketplace)")),
                _ => src.label.clone(),
            });
            if let Some(u) = user.iter().find(|u| u.name.eq_ignore_ascii_case(&s.name)) {
                s.installed = u.hive;
                s.conflict = !u.hive;
            }
            if text.contains("CLAUDE_PLUGIN_ROOT") {
                s.blocked = Some("Uses files from its Claude Code plugin — install the plugin in Claude Code instead.".into());
            }
            s.hive = false;
            out.push(s);
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

// ---------- commands ----------

/// Everything the skills panel shows. `cwd` is the active session's folder.
#[tauri::command]
pub async fn skills_scan(app: AppHandle, cwd: Option<String>) -> Result<SkillsReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let user = user_skills();
        let (project, project_root) = match cwd.as_deref().filter(|c| !c.is_empty()) {
            Some(c) => project_skills(Path::new(c)),
            None => (vec![], None),
        };
        let mut sources = detected_sources();
        sources.extend(load_sources(&app));
        let (external, external_folders) = external_skills(&app);
        SkillsReport {
            external,
            external_folders,
            system: system_skills(),
            catalogue: catalogue(&sources, &user),
            user,
            project,
            sources,
            project_root,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Native folder picker for "Add folder…".
#[tauri::command]
pub async fn skills_pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title("Add Skills Folder").blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string()))
}

fn is_git_url(s: &str) -> bool {
    s.starts_with("https://") || s.starts_with("http://") || s.starts_with("git@") || s.starts_with("ssh://")
}

fn slug(s: &str) -> String {
    let t: String = s
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .rsplit(['/', ':'])
        .take(2)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("-");
    let t: String = t.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' }).collect();
    if t.is_empty() { "skills".into() } else { t }
}

/// Add a catalogue: a local folder, or a Git repository (cloned into Hive's data folder).
#[tauri::command]
pub async fn skills_add_source(app: AppHandle, location: String) -> Result<SkillSource, String> {
    let location = location.trim().to_string();
    if location.is_empty() {
        return Err("Enter a folder or a Git URL".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut sources = load_sources(&app);
        if sources.iter().any(|s| s.location == location) {
            return Err("That catalogue is already added".into());
        }
        let source = if is_git_url(&location) {
            let base = clones_dir(&app).ok_or("No data directory")?;
            std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
            let mut dest = base.join(slug(&location));
            let mut n = 2;
            while dest.exists() {
                dest = base.join(format!("{}-{n}", slug(&location)));
                n += 1;
            }
            let out = std::process::Command::new("git")
                .args(["clone", "--depth", "1", "--", &location])
                .arg(&dest)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output()
                .map_err(|e| format!("Couldn't run git: {e}"))?;
            if !out.status.success() {
                let _ = std::fs::remove_dir_all(&dest);
                let err = String::from_utf8_lossy(&out.stderr);
                return Err(format!("git clone failed: {}", err.trim().lines().last().unwrap_or("unknown error")));
            }
            SkillSource {
                id: format!("git:{}", dest.file_name().unwrap().to_string_lossy()),
                label: slug(&location),
                kind: "git".into(),
                location: location.clone(),
                dir: dest.to_string_lossy().to_string(),
            }
        } else {
            let p = PathBuf::from(shellexpand_home(&location));
            if !p.is_dir() {
                return Err(format!("Not a folder: {location}"));
            }
            let p = p.canonicalize().unwrap_or(p);
            SkillSource {
                id: format!("folder:{}", p.to_string_lossy()),
                label: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| location.clone()),
                kind: "folder".into(),
                location: p.to_string_lossy().to_string(),
                dir: p.to_string_lossy().to_string(),
            }
        };
        let mut found = Vec::new();
        find_skills_deep(Path::new(&source.dir), 6, &mut found);
        if found.is_empty() {
            if source.kind == "git" {
                let _ = std::fs::remove_dir_all(&source.dir);
            }
            return Err("No skills found there (looked for SKILL.md files)".into());
        }
        sources.push(source.clone());
        save_sources(&app, &sources)?;
        Ok(source)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn shellexpand_home(p: &str) -> String {
    match p.strip_prefix("~/") {
        Some(rest) => home().join(rest).to_string_lossy().to_string(),
        None if p == "~" => home().to_string_lossy().to_string(),
        None => p.to_string(),
    }
}

/// Remove a catalogue. A cloned repository is deleted; a local folder is left alone.
#[tauri::command]
pub async fn skills_remove_source(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut sources = load_sources(&app);
        let Some(i) = sources.iter().position(|s| s.id == id) else {
            return Err("Unknown catalogue".into());
        };
        let s = sources.remove(i);
        if s.kind == "git" {
            if let Some(base) = clones_dir(&app) {
                let dir = PathBuf::from(&s.dir);
                if dir.starts_with(&base) {
                    let _ = std::fs::remove_dir_all(dir);
                }
            }
        }
        save_sources(&app, &sources)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- external skills ----------
// Folders anywhere on disk. Nothing is copied: sessions use the skills where
// they are — natively through the agent's `skills_template` (Claude Code:
// `--plugin-dir` with a plugin folder Hive keeps), otherwise Hive describes
// them in the conversation.

fn external_file(app: &AppHandle) -> Option<PathBuf> {
    crate::paths::config_dir(&app).map(|d| d.join("external_skills.json"))
}

fn load_external(app: &AppHandle) -> Vec<String> {
    external_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_external(app: &AppHandle, folders: &[String]) -> Result<(), String> {
    let p = external_file(app).ok_or("No config directory")?;
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, serde_json::to_string_pretty(folders).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn external_skills(app: &AppHandle) -> (Vec<Skill>, Vec<ExternalFolder>) {
    let mut skills: Vec<Skill> = Vec::new();
    let mut folders = Vec::new();
    for f in load_external(app) {
        let dir = Path::new(&f);
        let mut found = Vec::new();
        if dir.is_dir() {
            find_skills_deep(dir, 5, &mut found);
        }
        folders.push(ExternalFolder { path: f.clone(), found: found.len(), missing: !dir.is_dir() });
        for (mut s, _) in found {
            // The same skill reachable through two added folders counts once.
            if skills.iter().any(|x| x.paths == s.paths) {
                continue;
            }
            s.agents = vec!["All agents".into()];
            s.source = Some(tilde(dir));
            s.hive = false;
            skills.push(s);
        }
    }
    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    (skills, folders)
}

/// Add a folder with skills (one skill, or a folder of them) for every session.
#[tauri::command]
pub async fn skills_external_add(app: AppHandle, path: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(shellexpand_home(path.trim()));
        if !p.is_dir() {
            return Err(format!("Not a folder: {}", path.trim()));
        }
        let p = p.canonicalize().unwrap_or(p);
        let mut found = Vec::new();
        find_skills_deep(&p, 5, &mut found);
        if found.is_empty() {
            return Err(format!("No skills in {} (looked for SKILL.md files)", tilde(&p)));
        }
        let key = p.to_string_lossy().to_string();
        let mut folders = load_external(&app);
        if folders.contains(&key) {
            return Err("That folder is already added".into());
        }
        folders.push(key);
        save_external(&app, &folders)?;
        Ok(found.len())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stop using a folder's skills. The folder itself is left alone.
#[tauri::command]
pub async fn skills_external_remove(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut folders = load_external(&app);
        let n = folders.len();
        folders.retain(|f| f != &path);
        if folders.len() == n {
            return Err("That folder isn't in the list".into());
        }
        save_external(&app, &folders)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn strip_front_matter(text: &str) -> &str {
    let t = text.trim_start();
    if let Some(rest) = t.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let after = &rest[end + 4..];
            return after.trim_start_matches(|c| c != '\n').trim_start();
        }
    }
    t
}

const INLINE_BUDGET: usize = 24_000;

fn external_setup_for(skills: &[Skill], plugin_base: Option<&Path>) -> ExternalSetup {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for s in skills {
        s.paths[0].hash(&mut h);
        let md = Path::new(&s.paths[0]).join("SKILL.md");
        if let Ok(t) = std::fs::metadata(&md).and_then(|m| m.modified()) {
            t.hash(&mut h);
        }
    }
    let mut setup = ExternalSetup { count: skills.len(), signature: format!("{:x}", h.finish()), ..Default::default() };
    if skills.is_empty() {
        return setup;
    }
    // Claude Code plugin: <base>/.claude-plugin/plugin.json + skills/<name> → skill folder.
    if let Some(base) = plugin_base {
        let ok = (|| -> std::io::Result<()> {
            let links = base.join("skills");
            if links.exists() {
                std::fs::remove_dir_all(&links)?; // only links inside; their targets stay
            }
            std::fs::create_dir_all(&links)?;
            std::fs::create_dir_all(base.join(".claude-plugin"))?;
            std::fs::write(
                base.join(".claude-plugin/plugin.json"),
                r#"{"name":"hive-external","description":"Skills Hive loads from folders you added","version":"1.0.0"}"#,
            )?;
            let mut used = std::collections::HashSet::new();
            for s in skills {
                let mut name: String = s.name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
                let base_name = name.clone();
                let mut n = 2;
                while !used.insert(name.clone()) {
                    name = format!("{base_name}-{n}");
                    n += 1;
                }
                std::os::unix::fs::symlink(&s.paths[0], links.join(&name))?;
            }
            Ok(())
        })();
        if ok.is_ok() {
            setup.plugin_dir = Some(base.to_string_lossy().to_string());
        }
    }
    let intro = "Skills are available in this session. A skill is a folder with a SKILL.md of instructions, \
sometimes with scripts or reference files next to it.";
    let mut index = format!("<skills>\n{intro} When a request matches a skill's description, read its SKILL.md first and follow it.\n");
    for s in skills {
        index.push_str(&format!("- {}: {} ({}/SKILL.md)\n", s.name, s.description, s.paths[0]));
    }
    index.push_str("</skills>");
    let mut inline = format!("<skills>\n{intro} When a request matches a skill's description, follow its instructions.\n");
    let mut budget = INLINE_BUDGET;
    for s in skills {
        let body = std::fs::read_to_string(Path::new(&s.paths[0]).join("SKILL.md")).unwrap_or_default();
        let body = strip_front_matter(&body).trim();
        let block = format!("\n<skill name=\"{}\">\n{}\n{}\n</skill>\n", s.name, s.description, body);
        if block.len() <= budget {
            budget -= block.len();
            inline.push_str(&block);
        } else {
            inline.push_str(&format!("\n- {}: {} (too long to include)\n", s.name, s.description));
        }
    }
    inline.push_str("</skills>");
    setup.index = index;
    setup.inline = inline;
    setup
}

/// The skills index for Hive Agent: every skill it can use (project, user,
/// external and system), each once, with the path of its SKILL.md, which the
/// agent reads with its read tool when a request matches.
pub fn agent_skills_index(app: &AppHandle, cwd: &Path) -> String {
    let mut all: Vec<Skill> = project_skills(cwd).0;
    all.extend(user_skills());
    all.extend(external_skills(app).0);
    all.extend(system_skills());
    let mut seen = std::collections::HashSet::new();
    all.retain(|s| !s.paths.is_empty() && seen.insert(s.name.to_lowercase()));
    external_setup_for(&all, None).index
}

/// Prepare the external skills for sessions (and refresh the plugin folder).
#[tauri::command]
pub async fn skills_external_setup(app: AppHandle) -> Result<ExternalSetup, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (skills, _) = external_skills(&app);
        let base = crate::paths::data_dir(&app).map(|d| d.join("external-skills-plugin"));
        external_setup_for(&skills, base.as_deref())
    })
    .await
    .map_err(|e| e.to_string())
}

fn valid_skill_folder_name(n: &str) -> bool {
    !n.is_empty() && n != "." && n != ".." && n.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let name = e.file_name();
        if name == ".git" || name == MARKER {
            continue;
        }
        let src = e.path();
        let dst = to.join(&name);
        let meta = std::fs::metadata(&src)?; // follows symlinks
        if meta.is_dir() {
            copy_dir(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Add a catalogue skill to the user's skills (every folder in `install_targets`).
#[tauri::command]
pub async fn skills_install(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = PathBuf::from(&path);
        let (skill, text) = read_skill(&src).ok_or("That folder has no SKILL.md")?;
        if text.contains("CLAUDE_PLUGIN_ROOT") {
            return Err("This skill uses files from its Claude Code plugin; install the plugin in Claude Code instead.".into());
        }
        let folder = if valid_skill_folder_name(&skill.name) {
            skill.name.clone()
        } else {
            src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
        };
        if !valid_skill_folder_name(&folder) {
            return Err(format!("Can't use \"{}\" as a folder name", skill.name));
        }
        let targets = install_targets();
        for t in &targets {
            let dest = t.join(&folder);
            if dest.exists() && !dest.join(MARKER).exists() {
                return Err(format!("{} already exists and wasn't added by Hive", tilde(&dest)));
            }
        }
        for t in &targets {
            let dest = t.join(&folder);
            if dest.exists() {
                std::fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
            }
            copy_dir(&src, &dest).map_err(|e| format!("Copying to {}: {e}", tilde(&dest)))?;
            let marker = serde_json::json!({ "source": path, "installed_by": "Hive" });
            std::fs::write(dest.join(MARKER), marker.to_string()).map_err(|e| e.to_string())?;
        }
        Ok(skill.name)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove a skill Hive added. Skills Hive didn't add are never touched.
#[tauri::command]
pub async fn skills_uninstall(name: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut removed = 0;
        for t in install_targets() {
            let Ok(rd) = std::fs::read_dir(&t) else { continue };
            for e in rd.flatten() {
                let dir = e.path();
                if !dir.join(MARKER).exists() {
                    continue;
                }
                let same = read_skill(&dir).map(|(s, _)| s.name.eq_ignore_ascii_case(&name)).unwrap_or(false)
                    || e.file_name().to_string_lossy().eq_ignore_ascii_case(&name);
                if same {
                    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
                    removed += 1;
                }
            }
        }
        if removed == 0 {
            return Err(format!("{name} wasn't added by Hive, so Hive leaves it alone"));
        }
        Ok(removed)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Show a file or folder in Finder.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("It no longer exists".into());
    }
    std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn tilde(p: &Path) -> String {
    let h = home();
    match p.strip_prefix(&h) {
        Ok(rest) => format!("~/{}", rest.to_string_lossy()),
        Err(_) => p.to_string_lossy().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn front_matter_forms() {
        let (n, d) = parse_front_matter("---\nname: rex\ndescription: Use the rex CLI.\nmetadata:\n  x: 1\n---\nbody");
        assert_eq!(n.as_deref(), Some("rex"));
        assert_eq!(d.as_deref(), Some("Use the rex CLI."));
        let (_, d) = parse_front_matter("---\nname: a\ndescription: \"Quoted: \\\"yes\\\"\"\n---\n");
        assert_eq!(d.as_deref(), Some("Quoted: \"yes\""));
        let (_, d) = parse_front_matter("---\nname: a\ndescription: >\n  Folded\n  text\nlicense: MIT\n---\n");
        assert_eq!(d.as_deref(), Some("Folded text"));
        let (n, d) = parse_front_matter("# no front matter");
        assert!(n.is_none() && d.is_none());
    }

    /// Prints what this Mac has: `cargo test real_scan -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_scan() {
        let show = |label: &str, v: &[Skill]| {
            println!("{label}: {}", v.len());
            for s in v.iter().take(6) {
                println!("  {} [{}] {}{}", s.name, s.agents.join(", "), s.description.chars().take(60).collect::<String>(), if s.hive { " (hive)" } else { "" });
            }
        };
        let user = user_skills();
        show("system", &system_skills());
        show("user", &user);
        let (proj, root) = project_skills(&home().join("Developer/github.com/markdown-editor"));
        println!("project root {root:?}");
        show("project", &proj);
        let cat = catalogue(&detected_sources(), &user);
        show("catalogue", &cat);
        println!("blocked: {}", cat.iter().filter(|s| s.blocked.is_some()).count());
    }

    /// Add/remove against a throwaway HOME (never the real one).
    #[test]
    fn install_and_uninstall() {
        let tmp = std::env::temp_dir().join(format!("hive-skills-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let src = tmp.join("catalogue/pdf");
        std::fs::create_dir_all(src.join("scripts")).unwrap();
        std::fs::write(src.join("SKILL.md"), "---\nname: pdf\ndescription: PDFs\n---\n").unwrap();
        std::fs::write(src.join("scripts/run.py"), "print(1)").unwrap();
        // someone else's skill with another name, and one that clashes
        let own = tmp.join("home/.claude/skills/mine");
        std::fs::create_dir_all(&own).unwrap();
        std::fs::write(own.join("SKILL.md"), "---\nname: mine\n---\n").unwrap();
        *TEST_HOME.lock().unwrap() = Some(tmp.join("home"));
        use tauri::async_runtime::block_on as rt;

        assert_eq!(rt(skills_install(src.to_string_lossy().to_string())).unwrap(), "pdf");
        for t in install_targets() {
            assert!(t.join("pdf/SKILL.md").is_file() && t.join("pdf/scripts/run.py").is_file() && t.join("pdf").join(MARKER).is_file());
        }
        let user = user_skills();
        let pdf = user.iter().find(|s| s.name == "pdf").unwrap();
        assert!(pdf.hive && pdf.agents == vec!["Claude Code", "Shared"]);
        // the user's own skill is never removed
        assert!(rt(skills_uninstall("mine".into())).is_err());
        assert!(own.join("SKILL.md").is_file());
        // a clash with a skill Hive didn't add is refused
        let clash = tmp.join("catalogue/mine");
        std::fs::create_dir_all(&clash).unwrap();
        std::fs::write(clash.join("SKILL.md"), "---\nname: mine\n---\n").unwrap();
        assert!(rt(skills_install(clash.to_string_lossy().to_string())).unwrap_err().contains("wasn't added by Hive"));
        assert_eq!(rt(skills_uninstall("pdf".into())).unwrap(), 2);
        assert!(!install_targets()[0].join("pdf").exists());
        *TEST_HOME.lock().unwrap() = None;
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn external_setup_texts_and_links() {
        let tmp = std::env::temp_dir().join(format!("hive-ext-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let d = tmp.join("elsewhere/zebra");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("SKILL.md"), "---\nname: zebra-facts\ndescription: About zebras.\n---\n\nSay KUMQUAT.\n").unwrap();
        let mut found = Vec::new();
        find_skills_deep(&tmp.join("elsewhere"), 5, &mut found);
        let skills: Vec<Skill> = found.into_iter().map(|(s, _)| s).collect();
        let base = tmp.join("plugin");
        let setup = external_setup_for(&skills, Some(&base));
        assert_eq!(setup.count, 1);
        assert!(base.join("skills/zebra-facts/SKILL.md").is_file(), "link to the skill folder");
        assert!(base.join(".claude-plugin/plugin.json").is_file());
        assert!(setup.index.contains("zebra-facts: About zebras.") && setup.index.contains("zebra/SKILL.md"));
        assert!(setup.inline.contains("Say KUMQUAT.") && !setup.inline.contains("description: About"));
        let again = external_setup_for(&skills, Some(&base));
        assert_eq!(setup.signature, again.signature);
        assert!(external_setup_for(&[], None).plugin_dir.is_none());
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("https://github.com/anthropics/skills.git"), "anthropics-skills");
        assert_eq!(slug("git@github.com:me/my-skills"), "me-my-skills");
    }

    #[test]
    fn deep_scan_and_merge() {
        let tmp = std::env::temp_dir().join(format!("hive-skills-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        for (dir, name) in [("a/skills/one", "one"), ("b/two", "two"), ("c/.git/x", "hidden")] {
            let d = tmp.join(dir);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("SKILL.md"), format!("---\nname: {name}\ndescription: d\n---\n")).unwrap();
        }
        let mut found = Vec::new();
        find_skills_deep(&tmp, 6, &mut found);
        let mut names: Vec<_> = found.into_iter().map(|(s, _)| s.name).collect();
        names.sort();
        assert_eq!(names, vec!["one", "two"]);
        let merged = merge(vec![("Claude Code", skills_in(&tmp.join("a/skills"), true)), ("Shared", skills_in(&tmp.join("a/skills"), true))]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].agents, vec!["Claude Code", "Shared"]);
        std::fs::remove_dir_all(&tmp).unwrap();
    }
}
