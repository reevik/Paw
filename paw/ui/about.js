// About window: version, the MIT license, and the open source projects Paw
// is built on (ui/licenses.json, written by scripts/licenses.py).
const T = window.__TAURI__;
const invoke = (cmd, args) => (T ? T.core.invoke(cmd, args) : Promise.reject(new Error("no backend")));
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const VIEWS = ["home", "license", "oss"];
let projects = null;

function showView(name) {
  if (!VIEWS.includes(name)) name = "home";
  for (const v of VIEWS) $(`v-${v}`).hidden = v !== name;
  if (name === "license") loadLicense();
  if (name === "oss") loadProjects().then(() => $("q").focus({ preventScroll: true }));
  history.replaceState(null, "", name === "home" ? location.pathname : `#${name}`);
}
window.showView = showView; // the backend calls this when the window is already open

document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]");
  if (go) return showView(go.dataset.go);
  const link = e.target.closest("[data-url]");
  if (link) {
    e.preventDefault();
    invoke("open_url", { url: link.dataset.url }).catch(() => {});
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("v-home").hidden) T?.window?.getCurrentWindow().close();
  else if (document.activeElement === $("q") && $("q").value) { $("q").value = ""; renderProjects(); }
  else showView("home");
});

// ---------- License ----------
let licenseLoaded = false;
async function loadLicense() {
  if (licenseLoaded) return;
  try {
    // Paragraphs reflow to the window; the file wraps at 80 columns.
    const text = await (await fetch("LICENSE.txt")).text();
    $("license-text").textContent = text.trim().replace(/([^\n])\n(?!\n)/g, "$1 ");
    licenseLoaded = true;
  } catch {
    $("license-text").textContent = tx("The license text couldn't be loaded.");
  }
}

// ---------- Open source projects ----------
async function loadProjects() {
  if (projects) return;
  try {
    const data = await (await fetch("licenses.json")).json();
    const js = data.javascript.map((p) => ({ ...p, kind: "js" }));
    const rust = data.rust.map((p) => ({ ...p, kind: "rust" }));
    projects = { js, rust, highlights: rust.filter((p) => p.about).sort((a, b) => order(a) - order(b)) };
  } catch {
    projects = { js: [], rust: [], highlights: [] };
  }
  renderProjects();
}
// Highlights in the order they matter to Paw.
const FIRST = ["tauri", "rig-agent", "rig-core", "rig-tools", "rmcp", "tokio"];
const order = (p) => (FIRST.includes(p.name) ? FIRST.indexOf(p.name) : FIRST.length);

// "MIT OR Apache-2.0", "MIT/Apache-2.0", "(A OR B) AND C": each license id links to its SPDX page.
function licenseHtml(expr) {
  if (!/^[A-Za-z0-9.+\-()/ ]+$/.test(expr) || /^See /.test(expr) || expr === "Unknown") return `<span class="chip">${esc(expr)}</span>`;
  return expr
    .replace(/\s*\/\s*/g, " OR ")
    .split(/(\s+|\(|\))/)
    .filter((t) => t.trim())
    .map((t) => {
      if (/^(OR|AND|WITH)$/.test(t)) return `<span class="chip op">${t.toLowerCase()}</span>`;
      if (t === "(" || t === ")") return "";
      return `<a class="chip" href="#" data-url="https://spdx.org/licenses/${esc(t)}.html" title="${tx("Read the {name} license", { name: esc(t) })}">${esc(t)}</a>`;
    })
    .join("");
}

const linkIcon = `<svg class="open" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>`;

function row(p, withAbout) {
  const ver = p.version ? `<span class="ver">${esc(p.version)}</span>` : "";
  const about = withAbout && p.about ? `<span class="about-line">${esc(p.about)}</span>` : "";
  return `<div class="proj" role="link" tabindex="0" data-url="${esc(p.url)}" title="${esc(p.url)}">
    <div class="meta"><span class="nm">${esc(p.name)}</span>${ver}${about}<div class="lic">${licenseHtml(p.license)}</div></div>
    ${linkIcon}
  </div>`;
}

function group(title, list, { about = false, compact = false } = {}) {
  if (!list.length) return "";
  return `<section class="grp"><h3><span>${esc(title)}</span><span>${list.length}</span></h3>
    <div class="cards${compact ? " compact" : ""}">${list.map((p) => row(p, about)).join("")}</div></section>`;
}

function renderProjects() {
  if (!projects) return;
  const q = $("q").value.trim().toLowerCase();
  const hit = (p) => !q || `${p.name} ${p.license} ${p.about ?? ""}`.toLowerCase().includes(q);
  const total = projects.js.length + projects.rust.length;
  let html = q ? "" : `<p class="thanks">${tx("Paw is built on {n} open source projects. Thank you to everyone who makes them.", { n: total })}</p>`;
  if (!q) html += group(tx("Highlights"), projects.highlights, { about: true });
  html += group(tx("In the window"), projects.js.filter(hit), { about: true });
  html += group(tx("Rust crates"), projects.rust.filter(hit), { compact: true });
  $("oss-list").innerHTML = html || `<p class="empty">${tx("No project matches “{q}”.", { q: esc(q) })}</p>`;
}
$("q").addEventListener("input", renderProjects);
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.(".proj")) { e.preventDefault(); e.target.click(); }
});

// ---------- Start ----------
invoke("about_info")
  .then((i) => {
    $("version").textContent = tx("Version {version}", { version: i.version });
    $("built-with").textContent = tx("Built with Tauri {version} and Rig", { version: i.tauri });
  })
  .catch(() => {});
fetch("licenses.json")
  .then((r) => r.json())
  .then((d) => { $("oss-count").textContent = tx("{n} projects and their licenses", { n: d.javascript.length + d.rust.length }); })
  .catch(() => {});
showView(location.hash.slice(1));
