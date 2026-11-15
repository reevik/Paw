#!/usr/bin/env python3
"""Write ui/licenses.json: the open source projects Paw is built from.

Rust crates come from `cargo metadata` (every crate compiled into the macOS
app, not build or test tools); the JavaScript libraries are the files in
ui/vendor. Run it again after changing dependencies:

    python3 paw/scripts/licenses.py
"""
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
TAURI = ROOT / "src-tauri"

# ui/vendor: the window's own libraries.
VENDOR = [
    {"name": "xterm.js", "license": "MIT", "url": "https://github.com/xtermjs/xterm.js", "about": "Terminal emulator for the shell and full-screen programs"},
    {"name": "@xterm/addon-fit", "license": "MIT", "url": "https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit", "about": "Sizes the terminal to its pane"},
    {"name": "marked", "version": "12.0.2", "license": "MIT", "url": "https://github.com/markedjs/marked", "about": "Markdown in agent replies"},
    {"name": "DOMPurify", "version": "3.1.6", "license": "MPL-2.0 OR Apache-2.0", "url": "https://github.com/cure53/DOMPurify", "about": "Keeps rendered replies safe"},
]

# Shown first, with a line on what each one does for Paw.
HIGHLIGHTS = {
    "tauri": "Native macOS window and app shell",
    "rig-core": "Rig: model providers for Paw Agent",
    "rig-agent": "Rig: the agent loop behind Paw Agent",
    "rig-tools": "Rig: file and shell tools for Paw Agent",
    "rmcp": "Model Context Protocol client",
    "tokio": "Async runtime",
    "serde": "Settings and event serialization",
    "portable-pty": "Terminals for the shell",
    "security-framework": "macOS Keychain access",
    "toml_edit": "Edits agent config files without losing comments",
    "reqwest": "HTTP client",
}


def crates():
    meta = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--format-version", "1", "--filter-platform", "aarch64-apple-darwin", "--locked"],
        cwd=TAURI,
    ))
    pkgs = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    root = meta["resolve"]["root"]
    direct = set()
    seen, todo = set(), [root]
    while todo:
        cur = todo.pop()
        for d in nodes[cur]["deps"]:
            if not any(k["kind"] is None for k in d["dep_kinds"]):
                continue  # build and test tools aren't in the app
            if cur == root:
                direct.add(d["pkg"])
            if d["pkg"] not in seen:
                seen.add(d["pkg"])
                todo.append(d["pkg"])
    direct_names = {pkgs[d]["name"] for d in direct}
    out = []
    for pid in seen:
        p = pkgs[pid]
        if p["source"] is None:
            continue  # a local crate
        out.append({
            "name": p["name"],
            "version": p["version"],
            "license": p.get("license") or ("See " + pathlib.Path(p["license_file"]).name if p.get("license_file") else "Unknown"),
            "url": p.get("repository") or p.get("homepage") or f"https://crates.io/crates/{p['name']}",
            "direct": pid in direct,
            **({"about": HIGHLIGHTS[p["name"]]} if p["name"] in HIGHLIGHTS and (pid in direct or p["name"] not in direct_names) else {}),
        })
    out.sort(key=lambda c: (c["name"].lower(), c["version"]))
    return out


def main():
    data = {"javascript": VENDOR, "rust": crates()}
    path = ROOT / "ui" / "licenses.json"
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
    print(f"{path}: {len(data['rust'])} crates, {len(VENDOR)} JavaScript libraries")


if __name__ == "__main__":
    main()
