//! Hive Agent engine tests: a scripted model (rig-core's mock), the real
//! rig-tools in a throwaway folder, and a sink that records what the UI
//! would get.

use super::*;
use rig_core::test_utils::{MockCompletionModel, MockStreamEvent as E};
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Debug, Clone)]
enum Ev {
    Line(&'static str, Value),
    Raw(&'static str, String),
    Approval(ApprovalRequest),
    Status(Status),
}

struct TestSink {
    tx: mpsc::UnboundedSender<Ev>,
}

impl Sink for TestSink {
    fn line(&self, _id: u32, stream: &'static str, text: String) {
        let ev = match serde_json::from_str::<Value>(&text) {
            Ok(v) if v.is_object() => Ev::Line(stream, v),
            _ => Ev::Raw(stream, text),
        };
        let _ = self.tx.send(ev);
    }
    fn delta(&self, _id: u32, _text: &str) {}
    fn approval(&self, req: &ApprovalRequest) {
        let _ = self.tx.send(Ev::Approval(req.clone()));
    }
    fn status(&self, info: &AgentInfo) {
        let _ = self.tx.send(Ev::Status(info.status));
    }
}

struct Tmp(PathBuf);
impl Tmp {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("hive-agent-test-{tag}-{}-{}", std::process::id(), new_conversation_id()));
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p.canonicalize().unwrap())
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn config(dir: &Path, approval: &str, conversation: &str) -> SessionConfig {
    SessionConfig {
        name: "Hive Agent — test".into(),
        provider: "ollama".into(),
        model: "mock".into(),
        cwd: dir.to_path_buf(),
        approval: approval.into(),
        allow_rules: vec![],
        preamble: build_preamble(dir, approval, true, ""),
        conversation: conversation.into(),
        history_path: Some(dir.join(".hive-history").join(format!("{conversation}.json"))),
        tools: true,
        path_env: None,
        mcp: Default::default(),
    }
}

struct Harness {
    hive: HiveAgents,
    rx: mpsc::UnboundedReceiver<Ev>,
    id: u32,
}

impl Harness {
    fn start(cfg: SessionConfig, model: MockCompletionModel) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let hive = HiveAgents::default();
        let sink = TestSink { tx };
        let started = hive.start(7, cfg, model.into(), Arc::new(TestSink { tx: sink.tx.clone() }));
        // What the UI does with the reply: the session is running, its first lines show.
        sink.status(&started.info);
        for (stream, text) in started.lines {
            sink.line(7, stream, text);
        }
        Harness { hive, rx, id: 7 }
    }

    fn send(&self, text: &str) {
        let fut = self.hive.send(self.id, text.into()).expect("send");
        tokio::spawn(fut);
    }

    async fn next(&mut self) -> Ev {
        tokio::time::timeout(Duration::from_secs(20), self.rx.recv()).await.expect("timed out waiting for an event").expect("sink closed")
    }

    /// Events up to and including the next `result` (approvals answered by `decide`).
    async fn until_result(&mut self, mut decide: impl FnMut(&ApprovalRequest) -> Option<&'static str>) -> Vec<Ev> {
        let mut out = vec![];
        loop {
            let ev = self.next().await;
            if let Ev::Approval(req) = &ev {
                if let Some(d) = decide(req) {
                    let rule = Some(req.ask.rule.clone());
                    self.hive.approve(self.id, req.request, d, rule).unwrap();
                }
            }
            let done = matches!(&ev, Ev::Line("stdout", v) if v["type"] == "result");
            out.push(ev);
            if done {
                return out;
            }
        }
    }
}

fn lines_of(evs: &[Ev], ty: &str) -> Vec<Value> {
    evs.iter()
        .filter_map(|e| match e {
            Ev::Line("stdout", v) if v["type"] == ty => Some(v.clone()),
            _ => None,
        })
        .collect()
}

fn result_of(evs: &[Ev]) -> Value {
    lines_of(evs, "result").pop().expect("a result event")
}

fn tool_results(evs: &[Ev]) -> Vec<Value> {
    lines_of(evs, "user").into_iter().map(|v| v["message"]["content"][0].clone()).collect()
}

/// Scripted streaming turns: text, a tool call, a provider failure.
fn say(text: &str) -> Vec<E> {
    vec![E::text(text), E::final_response_with_default_usage()]
}
fn call(id: &str, name: &str, args: Value) -> Vec<E> {
    vec![E::tool_call(id, name, args), E::final_response_with_default_usage()]
}
fn fail(msg: &str) -> Vec<E> {
    vec![E::error(msg)]
}
fn script(turns: Vec<Vec<E>>) -> MockCompletionModel {
    MockCompletionModel::from_stream_turns(turns)
}
fn script_model(turns: Vec<Vec<E>>) -> MockCompletionModel {
    script(turns)
}

// ---------- policy ----------

#[test]
fn approval_levels() {
    let rules: Vec<String> = vec![];
    let write = json!({ "path": "a.txt", "content": "x" });
    let shell = json!({ "command": "npm test" });
    for level in ["ask", "edits", "plan", "full"] {
        assert_eq!(classify(level, "read", &json!({ "path": "a" }), &rules), Gate::Allow, "{level} read");
        assert_eq!(classify(level, "search", &json!({ "pattern": "x" }), &rules), Gate::Allow);
    }
    assert!(matches!(classify("ask", "write", &write, &rules), Gate::Ask(_)));
    assert!(matches!(classify("ask", "shell", &shell, &rules), Gate::Ask(_)));
    assert_eq!(classify("edits", "write", &write, &rules), Gate::Allow);
    assert_eq!(classify("edits", "edit", &json!({ "path": "a", "edits": [] }), &rules), Gate::Allow);
    assert!(matches!(classify("edits", "shell", &shell, &rules), Gate::Ask(_)));
    assert!(matches!(classify("plan", "write", &write, &rules), Gate::Deny(_)));
    assert!(matches!(classify("plan", "shell", &shell, &rules), Gate::Deny(_)));
    assert_eq!(classify("full", "shell", &shell, &rules), Gate::Allow);
    assert_eq!(classify("full", "write", &write, &rules), Gate::Allow);
}

#[test]
fn ask_labels_and_rules() {
    let Gate::Ask(a) = classify("ask", "shell", &json!({ "command": " cargo test " }), &[]) else { panic!() };
    assert_eq!((a.label.as_str(), a.rule.as_str(), a.broad), ("$ cargo test", "shell(cargo test)", false));
    let edit = json!({ "path": "src/x.rs", "edits": [{ "old_text": "a\nb", "new_text": "c" }] });
    let Gate::Ask(a) = classify("ask", "edit", &edit, &[]) else { panic!() };
    assert_eq!((a.label.as_str(), a.rule.as_str(), a.broad), ("Edit src/x.rs", "edit", true));
    assert_eq!(a.detail, "- a\n- b\n+ c");
    // "Always in this folder" rules
    assert_eq!(classify("ask", "edit", &edit, &["edit".into()]), Gate::Allow);
    assert_eq!(classify("ask", "shell", &json!({ "command": "cargo test" }), &["shell(cargo test)".into()]), Gate::Allow);
    assert!(matches!(classify("ask", "shell", &json!({ "command": "rm -rf x" }), &["shell(cargo test)".into()]), Gate::Ask(_)));
}

#[test]
fn provider_prefix() {
    assert_eq!(split_provider("ollama", "anthropic/claude-sonnet-5-5"), ("anthropic", "claude-sonnet-5-5"));
    assert_eq!(split_provider("anthropic", "ollama/qwen3:8b"), ("ollama", "qwen3:8b"));
    assert_eq!(split_provider("ollama", "qwen3:8b"), ("ollama", "qwen3:8b"));
    assert_eq!(split_provider("", "x"), ("ollama", "x"));
}

#[test]
fn events_start_with_their_type() {
    // The UI finds the session id with a pattern anchored at the line's start
    // (registry::INIT_SESSION_PATTERN), like Claude Code's own init line.
    let line = event(json!({ "session_id": "0123abcd-ef", "subtype": "init", "type": "system", "cwd": "/x" }));
    assert!(line.starts_with(r#"{"type":"system","subtype":"init","#), "{line}");
    assert!(line.contains(r#""session_id":"0123abcd-ef""#));
    let v: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["cwd"], "/x");
    assert!(event(json!({ "usage": {}, "type": "result" })).starts_with(r#"{"type":"result","#));
}

#[test]
fn conversation_ids_match_the_ui_pattern() {
    let id = new_conversation_id();
    assert!(valid_conversation_id(&id), "{id}");
    assert_ne!(id, new_conversation_id());
    assert!(!valid_conversation_id("../../etc/passwd"));
}

#[test]
fn missing_anthropic_key_is_explained() {
    let err = make_model("anthropic", "claude-sonnet-5-5", "", None).err().unwrap();
    assert!(err.contains("Settings"), "{err}");
}

// ---------- the loop ----------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn text_turn_and_continuity() {
    let dir = Tmp::new("text");
    let conv = new_conversation_id();
    let mut h = Harness::start(config(&dir.0, "edits", &conv), script(vec![say("Hello from the mock.")]));
    // init first: the UI takes the session id from it
    assert!(matches!(h.next().await, Ev::Status(Status::Running)));
    let Ev::Line("stdout", init) = h.next().await else { panic!("init") };
    assert_eq!((init["type"].as_str(), init["subtype"].as_str()), (Some("system"), Some("init")));
    assert_eq!(init["session_id"], conv);

    h.send("hi");
    let evs = h.until_result(|_| None).await;
    let said = lines_of(&evs, "assistant");
    assert_eq!(said.len(), 1, "{evs:?}");
    assert_eq!(said[0]["message"]["content"][0]["type"], "text");
    assert_eq!(said[0]["message"]["content"][0]["text"], "Hello from the mock.");
    let r = result_of(&evs);
    assert_eq!(r["is_error"], false);
    assert_eq!(r["subtype"], "success");
    assert_eq!(r["session_id"], conv);

    // Saved: a new session on the same conversation sends the earlier turn.
    let sess = h.hive.get(h.id).unwrap();
    assert_eq!(sess.history_len(), 2);
    assert!(!sess.busy());
    assert_eq!(sess.conversation(), conv);
    assert!(dir.0.join(".hive-history").join(format!("{conv}.json")).is_file());
    let model = script(vec![say("Again.")]);
    let mut h2 = Harness::start(config(&dir.0, "edits", &conv), model.clone());
    assert_eq!(h2.hive.get(h2.id).unwrap().history_len(), 2);
    h2.send("and now?");
    h2.until_result(|_| None).await;
    let req = model.requests().pop().unwrap();
    let roles: Vec<String> = req.chat_history.iter().map(|m| format!("{m:?}").chars().take(60).collect()).collect();
    assert_eq!(req.chat_history.len(), 4, "system prompt, two earlier messages and the prompt: {roles:#?}");
    assert!(roles[0].starts_with("System"));
    assert_eq!(h2.hive.get(h2.id).unwrap().history_len(), 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn approval_pauses_and_allows() {
    let dir = Tmp::new("allow");
    let model = script(vec![
        call("call_1", "write", json!({ "path": "notes.txt", "content": "approved\n" })),
        say("Wrote notes.txt."),
    ]);
    let mut h = Harness::start(config(&dir.0, "ask", &new_conversation_id()), model);
    h.send("write a note");
    let mut asked = None;
    let evs = h
        .until_result(|req| {
            // Paused: nothing written before the decision.
            assert!(!dir.0.join("notes.txt").exists());
            asked = Some(req.clone());
            Some("once")
        })
        .await;
    let req = asked.expect("an approval request");
    assert_eq!(req.tool, "write");
    assert_eq!(req.ask.label, "Write notes.txt");
    assert_eq!(req.ask.detail, "approved\n");
    assert_eq!(std::fs::read_to_string(dir.0.join("notes.txt")).unwrap(), "approved\n");

    // tool_use comes before its approval card and its result after it
    let pos = |f: &dyn Fn(&Ev) -> bool| evs.iter().position(f).unwrap();
    let use_at = pos(&|e| matches!(e, Ev::Line("stdout", v) if v["message"]["content"][0]["type"] == "tool_use"));
    let ask_at = pos(&|e| matches!(e, Ev::Approval(_)));
    let res_at = pos(&|e| matches!(e, Ev::Line("stdout", v) if v["type"] == "user"));
    assert!(use_at < ask_at && ask_at < res_at, "{evs:?}");
    let tu = &lines_of(&evs, "assistant")[0]["message"]["content"][0];
    assert_eq!((tu["name"].as_str(), tu["input"]["path"].as_str()), (Some("write"), Some("notes.txt")));
    let tr = &tool_results(&evs)[0];
    assert_eq!(tr["type"], "tool_result");
    assert_eq!(tr["tool_use_id"], tu["id"]);
    assert_eq!(tr["is_error"], false);
    assert_eq!(result_of(&evs)["is_error"], false);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn approval_denied() {
    let dir = Tmp::new("deny");
    let model = script(vec![
        call("call_1", "shell", json!({ "command": "touch made-by-shell" })),
        say("Okay, I won't."),
    ]);
    let mut h = Harness::start(config(&dir.0, "edits", &new_conversation_id()), model.clone());
    h.send("touch a file");
    let evs = h.until_result(|req| {
        assert_eq!(req.ask.label, "$ touch made-by-shell");
        Some("deny")
    }).await;
    assert!(!dir.0.join("made-by-shell").exists());
    let tr = &tool_results(&evs)[0];
    assert_eq!(tr["is_error"], true);
    // The model was told why.
    let sent = format!("{:?}", model.requests().last().unwrap().chat_history);
    assert!(sent.contains("denied"), "{sent}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn always_allows_the_rest_of_the_session() {
    let dir = Tmp::new("always");
    let model = script(vec![
        call("c1", "shell", json!({ "command": "echo one > one.txt" })),
        call("c2", "shell", json!({ "command": "echo one > one.txt" })),
        say("done"),
    ]);
    let mut h = Harness::start(config(&dir.0, "ask", &new_conversation_id()), model);
    h.send("go");
    let mut asked = 0;
    let evs = h.until_result(|_| { asked += 1; Some("always") }).await;
    assert_eq!(asked, 1, "the second identical command needed no approval");
    let results = tool_results(&evs);
    assert_eq!(results.len(), 2);
    assert!(results.iter().all(|r| r["is_error"] == false), "{results:?}");
    assert_eq!(std::fs::read_to_string(dir.0.join("one.txt")).unwrap().trim(), "one");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plan_mode_refuses_without_asking() {
    let dir = Tmp::new("plan");
    let model = script(vec![
        call("c1", "write", json!({ "path": "x.txt", "content": "no" })),
        say("I'd write x.txt."),
    ]);
    let mut h = Harness::start(config(&dir.0, "plan", &new_conversation_id()), model);
    h.send("write x");
    let evs = h.until_result(|req| panic!("plan mode asked: {req:?}")).await;
    assert!(!dir.0.join("x.txt").exists());
    let tr = &tool_results(&evs)[0];
    assert_eq!(tr["is_error"], true);
    assert!(tr["content"].as_str().unwrap().contains("plan mode"), "{tr}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_and_edit_a_file() {
    let dir = Tmp::new("edit");
    std::fs::write(dir.0.join("greet.txt"), "hello world\n").unwrap();
    let model = script(vec![
        call("c1", "read", json!({ "path": "greet.txt" })),
        call("c2", "edit", json!({ "path": "greet.txt", "edits": [{ "old_text": "world", "new_text": "Hive" }] })),
        say("Changed it."),
    ]);
    let mut h = Harness::start(config(&dir.0, "ask", &new_conversation_id()), model);
    h.send("greet Hive");
    let mut asked = vec![];
    let evs = h.until_result(|req| { asked.push(req.tool.clone()); Some("once") }).await;
    assert_eq!(asked, ["edit"], "reading needs no approval");
    let results = tool_results(&evs);
    assert!(results[0]["content"].as_str().unwrap().contains("hello world"), "{results:?}");
    assert_eq!(std::fs::read_to_string(dir.0.join("greet.txt")).unwrap(), "hello Hive\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_while_waiting_for_approval() {
    let dir = Tmp::new("stop");
    let model = script(vec![
        call("c1", "write", json!({ "path": "never.txt", "content": "x" })),
        say("unreachable"),
    ]);
    let mut h = Harness::start(config(&dir.0, "ask", &new_conversation_id()), model);
    h.send("write");
    let mut evs = vec![];
    loop {
        let ev = h.next().await;
        let ask = matches!(ev, Ev::Approval(_));
        evs.push(ev);
        if ask {
            break;
        }
    }
    assert!(h.hive.get(h.id).unwrap().busy());
    h.hive.cancel(h.id);
    evs.extend(h.until_result(|_| None).await);
    let r = result_of(&evs);
    assert_eq!((r["subtype"].as_str(), r["stopped"].as_bool()), (Some("interrupted"), Some(true)));
    assert!(!dir.0.join("never.txt").exists());
    let sess = h.hive.get(h.id).unwrap();
    assert!(!sess.busy());
    // The stopped prompt stays in the conversation, with a note.
    assert_eq!(sess.history_len(), 2);
    // The request is gone; a late click is refused.
    let Some(Ev::Approval(req)) = evs.iter().find(|e| matches!(e, Ev::Approval(_))).cloned() else { panic!() };
    assert!(h.hive.approve(h.id, req.request, "once", None).is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_prompt_at_a_time_and_close() {
    let dir = Tmp::new("busy");
    let model = script(vec![
        call("c1", "shell", json!({ "command": "true" })),
        say("ok"),
    ]);
    let mut h = Harness::start(config(&dir.0, "ask", &new_conversation_id()), model);
    h.send("first");
    loop {
        if matches!(h.next().await, Ev::Approval(_)) {
            break;
        }
    }
    assert!(h.hive.send(h.id, "second".into()).is_err());
    h.hive.close(h.id);
    let evs = h.until_result(|_| None).await;
    assert!(evs.iter().any(|e| matches!(e, Ev::Status(Status::Stopped))) || matches!(h.next().await, Ev::Status(Status::Stopped)));
    assert!(h.hive.get(h.id).is_none());
    assert!(h.hive.send(h.id, "third".into()).is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn model_errors_end_the_turn() {
    let dir = Tmp::new("err");
    let model = script(vec![fail("boom")]);
    let mut h = Harness::start(config(&dir.0, "edits", &new_conversation_id()), model);
    h.send("hi");
    let evs = h.until_result(|_| None).await;
    assert_eq!(result_of(&evs)["is_error"], true);
    assert!(evs.iter().any(|e| matches!(e, Ev::Raw("stderr", t) if t.contains("boom"))), "{evs:?}");
    assert!(!h.hive.get(h.id).unwrap().busy());
}

#[test]
fn preamble_mentions_folder_level_and_skills() {
    let dir = Tmp::new("pre");
    std::fs::write(dir.0.join("AGENTS.md"), "Use tabs.").unwrap();
    let p = build_preamble(&dir.0, "plan", true, "<skills>\n- x: y (/s/SKILL.md)\n</skills>");
    assert!(p.contains(&dir.0.display().to_string()));
    assert!(p.contains("plan — read-only"));
    assert!(p.contains("Use tabs."));
    assert!(p.contains("/s/SKILL.md"));
    let p = build_preamble(&dir.0, "edits", false, "<skills>x</skills>");
    assert!(p.contains("can't call tools"));
    assert!(!p.contains("<skills>"));
}

// ---------- real Ollama (opt-in) ----------

/// The Tauri events a session sends, as the webview receives them.
struct RecordingSink {
    inner: TestSink,
    log: Arc<Mutex<Vec<Value>>>,
}

impl Sink for RecordingSink {
    fn line(&self, id: u32, stream: &'static str, text: String) {
        self.log.lock().unwrap().push(json!({ "event": "agent:output", "payload": { "id": id, "stream": stream, "text": text, "ts": now_ms() } }));
        self.inner.line(id, stream, text);
    }
    fn delta(&self, id: u32, text: &str) {
        self.log.lock().unwrap().push(json!({ "event": "hive:delta", "payload": { "id": id, "text": text } }));
    }
    fn approval(&self, req: &ApprovalRequest) {
        self.log.lock().unwrap().push(json!({ "event": "hive:approval", "payload": req }));
        self.inner.approval(req);
    }
    fn status(&self, info: &AgentInfo) {
        self.log.lock().unwrap().push(json!({ "event": "agent:status", "payload": info }));
        self.inner.status(info);
    }
}

/// A real model reads a file, proposes an edit, waits for approval, and the
/// edit lands. `HIVE_TEST_OLLAMA_MODEL` (default gemma4:latest);
/// `HIVE_TEST_RECORD=<file>` saves the events for a UI replay.
///
/// `cargo test real_ollama -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn real_ollama_reads_and_edits_after_approval() {
    let model_name = std::env::var("HIVE_TEST_OLLAMA_MODEL").unwrap_or_else(|_| "gemma4:latest".into());
    assert_eq!(ollama_supports_tools(DEFAULT_OLLAMA_URL, &model_name), Some(true), "{model_name} should list tools");
    let dir = Tmp::new("ollama");
    std::fs::write(dir.0.join("greet.txt"), "hello world\nhave a nice day\n").unwrap();
    let mut cfg = config(&dir.0, "ask", &new_conversation_id());
    cfg.model = model_name.clone();
    let model = make_model("ollama", &model_name, DEFAULT_OLLAMA_URL, None).unwrap();
    let (tx, rx) = mpsc::unbounded_channel();
    let log = Arc::new(Mutex::new(vec![]));
    let hive = HiveAgents::default();
    let started = hive.start(7, cfg, model, Arc::new(RecordingSink { inner: TestSink { tx }, log: log.clone() }));
    assert_eq!(started.lines.len(), 1);
    let mut h = Harness { hive, rx, id: 7 };
    h.send("Read greet.txt, then use the edit tool to replace the word \"world\" with \"Hive\" in it. Don't run any commands.");
    let mut asked = vec![];
    let evs = tokio::time::timeout(Duration::from_secs(900), async {
        let mut out = vec![];
        loop {
            let ev = h.rx.recv().await.expect("sink closed");
            println!("{ev:?}");
            if let Ev::Approval(req) = &ev {
                asked.push(req.clone());
                assert!(std::fs::read_to_string(dir.0.join("greet.txt")).unwrap().contains("world"), "edited before approval");
                h.hive.approve(h.id, req.request, "once", None).unwrap();
            }
            let done = matches!(&ev, Ev::Line("stdout", v) if v["type"] == "result");
            out.push(ev);
            if done {
                return out;
            }
        }
    })
    .await
    .expect("the model took more than 15 minutes");
    if let Ok(path) = std::env::var("HIVE_TEST_RECORD") {
        std::fs::write(&path, serde_json::to_string_pretty(&*log.lock().unwrap()).unwrap()).unwrap();
        println!("recorded {} events to {path}", log.lock().unwrap().len());
    }
    assert_eq!(result_of(&evs)["is_error"], false, "{evs:?}");
    let used: Vec<String> = lines_of(&evs, "assistant")
        .iter()
        .filter_map(|v| v["message"]["content"][0]["name"].as_str().map(String::from))
        .collect();
    println!("tools used: {used:?}; approvals: {:?}", asked.iter().map(|a| &a.ask.label).collect::<Vec<_>>());
    assert!(used.iter().any(|t| t == "read"), "{used:?}");
    assert!(asked.iter().any(|a| a.tool == "edit" || a.tool == "write"), "no approval asked: {asked:?}");
    assert_eq!(std::fs::read_to_string(dir.0.join("greet.txt")).unwrap(), "hello Hive\nhave a nice day\n");
}

#[test]
fn start_sends_nothing_before_it_returns() {
    // The UI maps a session's id only once hive_agent_start returns; lines
    // sent before that would be dropped (the init line carries the
    // conversation id the tab keeps).
    let dir = Tmp::new("quiet");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let conv = new_conversation_id();
    let started = HiveAgents::default().start(3, config(&dir.0, "ask", &conv), script(vec![]).into(), Arc::new(TestSink { tx }));
    assert!(rx.try_recv().is_err(), "start emitted before returning");
    assert_eq!(started.conversation, conv);
    assert!(started.lines[0].1.starts_with(r#"{"type":"system","subtype":"init""#));
    assert_eq!(started.info.status, Status::Running);
}

/// What reaches the server: an API key as `x-api-key`, an auth token as
/// `Authorization: Bearer`, at the address that came with it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn anthropic_credentials_on_the_wire() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn capture(cred: keys::Credential) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 65536];
            let mut got = Vec::new();
            loop {
                let n = sock.read(&mut buf).await.unwrap();
                got.extend_from_slice(&buf[..n]);
                if n == 0 || got.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let body = r#"{"type":"error","error":{"type":"authentication_error","message":"test"}}"#;
            let resp = format!("HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            let _ = sock.write_all(resp.as_bytes()).await;
            String::from_utf8_lossy(&got).to_lowercase()
        });
        let model = make_model("anthropic", "claude-sonnet-5-5", &format!("http://{addr}"), Some(cred)).unwrap();
        let agent = AgentBuilder::new(model).max_tokens(16).build();
        assert!(agent.prompt("hi").await.is_err(), "the fake server refuses");
        server.await.unwrap()
    }
    let key = capture(keys::Credential { secret: "sk-test-key".into(), bearer: false, base_url: None, source: "t".into() }).await;
    assert!(key.starts_with("post /v1/messages"), "{key}");
    assert!(key.contains("x-api-key: sk-test-key"), "{key}");
    assert!(!key.contains("authorization:"), "{key}");
    let token = capture(keys::Credential { secret: "tok-test".into(), bearer: true, base_url: None, source: "t".into() }).await;
    assert!(token.contains("authorization: bearer tok-test"), "{token}");
    assert!(!token.contains("x-api-key"), "{token}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_terminal_output_goes_with_the_next_prompt() {
    let dir = Tmp::new("notes");
    let conv = new_conversation_id();
    let note = "I ran this in my terminal:\n<terminal>\n$ git status\nnothing to commit\n</terminal>";
    // Shared, then Hive restarts before the next prompt: the note is kept.
    {
        let h = Harness::start(config(&dir.0, "edits", &conv), script(vec![]));
        h.hive.note(h.id, note.into()).unwrap();
        h.hive.note(h.id, "   ".into()).unwrap(); // blank: ignored
    }
    let model = script(vec![say("Clean tree."), say("Still clean.")]);
    let mut h = Harness::start(config(&dir.0, "edits", &conv), model.clone());
    h.send("is my tree clean?");
    h.until_result(|_| None).await;
    let sent = format!("{:?}", model.requests()[0].chat_history.last().unwrap());
    assert!(sent.contains("nothing to commit") && sent.contains("is my tree clean?"), "{sent}");
    assert!(sent.find("nothing to commit") < sent.find("is my tree clean?"), "note first: {sent}");
    // Used once: kept in the conversation, not sent again on its own.
    h.send("and now?");
    h.until_result(|_| None).await;
    let second = &model.requests()[1].chat_history;
    let all = format!("{second:?}");
    assert_eq!(all.matches("nothing to commit").count(), 1, "{all}");
    assert!(!format!("{:?}", second.last().unwrap()).contains("nothing to commit"));
    let saved = std::fs::read_to_string(dir.0.join(".hive-history").join(format!("{conv}.json"))).unwrap();
    let saved: Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(saved["notes"], json!([]));
}

/// A minimal MCP server over stdio (JSON-RPC lines): `echo` is read-only,
/// `note` is not.
const MCP_SERVER_PY: &str = r#"
import json, sys
for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg:
        continue
    m, r = msg["method"], None
    if m == "initialize":
        r = {"protocolVersion": msg["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "test", "version": "1"}}
    elif m == "tools/list":
        schema = {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}
        r = {"tools": [
            {"name": "echo", "description": "Echo text", "inputSchema": schema, "annotations": {"readOnlyHint": True}},
            {"name": "note", "description": "Save a note", "inputSchema": schema, "annotations": {"readOnlyHint": False}},
        ]}
    elif m == "tools/call":
        r = {"content": [{"type": "text", "text": msg["params"]["name"] + ": " + msg["params"]["arguments"]["text"]}]}
    if r is None:
        out = {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "no " + m}}
    else:
        out = {"jsonrpc": "2.0", "id": msg["id"], "result": r}
    sys.stdout.write(json.dumps(out) + "\n"); sys.stdout.flush()
"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_tools_run_through_the_approval_gate() {
    if std::process::Command::new("python3").arg("-V").output().is_err() {
        eprintln!("python3 not found; skipped");
        return;
    }
    let dir = Tmp::new("mcp");
    let script = dir.0.join("server.py");
    std::fs::write(&script, MCP_SERVER_PY).unwrap();
    let server = crate::mcp::McpServer {
        name: "test".into(),
        transport: "stdio".into(),
        command: "python3".into(),
        args: vec![script.display().to_string()],
        enabled: true,
        ..Default::default()
    };
    let broken = crate::mcp::McpServer { name: "broken".into(), transport: "stdio".into(), command: "/nonexistent/mcp".into(), enabled: true, ..Default::default() };
    let setup = crate::mcp::connect_all(&[server, broken], &dir.0, None).await;
    assert_eq!(setup.connected, ["test (2 tools)"], "{setup:?}");
    assert!(setup.failed[0].starts_with("broken:"), "{setup:?}");
    assert!(setup.read_only.contains("mcp__test__echo") && !setup.read_only.contains("mcp__test__note"));

    let model = script_model(vec![
        call("c1", "mcp__test__echo", json!({ "text": "hi" })),
        call("c2", "mcp__test__note", json!({ "text": "remember" })),
        say("done"),
    ]);
    let mut cfg = config(&dir.0, "ask", &new_conversation_id());
    cfg.mcp = setup;
    let mut h = Harness::start(cfg, model.clone());
    h.send("use the tools");
    let mut asked = vec![];
    let evs = h.until_result(|req| { asked.push(req.ask.label.clone()); Some("once") }).await;
    assert_eq!(asked, ["test › note"], "the read-only tool needed no approval");
    let results: Vec<String> = tool_results(&evs).iter().map(|r| r["content"].as_str().unwrap().to_string()).collect();
    assert_eq!(results, ["echo: hi", "note: remember"], "{evs:?}");
    // The model saw the server's tools under their namespaced names.
    let offered: Vec<String> = model.requests()[0].tools.iter().map(|t| t.name.to_string()).collect();
    assert!(offered.contains(&"mcp__test__echo".to_string()) && offered.contains(&"read".to_string()), "{offered:?}");
}
