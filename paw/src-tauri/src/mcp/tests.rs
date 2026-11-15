use super::*;
use std::sync::Mutex;

struct Tmp(PathBuf);
impl Tmp {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("paw-mcp-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(p.join("home")).unwrap();
        std::fs::create_dir_all(p.join("proj")).unwrap();
        std::fs::create_dir_all(p.join("cfg")).unwrap();
        Tmp(p)
    }
    fn home(&self) -> PathBuf {
        self.0.join("home")
    }
    fn proj(&self) -> PathBuf {
        self.0.join("proj")
    }
    fn cfg(&self) -> PathBuf {
        self.0.join("cfg")
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Stands in for `claude` and `copilot`: records what Paw runs.
#[derive(Default)]
struct FakeClaude(Mutex<Vec<(PathBuf, Vec<String>)>>, Option<Value>, bool);
impl Clis for FakeClaude {
    fn claude(&self, cwd: &Path, args: &[String]) -> Result<(), String> {
        self.0.lock().unwrap().push((cwd.to_path_buf(), args.to_vec()));
        Ok(())
    }
    fn claude_installed(&self) -> bool {
        self.2
    }
    fn copilot_list(&self, _cwd: &Path) -> Option<Value> {
        self.1.clone()
    }
    fn copilot(&self, cwd: &Path, args: &[String]) -> Result<(), String> {
        let mut a = vec!["copilot".to_string()];
        a.extend(args.iter().cloned());
        self.0.lock().unwrap().push((cwd.to_path_buf(), a));
        Ok(())
    }
}
fn no_cli() -> FakeClaude {
    FakeClaude::default()
}
fn with_claude() -> FakeClaude {
    FakeClaude(Mutex::default(), None, true)
}

fn stdio(name: &str) -> McpServer {
    McpServer {
        name: name.into(),
        transport: "stdio".into(),
        command: "npx".into(),
        args: vec!["-y".into(), "@modelcontextprotocol/server-filesystem".into(), "/tmp".into()],
        env: BTreeMap::from([("API_TOKEN".into(), "secret-value".into())]),
        enabled: true,
        ..Default::default()
    }
}

fn http(name: &str) -> McpServer {
    McpServer {
        name: name.into(),
        transport: "http".into(),
        url: "https://mcp.example.com/mcp".into(),
        headers: BTreeMap::from([("Authorization".into(), "Bearer xyz".into())]),
        enabled: true,
        ..Default::default()
    }
}

fn names(r: &Report, scope: &str) -> Vec<String> {
    r.scopes.iter().find(|s| s.id == scope).unwrap().servers.iter().map(|s| s.name.clone()).collect()
}

fn ctx<'a>(t: &'a Tmp, home: &'a Path, proj: &'a Path, cfg: &'a Path, agent: &'a str, clis: &'a dyn Clis) -> Ctx<'a> {
    let _ = t;
    Ctx { agent, cwd: proj, home, config_dir: Some(cfg), clis }
}

#[test]
fn json_agents_round_trip_and_keep_the_rest_of_the_file() {
    let t = Tmp::new("json");
    let (home, proj, cfg) = (t.home(), t.proj(), t.cfg());
    let fake = FakeClaude::default();
    std::fs::create_dir_all(home.join(".gemini")).unwrap();
    // A settings file with other keys in a particular order.
    std::fs::write(home.join(".gemini/settings.json"), r#"{"theme":"dark","mcpServers":{"old":{"command":"x"}},"zzz":1}"#).unwrap();
    for agent in ["paw", "gemini", "qwen", "cursor-agent", "opencode", "copilot"] {
        let c = ctx(&t, &home, &proj, &cfg, agent, &fake);
        let scope = if agent == "paw" { "paw" } else { "user" };
        add(&c, scope, stdio("files")).unwrap();
        add(&c, scope, http("remote")).unwrap();
        assert!(add(&c, scope, stdio("files")).unwrap_err().contains("already"), "{agent}");
        let r = report(agent, &proj, &home, Some(&cfg), &no_cli());
        let got = names(&r, scope);
        assert!(got.contains(&"files".to_string()) && got.contains(&"remote".to_string()), "{agent}: {got:?}");
        // Read back as written.
        let l = location(agent, scope, &proj, &home, Some(&cfg)).unwrap();
        let back = read_location(&l, &proj).unwrap();
        let f = back.iter().find(|s| s.name == "files").unwrap();
        assert_eq!((f.transport.as_str(), f.command.as_str(), f.args.len()), ("stdio", "npx", 3), "{agent}");
        assert_eq!(f.env.get("API_TOKEN").map(String::as_str), Some("secret-value"), "{agent}");
        let h = back.iter().find(|s| s.name == "remote").unwrap();
        assert_eq!((h.transport.as_str(), h.url.as_str()), ("http", "https://mcp.example.com/mcp"), "{agent}");
        remove(&c, scope, "files").unwrap();
        assert!(!names(&report(agent, &proj, &home, Some(&cfg), &no_cli()), scope).contains(&"files".to_string()), "{agent}");
    }
    // The Gemini file kept its other keys, in order, and a backup.
    let text = std::fs::read_to_string(home.join(".gemini/settings.json")).unwrap();
    let theme = text.find("\"theme\"").unwrap();
    let servers = text.find("\"mcpServers\"").unwrap();
    let zzz = text.find("\"zzz\"").unwrap();
    assert!(theme < servers && servers < zzz, "{text}");
    assert!(text.contains("\"httpUrl\""), "Gemini's streamable HTTP key: {text}");
    assert!(home.join(".gemini/settings.json.paw-backup").exists());
    // opencode's own shape.
    let oc = std::fs::read_to_string(home.join(".config/opencode/opencode.json")).unwrap();
    assert!(oc.contains("\"type\": \"remote\"") && oc.contains("\"mcp\""), "{oc}");
}

#[test]
fn paw_list_toggles_and_lists_enabled_servers() {
    let t = Tmp::new("paw");
    let (home, proj, cfg) = (t.home(), t.proj(), t.cfg());
    let fake = FakeClaude::default();
    let c = ctx(&t, &home, &proj, &cfg, "paw", &fake);
    add(&c, "paw", stdio("a")).unwrap();
    add(&c, "paw", http("b")).unwrap();
    set_enabled(&c, "paw", "a", false).unwrap();
    let on: Vec<String> = paw_servers(Some(&cfg)).into_iter().map(|s| s.name).collect();
    assert_eq!(on, ["b"]);
    let r = report("paw", &proj, &home, Some(&cfg), &no_cli());
    let a = &r.scopes[0].servers.iter().find(|s| s.name == "a").unwrap();
    assert!(!a.enabled && r.scopes[0].can_toggle);
    assert!(set_enabled(&c, "paw", "gone", true).is_err());
}

#[test]
fn claude_code_changes_go_through_its_cli() {
    let t = Tmp::new("claude");
    let (home, proj, cfg) = (t.home(), t.proj(), t.cfg());
    // What Claude Code has: a user server, a local one for this folder, a project one.
    let key = claude_project_key(&proj);
    std::fs::write(
        home.join(".claude.json"),
        serde_json::to_string(&json!({
            "mcpServers": {"github": {"type": "http", "url": "https://api.githubcopilot.com/mcp/"}},
            "projects": {key: {"mcpServers": {"db": {"type": "stdio", "command": "pg-mcp", "args": [], "env": {"PGPASSWORD": "pw"}}}}},
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(proj.join(".mcp.json"), r#"{"mcpServers":{"docs":{"command":"docs-mcp"}}}"#).unwrap();
    let r = report("claude", &proj, &home, Some(&cfg), &with_claude());
    assert_eq!(names(&r, "user"), ["github"]);
    assert_eq!(names(&r, "local"), ["db"]);
    assert_eq!(names(&r, "project"), ["docs"]);
    assert!(r.scopes.iter().all(|s| s.writable && s.can_toggle));
    let before = std::fs::read_to_string(home.join(".claude.json")).unwrap();
    let fake = FakeClaude::default();
    let c = ctx(&t, &home, &proj, &cfg, "claude", &fake);
    add(&c, "local", stdio("files")).unwrap();
    remove(&c, "user", "github").unwrap();
    // ~/.claude.json was not touched by Paw.
    assert_eq!(std::fs::read_to_string(home.join(".claude.json")).unwrap(), before);
    let calls = fake.0.lock().unwrap();
    assert_eq!(calls[0].0, proj);
    assert_eq!(&calls[0].1[..5], ["mcp", "add-json", "--scope", "local", "files"]);
    let entry: Value = serde_json::from_str(&calls[0].1[5]).unwrap();
    assert_eq!(entry["type"], "stdio");
    assert_eq!(entry["command"], "npx");
    assert_eq!(calls[1].1, ["mcp", "remove", "--scope", "user", "github"]);
    // Without the claude command, adding and removing are off; switching isn't.
    assert!(report("claude", &proj, &home, Some(&cfg), &no_cli()).scopes.iter().all(|s| !s.writable && s.can_toggle));
}

#[test]
fn codex_toml_keeps_comments() {
    let t = Tmp::new("codex");
    let (home, proj, cfg) = (t.home(), t.proj(), t.cfg());
    std::fs::create_dir_all(home.join(".codex")).unwrap();
    std::fs::write(home.join(".codex/config.toml"), "# my settings\nmodel = \"gpt-5\"\n\n[mcp_servers.existing]\ncommand = \"old\" # keep me\n").unwrap();
    let fake = FakeClaude::default();
    let c = ctx(&t, &home, &proj, &cfg, "codex", &fake);
    add(&c, "user", stdio("files")).unwrap();
    add(&c, "user", http("remote")).unwrap();
    set_enabled(&c, "user", "files", false).unwrap();
    let text = std::fs::read_to_string(home.join(".codex/config.toml")).unwrap();
    assert!(text.contains("# my settings") && text.contains("# keep me") && text.contains("model = \"gpt-5\""), "{text}");
    let back = read_codex(&home.join(".codex/config.toml")).unwrap();
    let names: Vec<&str> = back.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["existing", "files", "remote"]);
    assert!(!back[1].enabled && back[2].transport == "http" && back[1].env["API_TOKEN"] == "secret-value");
    remove(&c, "user", "existing").unwrap();
    assert_eq!(read_codex(&home.join(".codex/config.toml")).unwrap().len(), 2);
}

#[test]
fn files_paw_cant_parse_are_left_alone() {
    let t = Tmp::new("jsonc");
    let (home, proj, cfg) = (t.home(), t.proj(), t.cfg());
    std::fs::create_dir_all(home.join(".cursor")).unwrap();
    let original = "{ // my servers\n \"mcpServers\": {} }";
    std::fs::write(home.join(".cursor/mcp.json"), original).unwrap();
    let r = report("cursor-agent", &proj, &home, Some(&cfg), &no_cli());
    let user = r.scopes.iter().find(|s| s.id == "user").unwrap();
    assert!(!user.writable && user.note.contains("comments"));
    let fake = FakeClaude::default();
    assert!(add(&ctx(&t, &home, &proj, &cfg, "cursor-agent", &fake), "user", stdio("x")).is_err());
    assert_eq!(std::fs::read_to_string(home.join(".cursor/mcp.json")).unwrap(), original);
}

#[test]
fn the_panel_never_sees_secret_values() {
    let t = Tmp::new("secret");
    let (home, proj, cfg) = (t.home(), t.proj(), t.cfg());
    let fake = FakeClaude::default();
    let c = ctx(&t, &home, &proj, &cfg, "paw", &fake);
    add(&c, "paw", stdio("a")).unwrap();
    add(&c, "paw", http("b")).unwrap();
    let shown = serde_json::to_string(&report("paw", &proj, &home, Some(&cfg), &no_cli())).unwrap();
    assert!(!shown.contains("secret-value") && !shown.contains("Bearer xyz"), "{shown}");
    assert!(shown.contains("API_TOKEN") && shown.contains("Authorization"));
}

#[test]
fn input_checks_and_command_lines() {
    assert_eq!(split_command(r#"npx -y "@scope/server name" --root '/a b' x\ y"#).unwrap(), ["npx", "-y", "@scope/server name", "--root", "/a b", "x y"]);
    assert_eq!(split_command("  ").unwrap(), Vec::<String>::new());
    assert!(split_command("echo 'open").is_err());
    let s = parse_input(AddInput {
        name: " fs ".into(),
        transport: "stdio".into(),
        command_line: "npx -y server".into(),
        url: String::new(),
        env: "A=1\n\n B = two=2 ".into(),
        headers: String::new(),
    })
    .unwrap();
    assert_eq!((s.name.as_str(), s.command.as_str(), s.args.len()), ("fs", "npx", 2));
    assert_eq!(s.env["B"], "two=2");
    assert!(check(&McpServer { name: "bad name".into(), transport: "stdio".into(), command: "x".into(), ..Default::default() }).is_err());
    assert!(check(&McpServer { name: "r".into(), transport: "http".into(), url: "ftp://x".into(), ..Default::default() }).is_err());
    let r = report("aider", Path::new("/"), Path::new("/"), None, &no_cli());
    assert!(!r.supported && r.note.contains("doesn't use MCP"));
}

fn view<'a>(r: &'a Report, scope: &str, name: &str) -> &'a ServerView {
    r.scopes.iter().find(|s| s.id == scope).unwrap().servers.iter().find(|s| s.name == name).unwrap()
}

fn claude_json(home: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(home.join(".claude.json")).unwrap()).unwrap()
}

#[test]
fn claude_code_on_off_as_claude_code_sees_it() {
    let t = Tmp::new("claude-state");
    let (home, cfg) = (t.home(), t.cfg());
    // A git repo; the tab works in a subfolder. Claude Code files the
    // project under the repo root.
    let repo = t.proj();
    std::fs::create_dir_all(repo.join(".git")).unwrap();
    std::fs::create_dir_all(repo.join("app/src")).unwrap();
    let cwd = repo.join("app/src");
    let key = claude_project_key(&cwd);
    assert_eq!(key, repo.canonicalize().unwrap().display().to_string());
    std::fs::write(
        home.join(".claude.json"),
        serde_json::to_string_pretty(&json!({
            "numStartups": 7,
            "mcpServers": {"github": {"type": "http", "url": "https://x/mcp"}, "files": {"command": "fs-mcp"}},
            "projects": {key.clone(): {"allowedTools": [], "disabledMcpServers": ["github"], "mcpServers": {"db": {"command": "pg"}}}},
            "zLast": true,
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(repo.join(".mcp.json"), r#"{"mcpServers":{"docs":{"command":"d"},"lint":{"command":"l"},"wip":{"command":"w"}}}"#).unwrap();
    std::fs::create_dir_all(repo.join(".claude")).unwrap();
    std::fs::write(repo.join(".claude/settings.local.json"), r#"{"enabledMcpjsonServers":["docs"]}"#).unwrap();
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::write(home.join(".claude/settings.json"), r#"{"model":"opus","disabledMcpjsonServers":["lint"]}"#).unwrap();

    let r = report("claude", &cwd, &home, Some(&cfg), &with_claude());
    assert!(!view(&r, "user", "github").enabled, "disabled for this project");
    assert!(view(&r, "user", "files").enabled);
    assert!(view(&r, "local", "db").enabled, "local servers are read from the repo root's entry");
    assert!(view(&r, "project", "docs").enabled);
    let lint = view(&r, "project", "lint");
    assert!(!lint.enabled && !lint.pending, "rejected in user settings");
    let wip = view(&r, "project", "wip");
    assert!(!wip.enabled && wip.pending, "nobody decided yet");

    let fake = with_claude();
    let c = Ctx { agent: "claude", cwd: &cwd, home: &home, config_dir: Some(&cfg), clis: &fake };
    // On again: out of disabledMcpServers in the project entry; the rest of the file kept.
    let perms = |p: &Path| { use std::os::unix::fs::PermissionsExt; std::fs::metadata(p).unwrap().permissions().mode() & 0o777 };
    std::fs::set_permissions(home.join(".claude.json"), std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
    set_enabled(&c, "user", "github", true).unwrap();
    let j = claude_json(&home);
    assert_eq!(j["projects"][&key]["disabledMcpServers"], json!([]));
    assert_eq!((j["numStartups"].clone(), j["zLast"].clone()), (json!(7), json!(true)));
    let text = std::fs::read_to_string(home.join(".claude.json")).unwrap();
    assert!(text.find("numStartups") < text.find("zLast"), "key order kept");
    assert_eq!(perms(&home.join(".claude.json")), 0o600, "permissions kept");
    assert!(home.join(".claude.json.paw-backup").exists());
    // Off: a local server.
    set_enabled(&c, "local", "db", false).unwrap();
    assert_eq!(claude_json(&home)["projects"][&key]["disabledMcpServers"], json!(["db"]));
    // Approve the pending project server, and the one the user's settings rejected.
    set_enabled(&c, "project", "wip", true).unwrap();
    set_enabled(&c, "project", "lint", true).unwrap();
    let local: Value = serde_json::from_str(&std::fs::read_to_string(repo.join(".claude/settings.local.json")).unwrap()).unwrap();
    assert_eq!(local["enabledMcpjsonServers"], json!(["docs", "wip", "lint"]));
    let user: Value = serde_json::from_str(&std::fs::read_to_string(home.join(".claude/settings.json")).unwrap()).unwrap();
    assert_eq!((user["disabledMcpjsonServers"].clone(), user["model"].clone()), (json!([]), json!("opus")));
    // Turn one off again: rejected locally.
    set_enabled(&c, "project", "docs", false).unwrap();
    let r = report("claude", &cwd, &home, Some(&cfg), &with_claude());
    assert!(view(&r, "project", "wip").enabled && view(&r, "project", "lint").enabled && !view(&r, "project", "docs").enabled);
    assert!(view(&r, "user", "github").enabled && !view(&r, "local", "db").enabled);
    // Paw never ran claude for any of it.
    assert!(fake.0.lock().unwrap().is_empty());
}

#[test]
fn claude_code_shared_project_rejections_are_left_to_the_team() {
    let t = Tmp::new("claude-shared");
    let (home, proj, cfg) = (t.home(), t.proj(), t.cfg());
    std::fs::write(home.join(".claude.json"), "{}").unwrap();
    std::fs::write(proj.join(".mcp.json"), r#"{"mcpServers":{"docs":{"command":"d"}}}"#).unwrap();
    std::fs::create_dir_all(proj.join(".claude")).unwrap();
    std::fs::write(proj.join(".claude/settings.json"), r#"{"disabledMcpjsonServers":["docs"]}"#).unwrap();
    let fake = with_claude();
    let c = Ctx { agent: "claude", cwd: &proj, home: &home, config_dir: Some(&cfg), clis: &fake };
    let err = set_enabled(&c, "project", "docs", true).unwrap_err();
    assert!(err.contains("shared settings"), "{err}");
    assert!(set_enabled(&c, "user", "nope", true).unwrap_err().contains("isn't there"));
}

#[test]
fn copilot_on_off_through_its_cli() {
    let t = Tmp::new("copilot");
    let (home, proj, cfg) = (t.home(), t.proj(), t.cfg());
    let list = json!({"mcpServers": {
        "github-mcp-server": {"type": "http", "url": "https://api.githubcopilot.com/mcp/", "source": "builtin", "enabled": true},
        "computer-use": {"type": "stdio", "command": "/x/computer-use-mcp", "args": [], "env": {"PLUGIN_DATA": "/secret/path"}, "source": "builtin", "enabled": false},
        "mine": {"type": "local", "command": "npx", "args": ["-y", "m"], "env": {"TOKEN": "s3cret"}, "source": "user", "enabled": true},
        "repo": {"type": "local", "command": "r", "source": "workspace", "enabled": true},
    }});
    let fake = FakeClaude(Mutex::default(), Some(list), false);
    let r = report("copilot", &proj, &home, Some(&cfg), &fake);
    let ids: Vec<&str> = r.scopes.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["builtin", "user", "workspace"]);
    assert!(!view(&r, "builtin", "computer-use").enabled && view(&r, "builtin", "github-mcp-server").enabled);
    assert!(r.scopes.iter().all(|s| s.can_toggle) && r.scopes.iter().filter(|s| s.writable).count() == 1);
    let shown = serde_json::to_string(&r).unwrap();
    assert!(!shown.contains("s3cret") && !shown.contains("/secret/path") && shown.contains("TOKEN"));
    let c = Ctx { agent: "copilot", cwd: &proj, home: &home, config_dir: Some(&cfg), clis: &fake };
    set_enabled(&c, "builtin", "computer-use", true).unwrap();
    set_enabled(&c, "user", "mine", false).unwrap();
    let calls = fake.0.lock().unwrap();
    assert_eq!(calls[0].1, ["copilot", "mcp", "enable", "computer-use"]);
    assert_eq!(calls[1].1, ["copilot", "mcp", "disable", "mine"]);
    drop(calls);
    // Without the CLI: its config file, as before.
    let r = report("copilot", &proj, &home, Some(&cfg), &no_cli());
    assert_eq!(r.scopes.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["user"]);
}

/// This Mac's real Claude Code and Copilot servers, read only (names and
/// states): `cargo test real_mcp_state -- --ignored --nocapture`
#[test]
#[ignore]
fn real_mcp_state_this_mac() {
    let home = PathBuf::from(std::env::var("HOME").unwrap());
    for (agent, cwd) in [("claude", home.clone()), ("claude", std::env::current_dir().unwrap()), ("copilot", home.clone())] {
        let r = report(agent, &cwd, &home, None, &SystemClis);
        println!("{agent} in {} (project root {}):", cwd.display(), claude_project_root(&cwd).display());
        for sc in &r.scopes {
            let list: Vec<String> = sc.servers.iter().map(|s| format!("{}{}", s.name, if s.pending { " (needs approval)" } else if s.enabled { "" } else { " (off)" })).collect();
            println!("  {:8} writable={} toggle={} {:?} {}", sc.id, sc.writable, sc.can_toggle, list, sc.note);
        }
    }
}
