use super::*;
use std::sync::Mutex;

struct Tmp(PathBuf);
impl Tmp {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("hive-mcp-{tag}-{}", std::process::id()));
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

#[derive(Default)]
struct FakeClaude(Mutex<Vec<(PathBuf, Vec<String>)>>);
impl ClaudeCli for FakeClaude {
    fn run(&self, cwd: &Path, args: &[String]) -> Result<(), String> {
        self.0.lock().unwrap().push((cwd.to_path_buf(), args.to_vec()));
        Ok(())
    }
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

fn ctx<'a>(t: &'a Tmp, home: &'a Path, proj: &'a Path, cfg: &'a Path, agent: &'a str, claude: &'a dyn ClaudeCli) -> Ctx<'a> {
    let _ = t;
    Ctx { agent, cwd: proj, home, config_dir: Some(cfg), claude }
}

#[test]
fn json_agents_round_trip_and_keep_the_rest_of_the_file() {
    let t = Tmp::new("json");
    let (home, proj, cfg) = (t.home(), t.proj(), t.cfg());
    let fake = FakeClaude::default();
    std::fs::create_dir_all(home.join(".gemini")).unwrap();
    // A settings file with other keys in a particular order.
    std::fs::write(home.join(".gemini/settings.json"), r#"{"theme":"dark","mcpServers":{"old":{"command":"x"}},"zzz":1}"#).unwrap();
    for agent in ["hive", "gemini", "qwen", "cursor-agent", "opencode", "copilot"] {
        let c = ctx(&t, &home, &proj, &cfg, agent, &fake);
        let scope = if agent == "hive" { "hive" } else { "user" };
        add(&c, scope, stdio("files")).unwrap();
        add(&c, scope, http("remote")).unwrap();
        assert!(add(&c, scope, stdio("files")).unwrap_err().contains("already"), "{agent}");
        let r = report(agent, &proj, &home, Some(&cfg), false);
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
        assert!(!names(&report(agent, &proj, &home, Some(&cfg), false), scope).contains(&"files".to_string()), "{agent}");
    }
    // The Gemini file kept its other keys, in order, and a backup.
    let text = std::fs::read_to_string(home.join(".gemini/settings.json")).unwrap();
    let theme = text.find("\"theme\"").unwrap();
    let servers = text.find("\"mcpServers\"").unwrap();
    let zzz = text.find("\"zzz\"").unwrap();
    assert!(theme < servers && servers < zzz, "{text}");
    assert!(text.contains("\"httpUrl\""), "Gemini's streamable HTTP key: {text}");
    assert!(home.join(".gemini/settings.json.hive-backup").exists());
    // opencode's own shape.
    let oc = std::fs::read_to_string(home.join(".config/opencode/opencode.json")).unwrap();
    assert!(oc.contains("\"type\": \"remote\"") && oc.contains("\"mcp\""), "{oc}");
}

#[test]
fn hive_list_toggles_and_lists_enabled_servers() {
    let t = Tmp::new("hive");
    let (home, proj, cfg) = (t.home(), t.proj(), t.cfg());
    let fake = FakeClaude::default();
    let c = ctx(&t, &home, &proj, &cfg, "hive", &fake);
    add(&c, "hive", stdio("a")).unwrap();
    add(&c, "hive", http("b")).unwrap();
    set_enabled(&c, "hive", "a", false).unwrap();
    let on: Vec<String> = hive_servers(Some(&cfg)).into_iter().map(|s| s.name).collect();
    assert_eq!(on, ["b"]);
    let r = report("hive", &proj, &home, Some(&cfg), false);
    let a = &r.scopes[0].servers.iter().find(|s| s.name == "a").unwrap();
    assert!(!a.enabled && r.scopes[0].can_toggle);
    assert!(set_enabled(&c, "hive", "gone", true).is_err());
}

#[test]
fn claude_code_changes_go_through_its_cli() {
    let t = Tmp::new("claude");
    let (home, proj, cfg) = (t.home(), t.proj(), t.cfg());
    // What Claude Code has: a user server, a local one for this folder, a project one.
    let key = proj.to_str().unwrap().to_string();
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
    let r = report("claude", &proj, &home, Some(&cfg), true);
    assert_eq!(names(&r, "user"), ["github"]);
    assert_eq!(names(&r, "local"), ["db"]);
    assert_eq!(names(&r, "project"), ["docs"]);
    assert!(r.scopes.iter().all(|s| s.writable));
    let before = std::fs::read_to_string(home.join(".claude.json")).unwrap();
    let fake = FakeClaude::default();
    let c = ctx(&t, &home, &proj, &cfg, "claude", &fake);
    add(&c, "local", stdio("files")).unwrap();
    remove(&c, "user", "github").unwrap();
    // ~/.claude.json was not touched by Hive.
    assert_eq!(std::fs::read_to_string(home.join(".claude.json")).unwrap(), before);
    let calls = fake.0.lock().unwrap();
    assert_eq!(calls[0].0, proj);
    assert_eq!(&calls[0].1[..5], ["mcp", "add-json", "--scope", "local", "files"]);
    let entry: Value = serde_json::from_str(&calls[0].1[5]).unwrap();
    assert_eq!(entry["type"], "stdio");
    assert_eq!(entry["command"], "npx");
    assert_eq!(calls[1].1, ["mcp", "remove", "--scope", "user", "github"]);
    // Without the claude command, Claude Code's scopes are read-only.
    assert!(report("claude", &proj, &home, Some(&cfg), false).scopes.iter().all(|s| !s.writable));
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
fn files_hive_cant_parse_are_left_alone() {
    let t = Tmp::new("jsonc");
    let (home, proj, cfg) = (t.home(), t.proj(), t.cfg());
    std::fs::create_dir_all(home.join(".cursor")).unwrap();
    let original = "{ // my servers\n \"mcpServers\": {} }";
    std::fs::write(home.join(".cursor/mcp.json"), original).unwrap();
    let r = report("cursor-agent", &proj, &home, Some(&cfg), false);
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
    let c = ctx(&t, &home, &proj, &cfg, "hive", &fake);
    add(&c, "hive", stdio("a")).unwrap();
    add(&c, "hive", http("b")).unwrap();
    let shown = serde_json::to_string(&report("hive", &proj, &home, Some(&cfg), false)).unwrap();
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
    let r = report("aider", Path::new("/"), Path::new("/"), None, false);
    assert!(!r.supported && r.note.contains("doesn't use MCP"));
}
