//! Factories: pipelines of agent nodes, described in YAML files in
//! `~/.paw/factories/<id>.yaml`, run by the background process.
//!
//! A factory's nodes form a graph through `needs`: nodes that don't need each
//! other run side by side, a node with several inputs waits for all of them
//! (`join: all`) or the first (`join: any`), and `when` makes a branch (the node
//! runs only if an earlier node's answer matches). A `wait` node holds the run
//! until a command succeeds. Each agent node runs Paw Agent with its own model,
//! skills, built-in tools and MCP servers.
//!
//! This file reads and checks factory files; `runner` (below) runs them.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub mod runner;
pub mod triggers;

/// The tools Paw Agent has built in; a node may name a subset.
pub const BUILTIN_TOOLS: &[&str] = &["read", "edit", "write", "search", "list", "shell"];
pub const MAX_NODES: usize = 40;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Factory {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// The folder the nodes work in (default: home).
    #[serde(default)]
    pub folder: String,
    /// The model nodes run on unless they name one ("provider/model").
    #[serde(default)]
    pub model: String,
    /// Approval level for nodes that change files (default: auto).
    #[serde(default)]
    pub approval: String,
    /// What starts a run besides Run now (schedule, watch, webhook, file).
    #[serde(default)]
    pub trigger: Option<Trigger>,
    /// Start again when a run finishes: `true`, or `{ after: 10s, on_failure: continue }`.
    #[serde(default)]
    pub repeat: Option<Repeat>,
    /// How many runs triggers and repeat may have going at once (default 1).
    /// Run now always starts one.
    #[serde(default)]
    pub parallel: Option<u32>,
    pub nodes: Vec<Node>,
}

pub const PARALLEL_MAX: u32 = 20;

impl Factory {
    /// Runs triggers may have going at once.
    pub fn parallel_runs(&self) -> usize {
        self.parallel.unwrap_or(1).clamp(1, PARALLEL_MAX) as usize
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Repeat {
    On(bool),
    With(RepeatOpts),
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RepeatOpts {
    /// Wait this long before the next run (at least 5s).
    #[serde(default)]
    pub after: Option<String>,
    /// stop (the default): a failed run ends the loop; continue: it goes on.
    #[serde(default)]
    pub on_failure: Option<String>,
}

pub const MIN_REPEAT: Duration = Duration::from_secs(5);

/// (how long to wait before the next run, go on after a failed run) when the factory repeats.
pub fn repeat_of(f: &Factory) -> Option<(Duration, bool)> {
    match f.repeat.as_ref()? {
        Repeat::On(false) => None,
        Repeat::On(true) => Some((MIN_REPEAT, false)),
        Repeat::With(o) => Some((
            o.after.as_deref().and_then(parse_duration).unwrap_or(MIN_REPEAT).max(MIN_REPEAT),
            o.on_failure.as_deref() == Some("continue"),
        )),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Trigger {
    /// Run every so often ("15m", "1h").
    #[serde(default)]
    pub every: Option<String>,
    /// Run at a time of day ("09:00").
    #[serde(default)]
    pub at: Option<String>,
    /// A command checked every `every`; the run starts when it succeeds.
    #[serde(default)]
    pub watch: Option<String>,
    /// change (default): a run when the watch starts succeeding; each: on every
    /// success (for a check that succeeds once per new event, like a new commit).
    #[serde(default)]
    pub fires: Option<String>,
    /// Start when something posts to the local webhook (true, or a secret).
    #[serde(default)]
    pub webhook: Option<serde_yaml::Value>,
    /// Start when a file or folder changes.
    #[serde(default)]
    pub file: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Join {
    #[default]
    All,
    Any,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct When {
    /// The node whose answer decides.
    pub from: String,
    /// Run when the answer matches this (a regular expression, case-insensitive).
    #[serde(default)]
    pub matches: Option<String>,
    /// Run when the answer doesn't match this.
    #[serde(default)]
    pub not_matches: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Node {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// What the node is for (shown beside the graph).
    #[serde(default)]
    pub description: String,
    /// The instructions the agent gets.
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub needs: Vec<String>,
    #[serde(default)]
    pub join: Join,
    #[serde(default)]
    pub when: Option<When>,
    #[serde(default)]
    pub model: String,
    /// false: the node only reads (Paw Agent's read-only level).
    #[serde(default = "yes")]
    pub edits: bool,
    #[serde(default)]
    pub approval: String,
    /// Skills the node may use (by name); unset: all of them.
    #[serde(default)]
    pub skills: Option<Vec<String>>,
    /// Built-in tools the node may use; unset: all of them.
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    /// MCP servers the node may use (by name); unset: all that are on.
    #[serde(default)]
    pub mcp: Option<Vec<String>>,
    /// A wait node: this command, run until it succeeds.
    #[serde(default)]
    pub wait: Option<String>,
    /// How often a wait node checks (default 30s).
    #[serde(default)]
    pub every: Option<String>,
    /// Give up after this long (wait nodes, and agent nodes' turns).
    #[serde(default)]
    pub timeout: Option<String>,
    /// Send the run back to an earlier node until this node's answer meets a
    /// condition, for at most `max` rounds.
    #[serde(default, rename = "loop")]
    pub repeat_until: Option<Loop>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Loop {
    /// The node the run goes back to (this one, or one it needs).
    pub back_to: String,
    /// The loop ends when this node's answer matches (or doesn't match) this.
    pub until: Until,
    /// At most this many rounds, the first one included (default 3).
    #[serde(default)]
    pub max: Option<u32>,
    /// When the last round still doesn't meet it: fail (default) or continue.
    #[serde(default)]
    pub on_max: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Until {
    #[serde(default)]
    pub matches: Option<String>,
    #[serde(default)]
    pub not_matches: Option<String>,
}

pub const LOOP_MAX: u32 = 20;

impl Loop {
    pub fn max_rounds(&self) -> u32 {
        self.max.unwrap_or(3).clamp(1, LOOP_MAX)
    }
    /// Does the answer end the loop?
    pub fn done(&self, answer: &str) -> bool {
        when_holds(&When { from: String::new(), matches: self.until.matches.clone(), not_matches: self.until.not_matches.clone() }, answer)
    }
}

/// The nodes a loop runs again: `back_to`, `node`, and every node on a path
/// between them (`back_to` .. `node`), in the factory's order.
pub fn loop_region(nodes: &[Node], back_to: &str, node: &str) -> Vec<String> {
    if back_to == node {
        return vec![node.to_string()];
    }
    let up = ancestors(nodes, node);
    let mut out = vec![];
    for n in nodes {
        let between = n.id == back_to || n.id == node || (up.contains(&n.id) && ancestors(nodes, &n.id).contains(back_to));
        if between {
            out.push(n.id.clone());
        }
    }
    out
}

fn yes() -> bool {
    true
}

impl Node {
    pub fn is_wait(&self) -> bool {
        self.wait.is_some()
    }
    pub fn label(&self) -> &str {
        if self.title.trim().is_empty() { &self.id } else { self.title.trim() }
    }
}

/// "30s", "2m", "1h", "1h30m", "90" (seconds).
pub fn parse_duration(s: &str) -> Option<Duration> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(n) = s.parse::<u64>() {
        return Some(Duration::from_secs(n));
    }
    let (mut total, mut num) = (0u64, String::new());
    for c in s.chars() {
        if c.is_ascii_digit() {
            num.push(c);
            continue;
        }
        let n: u64 = num.parse().ok()?;
        num.clear();
        total += n * match c {
            's' => 1,
            'm' => 60,
            'h' => 3600,
            'd' => 86_400,
            _ => return None,
        };
    }
    if !num.is_empty() {
        return None;
    }
    (total > 0).then(|| Duration::from_secs(total))
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn regex(pattern: &str) -> Result<regex::Regex, String> {
    regex::RegexBuilder::new(pattern).case_insensitive(true).build().map_err(|e| e.to_string())
}

/// Does `when` let its node run, given the answer of `when.from`?
pub fn when_holds(when: &When, answer: &str) -> bool {
    let yes = when.matches.as_deref().map_or(true, |p| regex(p).is_ok_and(|r| r.is_match(answer)));
    let no = when.not_matches.as_deref().is_some_and(|p| regex(p).is_ok_and(|r| r.is_match(answer)));
    yes && !no
}

/// Nodes in an order where each comes after what it needs (None: a circle).
pub fn topo_order(nodes: &[Node]) -> Option<Vec<usize>> {
    let index: HashMap<&str, usize> = nodes.iter().enumerate().map(|(i, n)| (n.id.as_str(), i)).collect();
    let mut state = vec![0u8; nodes.len()]; // 0 new, 1 visiting, 2 done
    let mut out = Vec::with_capacity(nodes.len());
    fn visit(i: usize, nodes: &[Node], index: &HashMap<&str, usize>, state: &mut [u8], out: &mut Vec<usize>) -> bool {
        match state[i] {
            1 => return false,
            2 => return true,
            _ => {}
        }
        state[i] = 1;
        for n in &nodes[i].needs {
            if let Some(&j) = index.get(n.as_str()) {
                if !visit(j, nodes, index, state, out) {
                    return false;
                }
            }
        }
        state[i] = 2;
        out.push(i);
        true
    }
    for i in 0..nodes.len() {
        if !visit(i, nodes, &index, &mut state, &mut out) {
            return None;
        }
    }
    Some(out)
}

/// Every node a node depends on, directly or not.
fn ancestors(nodes: &[Node], id: &str) -> HashSet<String> {
    let by_id: HashMap<&str, &Node> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut seen = HashSet::new();
    let mut todo: Vec<&str> = by_id.get(id).map(|n| n.needs.iter().map(String::as_str).collect()).unwrap_or_default();
    while let Some(x) = todo.pop() {
        if seen.insert(x.to_string()) {
            if let Some(n) = by_id.get(x) {
                todo.extend(n.needs.iter().map(String::as_str));
            }
        }
    }
    seen
}

/// Read and check a factory file's text. Errors say what to fix, with the node.
pub fn parse(text: &str) -> Result<Factory, String> {
    let f: Factory = serde_yaml::from_str(text).map_err(|e| {
        let msg = e.to_string();
        // The usual YAML slip: a value with ": " in it, unquoted.
        if msg.contains("mapping values are not allowed") {
            format!("{msg}. Text with “: ” in it needs quotes, or write it as a block (prompt: > and the text on the next lines, indented).")
        } else {
            msg
        }
    })?;
    check(&f)?;
    Ok(f)
}

pub fn check(f: &Factory) -> Result<(), String> {
    if f.name.trim().is_empty() {
        return Err("The factory needs a name.".into());
    }
    if f.parallel.is_some_and(|p| p == 0 || p > PARALLEL_MAX) {
        return Err(format!("parallel should be 1 to {PARALLEL_MAX} runs."));
    }
    if f.nodes.is_empty() {
        return Err("The factory has no nodes.".into());
    }
    if f.nodes.len() > MAX_NODES {
        return Err(format!("A factory can have up to {MAX_NODES} nodes."));
    }
    let mut ids = HashSet::new();
    for n in &f.nodes {
        if !valid_id(&n.id) {
            return Err(format!("Node id “{}”: use letters, digits, - and _ only.", n.id));
        }
        if !ids.insert(n.id.as_str()) {
            return Err(format!("Two nodes are called “{}”.", n.id));
        }
    }
    for n in &f.nodes {
        let at = |what: String| format!("Node “{}”: {what}", n.id);
        for need in &n.needs {
            if !ids.contains(need.as_str()) {
                return Err(at(format!("it needs “{need}”, which isn't a node.")));
            }
            if need == &n.id {
                return Err(at("it can't need itself.".into()));
            }
        }
        match (&n.wait, n.prompt.trim().is_empty()) {
            (Some(cmd), _) if cmd.trim().is_empty() => return Err(at("its wait command is empty.".into())),
            (None, true) => return Err(at("it needs a prompt (or a wait command).".into())),
            _ => {}
        }
        if n.join == Join::Any && n.needs.len() < 2 {
            return Err(at("join: any needs at least two nodes in needs.".into()));
        }
        if let Some(w) = &n.when {
            if !ids.contains(w.from.as_str()) {
                return Err(at(format!("its condition reads “{}”, which isn't a node.", w.from)));
            }
            if !n.needs.contains(&w.from) && !ancestors(&f.nodes, &n.id).contains(&w.from) {
                return Err(at(format!("its condition reads “{}”, so it has to need that node (directly or through another).", w.from)));
            }
            if w.matches.is_none() && w.not_matches.is_none() {
                return Err(at("its condition needs matches or not_matches.".into()));
            }
            for p in [&w.matches, &w.not_matches].into_iter().flatten() {
                regex(p).map_err(|e| at(format!("its condition “{p}” isn't a valid pattern ({e}).")))?;
            }
        }
        if let Some(l) = &n.repeat_until {
            if l.back_to != n.id && !ancestors(&f.nodes, &n.id).contains(&l.back_to) {
                return Err(at(format!("its loop goes back to “{}”, which has to be this node or one it needs (directly or not).", l.back_to)));
            }
            if l.until.matches.is_none() && l.until.not_matches.is_none() {
                return Err(at("its loop needs until: { matches: … } or { not_matches: … }.".into()));
            }
            for p in [&l.until.matches, &l.until.not_matches].into_iter().flatten() {
                regex(p).map_err(|e| at(format!("its loop's “{p}” isn't a valid pattern ({e}).")))?;
            }
            if l.max.is_some_and(|m| m == 0 || m > LOOP_MAX) {
                return Err(at(format!("its loop's max should be 1 to {LOOP_MAX} rounds.")));
            }
            if let Some(x) = &l.on_max {
                if x != "fail" && x != "continue" {
                    return Err(at(format!("its loop's on_max “{x}” should be fail or continue.")));
                }
            }
        }
        if let Some(tools) = &n.tools {
            if let Some(t) = tools.iter().find(|t| !BUILTIN_TOOLS.contains(&t.as_str())) {
                return Err(at(format!("there's no built-in tool “{t}” (use {}).", BUILTIN_TOOLS.join(", "))));
            }
        }
        for (what, v) in [("every", &n.every), ("timeout", &n.timeout)] {
            if let Some(v) = v {
                if parse_duration(v).is_none() {
                    return Err(at(format!("{what}: “{v}” isn't a duration (like 30s, 2m, 1h).")));
                }
            }
        }
        for a in [&n.approval, &f.approval] {
            if !a.is_empty() && !["ask", "edits", "auto", "plan", "full"].contains(&a.as_str()) {
                return Err(format!("Approval “{a}” isn't one of ask, edits, auto, plan or full."));
            }
        }
    }
    if topo_order(&f.nodes).is_none() {
        return Err("The nodes need each other in a circle.".into());
    }
    if let Some(Repeat::With(o)) = &f.repeat {
        if let Some(a) = &o.after {
            if parse_duration(a).is_none() {
                return Err(format!("repeat after: “{a}” isn't a duration (like 10s, 5m)."));
            }
        }
        if let Some(x) = &o.on_failure {
            if x != "stop" && x != "continue" {
                return Err(format!("repeat on_failure: “{x}” should be stop or continue."));
            }
        }
    }
    if let Some(t) = &f.trigger {
        if t.every.is_none() && t.at.is_none() && t.watch.is_none() && t.file.is_none() && webhook_secret(t).is_none() {
            return Err("The trigger is empty: give it every, at, watch, webhook or file (or remove it).".into());
        }
        if let Some(v) = &t.every {
            match parse_duration(v) {
                None => return Err(format!("Trigger every: “{v}” isn't a duration (like 15m, 1h).")),
                Some(d) if d < Duration::from_secs(5) => return Err("Trigger every: at least 5s.".into()),
                _ => {}
            }
        }
        if t.watch.as_deref().is_some_and(|w| w.trim().is_empty()) {
            return Err("The trigger's watch command is empty.".into());
        }
        if t.watch.is_some() && t.every.is_none() {
            return Err("A watch trigger also needs every: how often to check.".into());
        }
        if let Some(x) = &t.fires {
            if t.watch.is_none() {
                return Err("Trigger fires: goes with watch.".into());
            }
            if x != "each" && x != "change" {
                return Err(format!("Trigger fires: “{x}” should be each or change."));
            }
        }
        if let Some(at) = &t.at {
            if at_times(at).is_none() {
                return Err(format!("Trigger at: “{at}” should be times of day like 09:00, or \"09:00, 17:30\"."));
            }
        }
        if t.file.as_deref().is_some_and(|f| f.trim().is_empty()) {
            return Err("The trigger's file is empty.".into());
        }
        if let Some(w) = &t.webhook {
            if !matches!(w, serde_yaml::Value::Bool(_) | serde_yaml::Value::String(_)) {
                return Err("Trigger webhook: true, or a secret the caller must send (a string).".into());
            }
        }
    }
    Ok(())
}

/// "09:00, 17:30" → [(9, 0), (17, 30)].
pub fn at_times(s: &str) -> Option<Vec<(u32, u32)>> {
    let times: Option<Vec<(u32, u32)>> = s
        .split(',')
        .map(|t| {
            let (h, m) = t.trim().split_once(':')?;
            let (h, m): (u32, u32) = (h.trim().parse().ok()?, m.trim().parse().ok()?);
            (h < 24 && m < 60).then_some((h, m))
        })
        .collect();
    times.filter(|t| !t.is_empty())
}

/// A webhook trigger: None (off), Some("") (on, no secret) or Some(secret).
pub fn webhook_secret(t: &Trigger) -> Option<String> {
    match t.webhook.as_ref()? {
        serde_yaml::Value::Bool(true) => Some(String::new()),
        serde_yaml::Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => None,
    }
}

/// A factory file as found on disk: checked, or with what's wrong with it.
#[derive(Debug, Clone, Serialize)]
pub struct Found {
    pub id: String,
    pub path: PathBuf,
    pub factory: Option<Factory>,
    pub error: Option<String>,
    pub modified: u64,
}

pub fn dir(paw_home: &Path) -> PathBuf {
    paw_home.join("factories")
}

/// Every `*.yaml` / `*.yml` file in the factories folder, by file name.
pub fn load_all(dir: &Path) -> Vec<Found> {
    let mut out: Vec<Found> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let ext = path.extension()?.to_str()?;
            if ext != "yaml" && ext != "yml" {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_string();
            Some(load(&id, &path))
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub fn load(id: &str, path: &Path) -> Found {
    let modified = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    let (factory, error) = match std::fs::read_to_string(path).map_err(|e| e.to_string()).and_then(|t| parse(&t)) {
        Ok(f) => (Some(f), None),
        Err(e) => (None, Some(e)),
    };
    Found { id: id.to_string(), path: path.to_path_buf(), factory, error, modified }
}

/// A new factory file from the template; its id (the file name).
pub fn create(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the factory a name.".into());
    }
    let mut base: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    base = base.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    if base.is_empty() {
        base = "factory".into();
    }
    base.truncate(48);
    let d = crate::paths::home().map(|h| dir(&h)).ok_or("Paw can't find its folder (~/.paw).")?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let mut id = base.clone();
    for n in 2.. {
        if !d.join(format!("{id}.yaml")).exists() && !d.join(format!("{id}.yml")).exists() {
            break;
        }
        id = format!("{base}-{n}");
    }
    std::fs::write(d.join(format!("{id}.yaml")), template(&name.replace('"', "'"))).map_err(|e| e.to_string())?;
    Ok(id)
}

/// The file a new factory starts from.
pub fn template(name: &str) -> String {
    format!(
        r#"# A Paw factory: nodes that agents work through, in order or side by side.
# Docs: https://github.com/reevik/Paw/blob/main/docs/factories.md
name: {name}
description: What this factory does.
folder: ~
# model: anthropic/claude-sonnet-5-5   # the default for every node

nodes:
  - id: research
    title: Look into it
    description: Reads around and reports what it finds.
    prompt: Describe what this node should find out.
    edits: false

  - id: work
    title: Do the work
    needs: [research]
    prompt: Describe the change to make, using what research found.

  - id: review
    title: Review the change
    needs: [work]
    edits: false
    prompt: Check the change and list anything that's wrong.
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"
name: Error spike responder
folder: ~/proj
trigger:
  watch: "./check-errors.sh"
  every: 2m
nodes:
  - id: triage
    prompt: Classify the spike
    edits: false
    skills: [log-reading]
    mcp: [grafana]
  - id: hotfix
    needs: [triage]
    when: { from: triage, matches: "severity: (high|critical)" }
    prompt: Fix it
    tools: [read, edit, search, shell]
  - id: report
    needs: [triage]
    prompt: Write a note
  - id: notify
    needs: [hotfix, report]
    join: any
    prompt: Summarize
  - id: settle
    needs: [notify]
    wait: "curl -sf localhost:8080/health"
    every: 30s
    timeout: 10m
"#;

    #[test]
    fn a_good_factory_reads() {
        let f = parse(GOOD).unwrap();
        assert_eq!(f.nodes.len(), 5);
        assert!(!f.nodes[0].edits);
        assert!(f.nodes[1].edits, "edits defaults to true");
        assert_eq!(f.nodes[3].join, Join::Any);
        assert!(f.nodes[4].is_wait());
        assert_eq!(f.trigger.unwrap().every.as_deref(), Some("2m"));
    }

    #[test]
    fn mistakes_are_named() {
        let bad = |from: &str, to: &str| parse(&GOOD.replace(from, to)).unwrap_err();
        assert!(bad("needs: [triage]\n    when", "needs: [nope]\n    when").contains("“nope”"));
        assert!(bad("tools: [read, edit", "tools: [read, hack").contains("no built-in tool “hack”"));
        assert!(bad("every: 30s", "every: soon").contains("isn't a duration"));
        assert!(bad("matches: \"severity: (high|critical)\"", "matches: \"(\"").contains("valid pattern"));
        assert!(bad("  - id: report\n    needs: [triage]", "  - id: report\n    needs: [notify]").contains("circle"));
        assert!(bad("id: report", "id: hotfix").contains("Two nodes"));
        assert!(bad("    prompt: Summarize\n", "\n").contains("needs a prompt"));
        assert!(bad("edits: false\n    skills", "editz: false\n    skills").contains("editz"), "unknown keys are caught");
        assert!(bad("prompt: Write a note", "prompt: End with \"severity: low\" or so").contains("needs quotes"));
    }

    #[test]
    fn a_condition_must_read_an_earlier_node() {
        let text = GOOD.replace("when: { from: triage", "when: { from: report");
        assert!(parse(&text).unwrap_err().contains("has to need that node"));
    }

    #[test]
    fn conditions_and_durations() {
        let w = When { from: "t".into(), matches: Some("critical|high".into()), not_matches: Some("false alarm".into()) };
        assert!(when_holds(&w, "Severity: CRITICAL"));
        assert!(!when_holds(&w, "low"));
        assert!(!when_holds(&w, "critical, but a false alarm"));
        assert_eq!(parse_duration("1h30m"), Some(Duration::from_secs(5400)));
        assert_eq!(parse_duration("45"), Some(Duration::from_secs(45)));
        assert_eq!(parse_duration("2x"), None);
    }

    #[test]
    fn triggers_are_checked() {
        let with = |t: &str| parse(&format!("name: x\ntrigger:\n{t}\nnodes:\n  - {{ id: a, prompt: hi }}\n"));
        assert!(with("  every: 15m").is_ok());
        assert!(with("  at: \"09:00, 17:30\"").is_ok());
        assert!(with("  webhook: true").is_ok());
        assert!(with("  webhook: s3cret").is_ok());
        assert!(with("  file: ./inbox").is_ok());
        assert!(with("  at: \"25:00\"").unwrap_err().contains("times of day"));
        assert!(with("  every: 1s").unwrap_err().contains("at least 5s"));
        assert!(with("  watch: ./x.sh").unwrap_err().contains("needs every"));
        assert!(with("  webhook: false").unwrap_err().contains("empty"));
        assert!(with("  watch: ./x.sh\n  every: 30s\n  fires: each").is_ok());
        assert!(with("  watch: ./x.sh\n  every: 30s\n  fires: always").unwrap_err().contains("each or change"));
        assert!(with("  every: 30s\n  fires: each").unwrap_err().contains("goes with watch"));
        assert_eq!(at_times("9:05,17:30"), Some(vec![(9, 5), (17, 30)]));
    }

    #[test]
    fn loops_are_checked_and_cover_the_path_back() {
        let base = |l: &str| format!("name: x\nnodes:\n  - {{ id: plan, prompt: p }}\n  - {{ id: fix, needs: [plan], prompt: f }}\n  - {{ id: test, needs: [fix], prompt: t }}\n  - {{ id: review, needs: [test, plan], prompt: r, {l} }}\n  - {{ id: ship, needs: [review], prompt: s }}\n");
        let f = parse(&base("loop: { back_to: fix, until: { matches: approved }, max: 4 }")).unwrap();
        let l = f.nodes[3].repeat_until.as_ref().unwrap();
        assert_eq!((l.max_rounds(), l.done("Verdict: APPROVED"), l.done("needs work")), (4, true, false));
        assert_eq!(loop_region(&f.nodes, "fix", "review"), ["fix", "test", "review"], "plan isn't on the way back");
        assert_eq!(loop_region(&f.nodes, "review", "review"), ["review"]);
        assert!(parse(&base("loop: { back_to: ship, until: { matches: x } }")).unwrap_err().contains("has to be this node or one it needs"));
        assert!(parse(&base("loop: { back_to: fix, until: {} }")).unwrap_err().contains("needs until"));
        assert!(parse(&base("loop: { back_to: fix, until: { matches: x }, max: 0 }")).unwrap_err().contains("1 to 20"));
        assert!(parse(&base("loop: { back_to: fix, until: { matches: x }, on_max: retry }")).unwrap_err().contains("fail or continue"));
    }

    #[test]
    fn repeat_reads_both_ways() {
        let with = |r: &str| parse(&format!("name: x\n{r}\nnodes:\n  - {{ id: a, prompt: hi }}\n"));
        assert_eq!(repeat_of(&with("repeat: true").unwrap()), Some((MIN_REPEAT, false)));
        assert_eq!(repeat_of(&with("repeat: false").unwrap()), None);
        assert_eq!(repeat_of(&with("repeat: { after: 2m, on_failure: continue }").unwrap()), Some((Duration::from_secs(120), true)));
        assert_eq!(repeat_of(&with("repeat: { after: 1s }").unwrap()).unwrap().0, MIN_REPEAT, "at least 5s");
        assert!(with("repeat: { after: soon }").unwrap_err().contains("isn't a duration"));
        assert!(with("repeat: { on_failure: retry }").unwrap_err().contains("stop or continue"));
    }

    #[test]
    fn the_template_is_a_valid_factory() {
        let f = parse(&template("My factory")).unwrap();
        assert_eq!(f.name, "My factory");
        assert_eq!(topo_order(&f.nodes).unwrap().len(), 3);
    }

    #[test]
    fn files_load_with_their_errors() {
        let d = std::env::temp_dir().join(format!("paw-factories-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("good.yaml"), GOOD).unwrap();
        std::fs::write(d.join("broken.yml"), "name: x\nnodes: []\n").unwrap();
        std::fs::write(d.join("notes.txt"), "not a factory").unwrap();
        let found = load_all(&d);
        std::fs::remove_dir_all(&d).ok();
        assert_eq!(found.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), ["broken", "good"]);
        assert!(found[0].error.as_deref().unwrap().contains("no nodes"));
        assert!(found[1].factory.is_some());
    }
}
