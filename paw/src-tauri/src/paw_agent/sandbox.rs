//! Paw Agent's sandbox: what its commands and file changes may touch.
//!
//! A policy says where it may write (the project folder, always, plus the
//! folders listed), which programs its commands may start (any, or only the
//! ones listed) and whether they reach the network (always, never, or only
//! the listed programs). Settings › Sandbox holds the default; a tab can turn
//! it off or allow more programs, a factory can bring its own (`sandbox:` in
//! its file), and a project can make it stricter (`.paw/sandbox.yaml`).
//!
//! Commands run under macOS's sandbox (`sandbox-exec` with a profile Paw
//! writes before each command, so the network can be allowed per command);
//! file changes by Paw Agent's own tools are checked against the same folders.
//! Before a command runs, Paw checks the programs it names, so a blocked one
//! is reported plainly (and can be allowed) instead of failing obscurely.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A first list of programs for "only these programs": common development
/// tools and the small shell utilities scripts use.
pub const STARTER: &[&str] = &[
    "git", "gh", "npm", "npx", "node", "pnpm", "yarn", "bun", "deno", "cargo", "rustc", "rustup", "make", "cmake", "python3", "python",
    "pip3", "pip", "uv", "go", "swift", "swiftc", "xcodebuild", "xcrun", "java", "javac", "mvn", "gradle", "ls", "cat", "head", "tail",
    "grep", "rg", "sed", "awk", "find", "wc", "sort", "uniq", "cut", "tr", "diff", "mkdir", "cp", "mv", "rm", "rmdir", "touch", "ln", "chmod",
    "echo", "printf", "pwd", "which", "env", "dirname", "basename", "realpath", "date", "tee", "xargs", "test", "true", "false", "sleep",
    "tar", "gzip", "gunzip", "unzip", "zip", "jq", "file", "stat", "du", "df",
];

/// Shells and helpers a command always needs to start at all.
const ALWAYS: &[&str] = &["sh", "bash", "zsh", "dash", "env", "xcrun", "xcode-select", "sandbox-exec"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Policy {
    /// Sandbox on.
    pub enabled: bool,
    /// Folders it may write besides the project folder (and its session's
    /// scripts, a factory run's files and temp, which it always may).
    pub write: Vec<String>,
    /// Any program may run; else only `programs`.
    pub any_program: bool,
    pub programs: Vec<String>,
    /// "on", "off", or "listed" (only `network_programs`).
    pub network: String,
    pub network_programs: Vec<String>,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            enabled: false,
            write: vec![],
            any_program: true,
            programs: STARTER.iter().map(|s| s.to_string()).collect(),
            network: "on".into(),
            network_programs: ["git", "gh", "npm", "npx", "pnpm", "yarn", "cargo", "pip3", "pip", "uv", "go"].iter().map(|s| s.to_string()).collect(),
        }
    }
}

/// A sandbox section in a factory's file or a project's `.paw/sandbox.yaml`:
/// only what it says (a factory's turns the sandbox on unless `enabled: false`).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Spec {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub write: Option<Vec<String>>,
    /// Only these programs.
    #[serde(default)]
    pub run: Option<Vec<String>>,
    /// `true`, `false`, or a list of programs that may use it.
    #[serde(default)]
    pub network: Option<NetworkSpec>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum NetworkSpec {
    On(bool),
    Only(Vec<String>),
}

impl Spec {
    /// The check for a factory's file.
    pub fn check(&self) -> Result<(), String> {
        let bad = |v: &[String]| v.iter().find(|p| p.trim().is_empty() || p.contains('/') || p.contains(char::is_whitespace)).cloned();
        if let Some(p) = self.run.as_deref().and_then(bad) {
            return Err(format!("its sandbox's run list has “{p}”: name programs (git, npm), not paths or commands."));
        }
        if let Some(NetworkSpec::Only(v)) = &self.network {
            if let Some(p) = bad(v) {
                return Err(format!("its sandbox's network list has “{p}”: name programs (git, npm)."));
            }
        }
        Ok(())
    }

    /// A factory's sandbox: Settings' policy with this applied (on, unless it says otherwise).
    pub fn over(&self, base: &Policy) -> Policy {
        let mut p = base.clone();
        p.enabled = self.enabled.unwrap_or(true);
        if let Some(w) = &self.write {
            p.write = w.clone();
        }
        if let Some(r) = &self.run {
            p.any_program = false;
            p.programs = r.clone();
        }
        match &self.network {
            Some(NetworkSpec::On(on)) => p.network = if *on { "on" } else { "off" }.into(),
            Some(NetworkSpec::Only(v)) => {
                p.network = "listed".into();
                p.network_programs = v.clone();
            }
            None => {}
        }
        p
    }
}

fn level(network: &str) -> u8 {
    match network {
        "off" => 0,
        "listed" => 1,
        _ => 2,
    }
}

/// A project's rules on top of a policy: whichever is stricter wins.
pub fn tighten(p: &Policy, project: &Spec) -> Policy {
    let mut out = p.clone();
    if project.enabled != Some(false) {
        out.enabled = true;
    }
    if let Some(w) = &project.write {
        out.write.retain(|x| w.contains(x));
    }
    if let Some(r) = &project.run {
        out.programs = if out.any_program { r.clone() } else { out.programs.iter().filter(|x| r.contains(x)).cloned().collect() };
        out.any_program = false;
    }
    if let Some(n) = &project.network {
        let (theirs, list) = match n {
            NetworkSpec::On(true) => ("on", None),
            NetworkSpec::On(false) => ("off", None),
            NetworkSpec::Only(v) => ("listed", Some(v)),
        };
        if level(theirs) < level(&out.network) {
            out.network = theirs.into();
            if let Some(v) = list {
                out.network_programs = v.clone();
            }
        } else if theirs == "listed" && out.network == "listed" {
            let v = list.unwrap();
            out.network_programs.retain(|x| v.contains(x));
        }
    }
    out
}

/// A project's own rules, if it has `.paw/sandbox.yaml`.
pub fn project_spec(folder: &Path) -> Option<Spec> {
    let text = std::fs::read_to_string(folder.join(".paw").join("sandbox.yaml")).ok()?;
    serde_yaml::from_str(&text).ok()
}

/// Settings' policy (Settings › Sandbox).
pub fn from_settings() -> Policy {
    crate::paths::home()
        .and_then(|h| std::fs::read_to_string(h.join("settings.json")).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("sandbox").cloned())
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// The policy a session in `folder` gets: `asked` (a tab's or a factory's,
/// else Settings'), made stricter by the project's file. None: no sandbox.
pub fn effective(asked: Option<Policy>, folder: &Path) -> Option<Policy> {
    let base = asked.unwrap_or_else(from_settings);
    let p = match project_spec(folder) {
        Some(spec) => tighten(&base, &spec),
        None => base,
    };
    p.enabled.then_some(p)
}

/// The programs a shell line starts, by name: the first word of each
/// command (after variable assignments, and through `env`, `command`,
/// `exec`, `nohup`, `time`, `xargs`, `sudo`). Shell keywords and builtins
/// that start nothing are left out. A rough reading: the sandbox's profile
/// stops what it misses.
pub fn programs_in(line: &str) -> Vec<String> {
    // Keywords before a command: the command comes after them.
    const BEFORE: &[&str] = &["if", "then", "else", "elif", "do", "while", "until", "!", "{"];
    const SKIP: &[&str] = &[
        "fi", "for", "in", "done", "case", "esac", "function", "}", "[[", "]]",
        "cd", "export", "set", "unset", "read", "exit", "return", "source", ".", "alias", "local", "shift", "trap", "wait", "eval", "[", ":",
        "pushd", "popd", "type", "hash", "ulimit", "umask", "declare", "typeset",
    ];
    const THROUGH: &[&str] = &["env", "command", "exec", "nohup", "time", "xargs", "sudo", "nice"];
    let mut out: Vec<String> = vec![];
    let mut s = line.replace("$(", "\n").replace('`', "\n").replace("<(", "\n");
    for sep in ["||", "&&", "|", ";", "&", "(", ")"] {
        s = s.replace(sep, "\n");
    }
    for seg in s.lines() {
        let mut words = seg.split_whitespace().map(|w| w.trim_matches(|c| c == '"' || c == '\''));
        while let Some(w) = words.next() {
            if w.is_empty() || (w.contains('=') && !w.starts_with('=') && !w.contains('/')) {
                continue; // VAR=value
            }
            if w.starts_with('>') || w.starts_with('<') || w.chars().next().is_some_and(|c| c.is_ascii_digit()) && w.contains('>') {
                break;
            }
            let name = w.rsplit('/').next().unwrap_or(w).to_string();
            if BEFORE.contains(&name.as_str()) {
                continue;
            }
            if SKIP.contains(&name.as_str()) {
                break;
            }
            if !out.contains(&name) {
                out.push(name.clone());
            }
            if THROUGH.contains(&name.as_str()) {
                // The next word that isn't an option is the program it starts.
                for n in words.by_ref() {
                    if n.starts_with('-') || n.contains('=') {
                        continue;
                    }
                    let n = n.rsplit('/').next().unwrap_or(n).to_string();
                    if !out.contains(&n) {
                        out.push(n);
                    }
                    break;
                }
            }
            break;
        }
    }
    out
}

/// What the sandbox says about a command: a program that may not run, or
/// whether the command may use the network.
#[derive(Debug, PartialEq)]
pub enum Verdict {
    Run { network: bool },
    Blocked { program: String },
}

pub fn check(p: &Policy, line: &str) -> Verdict {
    let progs = programs_in(line);
    if !p.any_program {
        if let Some(prog) = progs.iter().find(|x| !ALWAYS.contains(&x.as_str()) && !p.programs.contains(x)) {
            return Verdict::Blocked { program: prog.clone() };
        }
    }
    let network = match p.network.as_str() {
        "off" => false,
        "listed" => {
            // Every program it names is allowed the network (a bare shell line names none: no network).
            let named: Vec<&String> = progs.iter().filter(|x| !ALWAYS.contains(&x.as_str())).collect();
            !named.is_empty() && named.iter().all(|x| p.network_programs.contains(x))
        }
        _ => true,
    };
    Verdict::Run { network }
}

/// The folders it may write: the project folder, the extra ones, and those
/// Paw always gives it (its scripts, a run's shared files, temp).
pub fn roots(p: &Policy, folder: &Path, also: &[PathBuf]) -> Vec<PathBuf> {
    let mut r = vec![folder.to_path_buf()];
    r.extend(p.write.iter().filter(|w| !w.trim().is_empty()).map(|w| crate::agents::expand_home(w.trim())));
    r.extend(also.iter().cloned());
    for t in ["/private/tmp", "/private/var/folders", "/tmp"] {
        r.push(PathBuf::from(t));
    }
    if let Ok(t) = std::env::var("TMPDIR") {
        r.push(PathBuf::from(t));
    }
    r.iter().map(|p| std::fs::canonicalize(p).unwrap_or_else(|_| p.clone())).collect()
}

/// May a file tool change `path`? (The path need not exist yet.)
pub fn may_write(roots: &[PathBuf], path: &Path) -> bool {
    // Resolve what exists of the path, so `..` and symlinks can't step out.
    let mut probe = path.to_path_buf();
    let mut rest = vec![];
    let real = loop {
        if let Ok(r) = std::fs::canonicalize(&probe) {
            break rest.iter().rev().fold(r, |acc: PathBuf, part: &std::ffi::OsString| acc.join(part));
        }
        match (probe.file_name().map(|f| f.to_os_string()), probe.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                probe = parent;
            }
            _ => break path.to_path_buf(),
        }
    };
    roots.iter().any(|r| real.starts_with(r))
}

fn quote(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"")
}

/// The macOS sandbox profile for one command.
pub fn profile(p: &Policy, roots: &[PathBuf], network: bool) -> String {
    let mut s = String::from("(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write*\n");
    for r in roots {
        s.push_str(&format!("  (subpath \"{}\")\n", quote(r)));
    }
    s.push_str("  (literal \"/dev/null\") (literal \"/dev/zero\") (regex #\"^/dev/(tty|fd/|ptmx|ttys)\"))\n");
    if !network {
        s.push_str("(deny network*)\n(allow network* (local unix-socket) (remote unix-socket) (remote ip \"localhost:*\"))\n");
    }
    if !p.any_program {
        let names: Vec<String> = p.programs.iter().map(String::as_str).chain(ALWAYS.iter().copied()).filter(|n| !n.is_empty()).map(regex::escape).collect();
        // The program by its name anywhere (Homebrew, Xcode's tools, shims), and its helpers (git-remote-https).
        // (macOS's sandbox reads [^/] but not every bracket range.)
        s.push_str(&format!("(deny process-exec)\n(allow process-exec (regex #\"/({})(-[^/]+)?$\"))\n", names.join("|").replace('"', "")));
    }
    s
}

/// Where a session's profile is written before each command.
pub fn profile_path(session_dir: Option<&Path>, id: u32) -> PathBuf {
    match session_dir {
        Some(d) => d.join("sandbox.sb"),
        None => std::env::temp_dir().join(format!("paw-sandbox-{id}.sb")),
    }
}

/// What Paw Agent is told about its sandbox.
pub fn describe(p: &Policy, roots: &[PathBuf]) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let show = |r: &PathBuf| {
        let s = r.to_string_lossy().to_string();
        if !home.is_empty() && s.starts_with(&home) { format!("~{}", &s[home.len()..]) } else { s }
    };
    let places: Vec<String> = roots.iter().filter(|r| !r.starts_with("/private/var/folders") && !r.starts_with("/private/tmp") && !r.starts_with("/tmp")).map(show).collect();
    let programs = if p.any_program { "any program".to_string() } else { format!("only these programs: {}", p.programs.join(", ")) };
    let network = match p.network.as_str() {
        "off" => "no network access".to_string(),
        "listed" => format!("network access only for {}", p.network_programs.join(", ")),
        _ => "network access".to_string(),
    };
    format!(
        "You work in a sandbox. Your commands and file changes may only change files in: {} (and temp). Your commands may run {programs}, with {network}. \
         If the sandbox blocks something you need, don't try to get around it: tell the user what was blocked and why it's needed, so they can allow it.",
        places.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn only(programs: &[&str], network: &str, net_programs: &[&str]) -> Policy {
        Policy {
            enabled: true,
            any_program: false,
            programs: programs.iter().map(|s| s.to_string()).collect(),
            network: network.into(),
            network_programs: net_programs.iter().map(|s| s.to_string()).collect(),
            ..Policy::default()
        }
    }

    #[test]
    fn the_programs_of_a_shell_line() {
        assert_eq!(programs_in("git status -sb | head -5"), ["git", "head"]);
        assert_eq!(programs_in("cd sub && FOO=1 npm test; echo done"), ["npm", "echo"]);
        assert_eq!(programs_in("env NODE_ENV=x node build.js"), ["env", "node"]);
        assert_eq!(programs_in("echo $(curl -s x) > out.txt"), ["echo", "curl"]);
        assert_eq!(programs_in("/opt/homebrew/bin/rg foo src"), ["rg"]);
        assert_eq!(programs_in("find . -name '*.rs' | xargs -n1 wc -l"), ["find", "xargs", "wc"]);
        assert_eq!(programs_in("if test -f a; then cat a; fi"), ["test", "cat"]);
    }

    #[test]
    fn programs_and_network_are_checked() {
        let p = only(&["git", "gh", "ls"], "listed", &["git", "gh"]);
        assert_eq!(check(&p, "git push origin main"), Verdict::Run { network: true });
        assert_eq!(check(&p, "git status | ls"), Verdict::Run { network: false }, "ls isn't on the network list");
        assert_eq!(check(&p, "curl https://x"), Verdict::Blocked { program: "curl".into() });
        assert_eq!(check(&p, "sh -c 'git log'"), Verdict::Run { network: false }, "shells always start");
        let any = Policy { enabled: true, network: "off".into(), ..Policy::default() };
        assert_eq!(check(&any, "curl https://x"), Verdict::Run { network: false });
    }

    #[test]
    fn a_project_makes_it_stricter_never_looser() {
        let tab = Policy { enabled: false, write: vec!["~/.cargo".into(), "~/.npm".into()], ..Policy::default() };
        let project: Spec = serde_yaml::from_str("write: [\"~/.npm\"]\nrun: [git, npm]\nnetwork: [git]\n").unwrap();
        let p = tighten(&tab, &project);
        assert!(p.enabled, "a project's file turns it on");
        assert_eq!(p.write, ["~/.npm"]);
        assert_eq!((p.any_program, p.programs.clone()), (false, vec!["git".to_string(), "npm".to_string()]));
        assert_eq!((p.network.as_str(), p.network_programs.clone()), ("listed", vec!["git".to_string()]));
        let off = tighten(&p, &serde_yaml::from_str("network: false\n").unwrap());
        assert_eq!(off.network, "off");
        let open = tighten(&off, &serde_yaml::from_str("network: true\nrun: [git, npm, curl]\n").unwrap());
        assert_eq!(open.network, "off", "a project can't loosen it");
        assert_eq!(open.programs, ["git", "npm"], "nor add programs");
    }

    #[test]
    fn a_factorys_section_turns_it_on_over_settings() {
        let spec: Spec = serde_yaml::from_str("run: [git, gh]\nnetwork: [gh]\n").unwrap();
        let p = spec.over(&Policy::default());
        assert!(p.enabled && !p.any_program);
        assert_eq!(p.network_programs, ["gh"]);
        assert!(serde_yaml::from_str::<Spec>("run: [\"/usr/bin/curl\"]\n").unwrap().check().is_err());
        assert!(!serde_yaml::from_str::<Spec>("enabled: false\n").unwrap().over(&Policy::default()).enabled);
    }

    #[test]
    fn writes_stay_in_the_roots() {
        let base = std::env::temp_dir().join(format!("paw-sb-{}", std::process::id()));
        std::fs::create_dir_all(base.join("proj/src")).unwrap();
        let roots = vec![std::fs::canonicalize(base.join("proj")).unwrap()];
        assert!(may_write(&roots, &base.join("proj/src/new.rs")), "a new file inside");
        assert!(!may_write(&roots, &base.join("proj/../outside.txt")), "no stepping out with ..");
        assert!(!may_write(&roots, Path::new("/etc/hosts")));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn the_profile_says_what_the_policy_says() {
        let p = only(&["git"], "off", &[]);
        let prof = profile(&p, &[PathBuf::from("/work/app")], false);
        assert!(prof.contains("(subpath \"/work/app\")"));
        assert!(prof.contains("(deny network*)"));
        assert!(prof.contains("(deny process-exec)") && prof.contains("git"));
        let open = profile(&Policy { enabled: true, ..Policy::default() }, &[], true);
        assert!(!open.contains("deny network") && !open.contains("process-exec"));
    }
}
