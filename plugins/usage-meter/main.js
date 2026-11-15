// Usage Meter: today's prompts and tokens in the status bar.
//   /usage-meter         today's numbers in the tab
//   /usage-meter reset   start today's count over

const today = () => new Date().toISOString().slice(0, 10);
let day = { date: today(), prompts: 0, input: 0, output: 0, ms: 0 };

const fmt = (n) => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`);

function show() {
  if (!day.prompts) return paw.status("");
  paw.status(`Σ ${day.prompts} · ↑${fmt(day.input)} ↓${fmt(day.output)}`, { title: "Today's prompts and tokens (Usage Meter)" });
}

async function load() {
  const saved = await paw.storage.get("day");
  if (saved && saved.date === today()) day = saved;
  show();
}

paw.on("turn", async (t) => {
  if (day.date !== today()) day = { date: today(), prompts: 0, input: 0, output: 0, ms: 0 };
  day.prompts += 1;
  day.input += t.input || 0;
  day.output += t.output || 0;
  day.ms += t.ms || 0;
  show();
  await paw.storage.set("day", day);
});

paw.command("usage-meter", { description: "today's prompts and tokens; reset starts over", usage: "[reset]" }, async (args) => {
  if (args.trim() === "reset") {
    day = { date: today(), prompts: 0, input: 0, output: 0, ms: 0 };
    await paw.storage.set("day", day);
    show();
    return "Today's count starts over.";
  }
  if (!day.prompts) return "No agent turns today yet.";
  const avg = Math.round(day.ms / day.prompts / 1000);
  return `**Today:** ${day.prompts} prompt${day.prompts === 1 ? "" : "s"} · ↑ ${fmt(day.input)} in · ↓ ${fmt(day.output)} out · ${avg}s on average.`;
});

load();
