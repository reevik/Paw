//! Usage stats: one line per finished query or task in `~/.paw/stats.jsonl`,
//! summed up per day, week and month for `/stats`.
//!
//! A query is one prompt to an agent, until its turn ends (task planning and
//! task steps included). A task is a whole task that finished all its steps.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
pub struct Entry {
    /// When it ended (ms since the epoch).
    pub ts: u64,
    /// "query" or "task".
    pub kind: String,
    /// The agent's name and the model it ran with.
    pub agent: String,
    pub model: String,
    pub ok: bool,
    /// How long it took (ms).
    pub ms: u64,
    /// Tokens, when the agent reports them.
    pub input: u64,
    pub output: u64,
    /// Cost in USD, when the agent reports it (Claude Code does).
    pub cost: f64,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Totals {
    pub queries: u64,
    pub failed: u64,
    pub tasks: u64,
    pub input: u64,
    pub output: u64,
    pub cost: f64,
    /// Time spent on queries (ms), for the average.
    pub ms: u64,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct ModelRow {
    pub agent: String,
    pub model: String,
    pub queries: u64,
    pub avg_ms: u64,
    pub input: u64,
    pub output: u64,
    pub cost: f64,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Summary {
    pub day: Totals,
    pub week: Totals,
    pub month: Totals,
    /// Per model, for the period asked for, most used first.
    pub models: Vec<ModelRow>,
}

fn file(home: &Path) -> std::path::PathBuf {
    home.join("stats.jsonl")
}

pub fn record_in(home: &Path, e: &Entry) -> Result<(), String> {
    std::fs::create_dir_all(home).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(file(home)).map_err(|e| e.to_string())?;
    let mut line = serde_json::to_string(e).map_err(|e| e.to_string())?;
    line.push('\n');
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

fn add(t: &mut Totals, e: &Entry) {
    if e.kind == "task" {
        t.tasks += u64::from(e.ok);
        return;
    }
    t.queries += 1;
    t.failed += u64::from(!e.ok);
    t.input += e.input;
    t.output += e.output;
    t.cost += e.cost;
    t.ms += e.ms;
}

/// Sum up the entries since each start (ms); per model since `models_since`.
pub fn summary_in(home: &Path, day: u64, week: u64, month: u64, models_since: u64) -> Summary {
    let mut s = Summary::default();
    let mut models: BTreeMap<(String, String), (ModelRow, u64)> = BTreeMap::new();
    let Ok(text) = std::fs::read_to_string(file(home)) else { return s };
    for e in text.lines().filter_map(|l| serde_json::from_str::<Entry>(l).ok()) {
        if e.ts >= day {
            add(&mut s.day, &e);
        }
        if e.ts >= week {
            add(&mut s.week, &e);
        }
        if e.ts >= month {
            add(&mut s.month, &e);
        }
        if e.kind == "query" && e.ts >= models_since {
            let (row, ms) = models.entry((e.agent.clone(), e.model.clone())).or_insert_with(|| {
                (ModelRow { agent: e.agent.clone(), model: e.model.clone(), ..Default::default() }, 0)
            });
            row.queries += 1;
            row.input += e.input;
            row.output += e.output;
            row.cost += e.cost;
            *ms += e.ms;
        }
    }
    s.models = models
        .into_values()
        .map(|(mut row, ms)| {
            row.avg_ms = ms / row.queries.max(1);
            row
        })
        .collect();
    s.models.sort_by(|a, b| b.queries.cmp(&a.queries).then(a.model.cmp(&b.model)));
    s
}

fn home() -> Result<std::path::PathBuf, String> {
    crate::paths::home().ok_or_else(|| "No home folder".to_string())
}

#[tauri::command]
pub fn stats_record(entry: Entry) -> Result<(), String> {
    record_in(&home()?, &entry)
}

/// The starts of today, this week and this month come from the window (its
/// local time); `models_since` picks the period of the per-model table.
#[tauri::command]
pub fn stats_summary(day: u64, week: u64, month: u64, models_since: u64) -> Result<Summary, String> {
    Ok(summary_in(&home()?, day, week, month, models_since))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(ts: u64, agent: &str, model: &str, ok: bool, ms: u64, input: u64, output: u64, cost: f64) -> Entry {
        Entry { ts, kind: "query".into(), agent: agent.into(), model: model.into(), ok, ms, input, output, cost }
    }

    #[test]
    fn sums_per_period_and_model() {
        let home = std::env::temp_dir().join(format!("paw-stats-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        // month starts at 100, week at 200, day at 300
        record_in(&home, &q(150, "Claude Code", "claude-opus-5-5", true, 10_000, 1000, 100, 0.5)).unwrap();
        record_in(&home, &q(250, "Claude Code", "claude-opus-5-5", true, 20_000, 2000, 200, 1.0)).unwrap();
        record_in(&home, &q(350, "Paw Agent", "gemma4:latest", false, 4_000, 300, 30, 0.0)).unwrap();
        record_in(&home, &Entry { ts: 360, kind: "task".into(), ok: true, ..Default::default() }).unwrap();
        record_in(&home, &q(50, "Claude Code", "claude-opus-5-5", true, 1, 1, 1, 0.0)).unwrap(); // last month
        std::fs::OpenOptions::new().append(true).open(file(&home)).unwrap().write_all(b"not json\n").unwrap();

        let s = summary_in(&home, 300, 200, 100, 100);
        assert_eq!((s.day.queries, s.day.failed, s.day.tasks, s.day.input), (1, 1, 1, 300));
        assert_eq!((s.week.queries, s.week.input, s.week.output), (2, 2300, 230));
        assert_eq!((s.month.queries, s.month.tasks, s.month.ms), (3, 1, 34_000));
        assert!((s.month.cost - 1.5).abs() < 1e-9);
        assert_eq!(s.models.len(), 2);
        assert_eq!((s.models[0].model.as_str(), s.models[0].queries, s.models[0].avg_ms), ("claude-opus-5-5", 2, 15_000));
        assert_eq!((s.models[1].agent.as_str(), s.models[1].avg_ms), ("Paw Agent", 4_000));
        // Per model for today only.
        assert_eq!(summary_in(&home, 300, 200, 100, 300).models.len(), 1);
        let _ = std::fs::remove_dir_all(&home);
    }
}
