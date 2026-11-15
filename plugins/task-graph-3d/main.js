// Task Graph 3D: a task's plan as a 3D graph on its board ("3D", next to
// "Graph"). Plain WebGL on the canvas Paw hands over; no libraries.
//
// Steps are slabs in layers, left to right by what they need; a layer's
// steps sit around a ring. Colors show their state (running ones pulse);
// curves join each step to the ones that need it. Drag to turn it, scroll to
// zoom, double-click to reset; click a step for its details. Left alone (the
// pointer elsewhere), it turns slowly.

const STATE_COLOR = {
  running: [0.29, 0.55, 0.97], needs: [0.91, 0.51, 0.23], done: [0.25, 0.65, 0.36], failed: [0.9, 0.33, 0.29],
  stopped: [0.83, 0.65, 0.17], skipped: [0.42, 0.44, 0.48], waiting: [0.5, 0.52, 0.57], blocked: [0.29, 0.55, 0.97],
};
const STATE_TEXT = { running: "running", needs: "needs you", done: "done", failed: "failed", stopped: "stopped", skipped: "skipped", waiting: "waiting", blocked: "running" };
const BOX = [2.5, 1.0, 0.32];        // a step's slab
const LAYER_GAP = 3.6;

// ---------- math (column-major 4×4) ----------
function mul(a, b) {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
    o[i * 4 + j] = s;
  }
  return o;
}
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
function lookAt(e, c, up) {
  let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
}
const model = (p, s) => new Float32Array([s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, p[0], p[1], p[2], 1]);
function project(m, p) {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w, z / w, w];
}

// ---------- GL helpers ----------
function program(gl, vs, fs) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const loc = {};
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); i++) { const a = gl.getActiveAttrib(p, i); loc[a.name] = gl.getAttribLocation(p, a.name); }
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) { const u = gl.getActiveUniform(p, i); loc[u.name] = gl.getUniformLocation(p, u.name); }
  return { p, loc };
}
function buffer(gl, data, target = gl.ARRAY_BUFFER) {
  const b = gl.createBuffer();
  gl.bindBuffer(target, b);
  gl.bufferData(target, data, gl.STATIC_DRAW);
  return b;
}
function boxGeometry() {
  // 6 faces × 4 corners: position + normal.
  const f = [[[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]]];
  const v = [], idx = [];
  f.forEach(([n, u, w], i) => {
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      v.push(n[0] * 0.5 + u[0] * a * 0.5 + w[0] * b * 0.5, n[1] * 0.5 + u[1] * a * 0.5 + w[1] * b * 0.5, n[2] * 0.5 + u[2] * a * 0.5 + w[2] * b * 0.5, ...n);
    }
    idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  });
  return { v: new Float32Array(v), i: new Uint16Array(idx) };
}
// The 12 edges of a unit box, for the selection outline.
const WIRE = (() => {
  const c = [];
  for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) c.push([x, y, -0.5], [x, y, 0.5]);
  for (const x of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) c.push([x, -0.5, z], [x, 0.5, z]);
  for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) c.push([-0.5, y, z], [0.5, y, z]);
  return new Float32Array(c.flat());
})();

const fmtTime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
};
const parseColor = (css, fallback) => {
  const m = /^#([0-9a-f]{6})$/i.exec(String(css).trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
};

// ---------- the scene ----------
class Scene {
  constructor(ctx) {
    this.ctx = ctx;
    const gl = ctx.canvas.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: true });
    if (!gl) throw new Error("WebGL isn't available");
    this.gl = gl;
    this.mesh = program(gl, `
      attribute vec3 aPos; attribute vec3 aNor; uniform mat4 uMVP; varying vec3 vNor;
      void main() { vNor = aNor; gl_Position = uMVP * vec4(aPos, 1.0); }`, `
      precision mediump float; varying vec3 vNor; uniform vec3 uColor; uniform float uAlpha;
      void main() {
        float d = max(dot(normalize(vNor), normalize(vec3(0.4, 0.8, 0.6))), 0.0);
        gl_FragColor = vec4(uColor * (0.5 + 0.55 * d) * uAlpha, uAlpha);
      }`);
    this.line = program(gl, `
      attribute vec3 aPos; uniform mat4 uMVP; void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`, `
      precision mediump float; uniform vec3 uColor; uniform float uAlpha; void main() { gl_FragColor = vec4(uColor * uAlpha, uAlpha); }`);
    this.label = program(gl, `
      attribute vec3 aPos; attribute vec2 aUV; uniform mat4 uMVP; varying vec2 vUV;
      void main() { vUV = aUV; gl_Position = uMVP * vec4(aPos, 1.0); }`, `
      precision mediump float; varying vec2 vUV; uniform sampler2D uTex; void main() { gl_FragColor = texture2D(uTex, vUV); }`);
    const box = boxGeometry();
    this.boxV = buffer(gl, box.v);
    this.boxI = buffer(gl, box.i, gl.ELEMENT_ARRAY_BUFFER);
    this.wireV = buffer(gl, WIRE);
    this.dyn = gl.createBuffer(); // edges and label quads, refilled per frame
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.theme = ctx.theme || {};
    this.edgeColor = parseColor(this.theme.dim, [0.55, 0.56, 0.6]);
    this.accent = parseColor(this.theme.accent, [0.49, 0.81, 1]);
    this.labels = new Map(); // step id → { key, tex }
    this.cam = { yaw: 0.45, pitch: 0.28, zoom: 1 };
    this.touched = 0;
    this.drag = null;
    this.setTask(ctx.task);
    this.resize(ctx);
    ctx.on("resize", (s) => this.resize(s));
    ctx.on("task", (t) => this.setTask(t));
    ctx.on("pointer", (e) => this.pointer(e));
    ctx.on("wheel", (e) => { this.cam.zoom = Math.min(3, Math.max(0.35, this.cam.zoom * Math.exp(e.dy * 0.0015))); this.touched = performance.now(); });
    ctx.on("close", () => { this.closed = true; });
    // Out of sight, it only checks back now and then.
    this.visible = true;
    ctx.on("visible", (v) => { this.visible = !!v; });
    const raf = self.requestAnimationFrame ? (f) => self.requestAnimationFrame(f) : (f) => setTimeout(() => f(performance.now()), 16);
    const loop = (t) => {
      if (this.closed) return;
      if (!this.visible) return setTimeout(() => loop(performance.now()), 500);
      this.draw(t);
      raf(loop);
    };
    raf(loop);
  }

  resize({ width, height, dpr }) {
    this.w = width; this.h = height; this.dpr = dpr || 1;
    this.ctx.canvas.width = Math.round(width * this.dpr);
    this.ctx.canvas.height = Math.round(height * this.dpr);
  }

  setTask(task) {
    this.task = task;
    const steps = task?.steps ?? [];
    const byId = new Map(steps.map((s) => [s.id, s]));
    const level = new Map();
    const lv = (s, seen) => {
      if (level.has(s.id)) return level.get(s.id);
      if (seen.has(s.id)) return 0;
      seen.add(s.id);
      const l = s.needs.filter((n) => byId.has(n)).reduce((m, n) => Math.max(m, lv(byId.get(n), seen) + 1), 0);
      level.set(s.id, l);
      return l;
    };
    steps.forEach((s) => lv(s, new Set()));
    const cols = [];
    steps.forEach((s) => (cols[level.get(s.id)] ??= []).push(s));
    this.pos = new Map();
    const L = cols.length;
    cols.forEach((col, i) => {
      const n = col.length;
      const r = n > 1 ? 1.0 + 0.42 * n : 0;
      col.forEach((s, j) => {
        const a = (j / n) * Math.PI * 2 + i * 0.7;
        this.pos.set(s.id, [(i - (L - 1) / 2) * LAYER_GAP, Math.cos(a) * r, Math.sin(a) * r]);
      });
    });
    // The radius of a sphere around everything: the camera fits it, whichever way it turns.
    let r = 0;
    for (const p of this.pos.values()) r = Math.max(r, Math.hypot(...p) + Math.hypot(BOX[0] / 2, BOX[1] / 2));
    this.radius = Math.max(2, r);
  }

  pointer(e) {
    // While the pointer is over the view it holds still, so steps stay where you aim.
    if (e.type === "pointermove" && !e.buttons) { this.hover = true; this.touched = performance.now(); }
    if (e.type === "pointerleave") this.hover = false;
    if (e.type === "pointerdown") {
      this.hover = true;
      this.drag = { x: e.x, y: e.y, moved: 0 };
      this.touched = performance.now();
    } else if (e.type === "pointermove" && this.drag && e.buttons) {
      const dx = e.x - this.drag.x, dy = e.y - this.drag.y;
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      this.drag.x = e.x; this.drag.y = e.y;
      this.cam.yaw -= dx * 0.008;
      this.cam.pitch = Math.max(-1.3, Math.min(1.3, this.cam.pitch + dy * 0.008));
      this.touched = performance.now();
    } else if (e.type === "pointerup") {
      if (this.drag && this.drag.moved < 5) this.pick(e.x, e.y);
      this.drag = null;
    } else if (e.type === "dblclick") {
      this.cam = { yaw: 0.45, pitch: 0.28, zoom: 1 };
      this.touched = 0;
    }
  }

  /** The step under the pointer (its label's rectangle on screen), nearest first. */
  pick(x, y) {
    let best = null;
    for (const [id, q] of this.quads ?? []) {
      const pts = q.map((p) => project(this.vp, p));
      if (pts.some((p) => p[3] <= 0)) continue;
      const sx = pts.map((p) => (p[0] * 0.5 + 0.5) * this.w), sy = pts.map((p) => (0.5 - p[1] * 0.5) * this.h);
      if (x >= Math.min(...sx) && x <= Math.max(...sx) && y >= Math.min(...sy) && y <= Math.max(...sy)) {
        const z = pts[0][2];
        if (!best || z < best.z) best = { id, z };
      }
    }
    this.ctx.select(best ? best.id : null);
  }

  /** A step's label as a texture, redrawn when its text changes. */
  labelTex(s, now) {
    const state = s.state;
    const time = s.startedAt ? fmtTime((s.endedAt ?? now) - s.startedAt) : "";
    const sub = [s.agent, STATE_TEXT[state] ?? state, state !== "waiting" ? time : "", s.edits ? "" : "reads"].filter(Boolean).join(" · ");
    const key = `${s.title}|${sub}`;
    const have = this.labels.get(s.id);
    if (have?.key === key) return have.tex;
    const W = 640, H = 256;
    const c = new OffscreenCanvas(W, H);
    const g = c.getContext("2d");
    g.fillStyle = "#ffffff";
    g.textBaseline = "top";
    g.font = "600 46px -apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif";
    // Two lines of title at most.
    const words = String(s.title).split(/\s+/);
    const lines = [""];
    for (const w of words) {
      const next = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${w}` : w;
      if (g.measureText(next).width > W - 64 && lines[lines.length - 1]) {
        if (lines.length === 2) { lines[1] += "…"; break; }
        lines.push(w);
      } else lines[lines.length - 1] = next;
    }
    lines.forEach((l, i) => {
      let t = l;
      while (g.measureText(t).width > W - 64 && t.length > 2) t = t.slice(0, -2) + "…";
      g.fillText(t, 32, 30 + i * 58);
    });
    g.globalAlpha = 0.85;
    g.font = "34px -apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif";
    let t = sub;
    while (g.measureText(t).width > W - 64 && t.length > 2) t = t.slice(0, -2) + "…";
    g.fillText(t, 32, 30 + 2 * 58 + 18);
    const gl = this.gl;
    const tex = have?.tex ?? gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.labels.set(s.id, { key, tex });
    return tex;
  }

  draw(t) {
    const gl = this.gl;
    const now = Date.now();
    if (!this.drag && !this.hover && performance.now() - this.touched > 4000) this.cam.yaw += 0.0018; // turns slowly when left alone
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const steps = this.task?.steps ?? [];
    if (!steps.length) return;
    // Far enough for the whole plan to fit the narrower of the two angles of view.
    const fov = 0.75, aspect = this.w / Math.max(1, this.h);
    const half = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * aspect)) / 2;
    // Start where a sphere around the plan fits; then (below) move until the
    // steps fill the view, whatever the board's shape.
    this.fitD ??= this.radius / Math.sin(half);
    const d = this.fitD * this.cam.zoom;
    const { yaw, pitch } = this.cam;
    const eye = [Math.cos(pitch) * Math.sin(yaw) * d, Math.sin(pitch) * d, Math.cos(pitch) * Math.cos(yaw) * d];
    const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
    const proj = perspective(fov, aspect, 0.1, 400);
    this.vp = mul(proj, view);
    const right = [view[0], view[4], view[8]], up = [view[1], view[5], view[9]];
    const pulse = 0.82 + 0.18 * Math.sin(t / 220);

    // Curves between steps.
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.useProgram(this.line.p);
    gl.uniformMatrix4fv(this.line.loc.uMVP, false, this.vp);
    const live = [], quiet = [];
    for (const s of steps) {
      const b = this.pos.get(s.id);
      for (const n of s.needs) {
        const a = this.pos.get(n);
        if (!a || !b) continue;
        const pa = [a[0] + BOX[0] / 2, a[1], a[2]], pb = [b[0] - BOX[0] / 2, b[1], b[2]];
        const c = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2 + 0.6, (pa[2] + pb[2]) / 2];
        const seg = [];
        for (let i = 0; i <= 20; i++) {
          const u = i / 20, k = 1 - u;
          seg.push(k * k * pa[0] + 2 * k * u * c[0] + u * u * pb[0], k * k * pa[1] + 2 * k * u * c[1] + u * u * pb[1], k * k * pa[2] + 2 * k * u * c[2] + u * u * pb[2]);
          if (i > 0 && i < 20) seg.push(seg[seg.length - 3], seg[seg.length - 2], seg[seg.length - 1]);
        }
        ((s.state === "running" || s.state === "needs" || s.state === "blocked") ? live : quiet).push(...seg);
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dyn);
    gl.enableVertexAttribArray(this.line.loc.aPos);
    for (const [pts, color, alpha] of [[quiet, this.edgeColor, 0.75], [live, this.accent, pulse]]) {
      if (!pts.length) continue;
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(this.line.loc.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.uniform3fv(this.line.loc.uColor, color);
      gl.uniform1f(this.line.loc.uAlpha, alpha);
      gl.drawArrays(gl.LINES, 0, pts.length / 3);
    }

    // Slabs.
    gl.useProgram(this.mesh.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxV);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.boxI);
    gl.enableVertexAttribArray(this.mesh.loc.aPos);
    gl.enableVertexAttribArray(this.mesh.loc.aNor);
    gl.vertexAttribPointer(this.mesh.loc.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(this.mesh.loc.aNor, 3, gl.FLOAT, false, 24, 12);
    for (const s of steps) {
      const p = this.pos.get(s.id);
      const base = STATE_COLOR[s.state] ?? STATE_COLOR.waiting;
      const k = s.state === "running" || s.state === "needs" || s.state === "blocked" ? pulse : 1;
      gl.uniformMatrix4fv(this.mesh.loc.uMVP, false, mul(this.vp, model(p, BOX)));
      gl.uniform3fv(this.mesh.loc.uColor, base.map((c) => c * k));
      gl.uniform1f(this.mesh.loc.uAlpha, s.state === "skipped" ? 0.55 : 1);
      gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0);
    }

    // The selected step: an outline.
    const sel = this.task.selected;
    if (sel && this.pos.has(sel)) {
      gl.useProgram(this.line.p);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.wireV);
      gl.vertexAttribPointer(this.line.loc.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix4fv(this.line.loc.uMVP, false, mul(this.vp, model(this.pos.get(sel), BOX.map((v) => v * 1.12 + 0.06))));
      gl.uniform3fv(this.line.loc.uColor, this.accent);
      gl.uniform1f(this.line.loc.uAlpha, 1);
      gl.drawArrays(gl.LINES, 0, WIRE.length / 3);
    }

    // Labels: facing the camera, in front of their slabs.
    gl.useProgram(this.label.p);
    gl.uniformMatrix4fv(this.label.loc.uMVP, false, this.vp);
    gl.depthMask(false);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dyn);
    gl.enableVertexAttribArray(this.label.loc.aPos);
    gl.enableVertexAttribArray(this.label.loc.aUV);
    this.quads = new Map();
    const hw = BOX[0] / 2, hh = (BOX[0] * 256 / 640) / 2;
    for (const s of steps) {
      const p = this.pos.get(s.id);
      const toEye = [eye[0] - p[0], eye[1] - p[1], eye[2] - p[2]];
      const l = Math.hypot(...toEye) || 1;
      // In front of the slab however it's turned, so the slab never cuts into it.
      const lift = Math.hypot(BOX[0] / 2, BOX[2] / 2) * 0.9;
      const c = [p[0] + toEye[0] / l * lift, p[1] + toEye[1] / l * lift, p[2] + toEye[2] / l * lift];
      const corner = (a, b) => [c[0] + right[0] * a * hw + up[0] * b * hh, c[1] + right[1] * a * hw + up[1] * b * hh, c[2] + right[2] * a * hw + up[2] * b * hh];
      const q = [corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)];
      this.quads.set(s.id, q);
      const data = new Float32Array([...q[0], 0, 0, ...q[1], 1, 0, ...q[2], 1, 1, ...q[0], 0, 0, ...q[2], 1, 1, ...q[3], 0, 1]);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(this.label.loc.aPos, 3, gl.FLOAT, false, 20, 0);
      gl.vertexAttribPointer(this.label.loc.aUV, 2, gl.FLOAT, false, 20, 12);
      gl.bindTexture(gl.TEXTURE_2D, this.labelTex(s, now));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.depthMask(true);

    // How much of the view the steps take: move the camera to fill about 85%.
    let m = 0;
    for (const q of this.quads.values()) for (const p of q) {
      const c = project(this.vp, p);
      if (c[3] > 0) m = Math.max(m, Math.abs(c[0]), Math.abs(c[1]));
    }
    if (m > 0 && Number.isFinite(m)) {
      this.fitD *= 1 + (m / 0.85 - 1) * 0.08;
      this.fitD = Math.min(this.radius * 8, Math.max(this.radius * 0.5, this.fitD));
    }
  }
}

paw.view("graph3d", { label: "3D" }, (ctx) => {
  try {
    new Scene(ctx);
  } catch (e) {
    console.error("Task Graph 3D:", e);
  }
});
