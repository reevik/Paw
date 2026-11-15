// Snippets: prompts you use often.
//   /snip                      list them
//   /snip save <name> <text>   save one
//   /snip <name>               put it in the prompt (edit it, then press ⏎)
//   /snip delete <name>        remove one

const nameOk = (n) => /^[a-z0-9][a-z0-9-_]{0,31}$/i.test(n);

async function all() {
  return (await paw.storage.get("snippets")) || {};
}

paw.command("snip", { description: "saved prompts: /snip save <name> <text> · /snip <name> · /snip delete <name>", usage: "[name | save … | delete …]" }, async (args, tab) => {
  const [first = "", ...rest] = args.trim().split(/\s+/);
  const snippets = await all();
  if (!first) {
    const names = Object.keys(snippets).sort();
    if (!names.length) return "No snippets yet. Save one: `/snip save review Review this change for bugs and missing tests.`";
    return names.map((n) => `- **${n}** — ${snippets[n].length > 70 ? snippets[n].slice(0, 69) + "…" : snippets[n]}`).join("\n");
  }
  if (first === "save") {
    const [name, ...words] = rest;
    const text = args.trim().replace(/^save\s+\S+\s*/, "");
    if (!name || !nameOk(name) || !words.length) return "Usage: `/snip save <name> <text>` (the name: letters, digits, - or _).";
    snippets[name] = text;
    await paw.storage.set("snippets", snippets);
    return `Saved **${name}**. \`/snip ${name}\` puts it in the prompt.`;
  }
  if (first === "delete") {
    const name = rest[0];
    if (!name || !(name in snippets)) return `There's no snippet **${name ?? ""}**.`;
    delete snippets[name];
    await paw.storage.set("snippets", snippets);
    return `Deleted **${name}**.`;
  }
  if (!(first in snippets)) return `There's no snippet **${first}**. \`/snip\` lists them.`;
  await paw.prompt(tab, snippets[first]);
  return "";
});
