// SPDX-License-Identifier: Apache-2.0
// The blast-radius graph webview: a radial layout with the change at the centre and one ring per
// hop, drawn as SVG. Data arrives from the extension by postMessage; clicking a node asks the
// extension to open its file (by node id: the webview never handles file paths).
(() => {
  const vscode = acquireVsCodeApi();
  const SVG = "http://www.w3.org/2000/svg";
  const $ = (id) => document.getElementById(id);
  const svg = $("graph");
  const viewport = $("viewport");
  const tip = $("tip");

  const KIND = {
    hub: "",
    Object: "OBJECT",
    Field: "FIELD",
    Flow: "FLOW",
    ApexTrigger: "TRIGGER",
    ApexClass: "APEX CLASS",
    ValidationRule: "VALIDATION RULE",
    RollUpSummary: "ROLL-UP",
    PermissionSet: "PERMISSION SET",
    Profile: "PROFILE",
    FormulaField: "FORMULA FIELD",
    Agent: "AGENT",
    AgentTopic: "AGENT TOPIC",
    AgentAction: "AGENT ACTION",
    Other: "",
  };
  const AUTOMATION = new Set(["Flow", "ApexTrigger", "ValidationRule", "RollUpSummary"]);
  const KIND_ORDER = Object.keys(KIND);
  const MAX_LABEL = 34;
  const PILL_H = 30;

  let graph;
  let view = { x: 0, y: 0, k: 1 };
  let moved = false;

  const el = (name, attrs = {}, parent) => {
    const e = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (parent) parent.appendChild(e);
    return e;
  };
  const short = (s, max = MAX_LABEL) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  const caption = (n) => {
    if (n.changed) return [KIND[n.kind] || "CHANGE", (n.detail || "").toUpperCase()].filter(Boolean).join(" · ");
    if (AUTOMATION.has(n.kind) && n.detail) return n.detail.toUpperCase();
    if (n.kind === "Object" && n.detail) return `OBJECT · ${n.detail.toUpperCase()}`;
    return KIND[n.kind] || "";
  };

  // Measure label widths with a hidden text element, so pills fit their text.
  const measurer = el("text", { class: "label", x: -9999, y: -9999 }, svg);
  const widthOf = (text, cls = "label") => {
    measurer.setAttribute("class", cls);
    measurer.textContent = text;
    return measurer.getComputedTextLength();
  };

  function layout(g) {
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const hub = g.center === "hub";
    const ring = (n) => (n.id === g.center ? 0 : n.depth + (hub ? 1 : 0));
    for (const n of g.nodes) {
      n.ring = ring(n);
      n.text = short(n.label);
      n.cap = caption(n);
      n.w = Math.max(widthOf(n.text) + 42, widthOf(n.cap, "kind") + 20);
    }

    // A spanning tree: each node hangs off a neighbour one ring further in.
    const neighbours = new Map(g.nodes.map((n) => [n.id, []]));
    for (const e of g.edges) {
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      neighbours.get(e.from).push({ id: e.to, recursion: e.recursion });
      neighbours.get(e.to).push({ id: e.from, recursion: e.recursion });
    }
    const children = new Map(g.nodes.map((n) => [n.id, []]));
    for (const n of g.nodes) {
      if (n.id === g.center) continue;
      const options = neighbours.get(n.id).filter((m) => byId.get(m.id).ring === n.ring - 1);
      const parent = (options.find((m) => !m.recursion) || options[0] || { id: g.center }).id;
      n.parent = parent;
      children.get(parent).push(n);
    }
    for (const list of children.values())
      list.sort(
        (a, b) =>
          a.ring - b.ring || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.label.localeCompare(b.label),
      );

    // Ring radii: far enough apart, and wide enough for the pills on them.
    const rings = Math.max(0, ...g.nodes.map((n) => n.ring));
    const widths = new Array(rings + 1).fill(0);
    for (const n of g.nodes) widths[n.ring] += n.w + 26;
    const radius = [0];
    for (let k = 1; k <= rings; k++)
      radius[k] = Math.max(radius[k - 1] + (k === 1 ? 175 : 135), widths[k] / (2 * Math.PI));

    // Angles: each subtree gets at least the angle its pills need on their rings, and a share of
    // what's left by its number of leaves, so deep chains get room to spread.
    const measure = (n) => {
      const kids = children.get(n.id);
      for (const c of kids) measure(c);
      const own = n.id === g.center ? 0 : (n.w + 26) / radius[n.ring];
      n.need = Math.max(
        own,
        kids.reduce((s, c) => s + c.need, 0),
      );
      n.leaves = kids.length ? kids.reduce((s, c) => s + c.leaves, 0) : 1;
    };
    const center = byId.get(g.center);
    measure(center);
    if (center.need > 2 * Math.PI) {
      // Too crowded for one turn: push every ring out until it fits.
      const grow = center.need / (2 * Math.PI);
      for (let k = 1; k <= rings; k++) radius[k] *= grow;
      measure(center);
    }
    const place = (n, start, span) => {
      const a = start + span / 2;
      n.angle = a;
      n.x = n.id === g.center ? 0 : radius[n.ring] * Math.cos(a);
      n.y = n.id === g.center ? 0 : radius[n.ring] * Math.sin(a);
      const kids = children.get(n.id);
      const mins = kids.reduce((s, c) => s + c.need, 0);
      const leaves = kids.reduce((s, c) => s + c.leaves, 0) || 1;
      const extra = Math.max(0, span - mins);
      const squeeze = mins > span ? span / mins : 1;
      let at = start;
      for (const c of kids) {
        const share = c.need * squeeze + (extra * c.leaves) / leaves;
        place(c, at, share);
        at += share;
      }
    };
    // Start so the first child's sector is centred at the top.
    const kids = children.get(g.center);
    const firstShare = kids[0]
      ? kids[0].need + (Math.max(0, 2 * Math.PI - center.need) * kids[0].leaves) / (center.leaves || 1)
      : 0;
    place(center, -Math.PI / 2 - firstShare / 2, 2 * Math.PI);
    return { byId, radius, rings, hub };
  }

  /** Where a line from (fx, fy) towards a pill centred at (x, y) meets its border. */
  function border(n, fx, fy) {
    const dx = fx - n.x;
    const dy = fy - n.y;
    if (n.id === graph.center) {
      const d = Math.hypot(dx, dy) || 1;
      return [n.x + (dx / d) * 46, n.y + (dy / d) * 46];
    }
    const hw = n.w / 2;
    const hh = PILL_H / 2;
    const t = Math.min(
      dx ? hw / Math.abs(dx) : Number.POSITIVE_INFINITY,
      dy ? hh / Math.abs(dy) : Number.POSITIVE_INFINITY,
    );
    return [n.x + dx * Math.min(1, t), n.y + dy * Math.min(1, t)];
  }

  function draw(g, meta) {
    while (viewport.firstChild) viewport.removeChild(viewport.firstChild);
    tip.hidden = true;
    $("empty").hidden = true;
    renderHeader(meta);
    if (!g?.nodes.length || (g.center === "hub" && g.nodes.length === 1)) {
      $("empty").hidden = false;
      $("empty").textContent = meta.busy
        ? "Analyzing…"
        : meta.error
          ? `Couldn't analyze: ${meta.error}`
          : "No Salesforce metadata changed yet. Edit a class, flow, field or rule and save it.";
      return;
    }
    const { byId, radius, rings, hub } = layout(g);

    const ringLayer = el("g", { class: "rings" }, viewport);
    const edgeLayer = el("g", {}, viewport);
    const nodeLayer = el("g", {}, viewport);

    for (let k = 1; k <= rings; k++) {
      el("circle", { class: "ring", r: radius[k] }, ringLayer);
      const label = hub ? (k === 1 ? "change" : `d${k - 1}`) : `d${k}`;
      const a = (3 * Math.PI) / 4;
      el(
        "text",
        { class: "ring-label", x: radius[k] * Math.cos(a) + 8, y: radius[k] * Math.sin(a) },
        ringLayer,
      ).textContent = label;
    }

    // Edges: tree edges straight, others gently curved; recursion bows outwards with an arrow.
    const drawn = new Set();
    const edgeEls = [];
    for (const e of g.edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const key = [e.from, e.to].sort().join("\u0000");
      if (drawn.has(key) && !e.recursion) continue;
      drawn.add(key);
      let path;
      let labelAt;
      if (e.recursion) {
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        let nx = -(b.y - a.y) / len;
        let ny = (b.x - a.x) / len;
        if (nx * mx + ny * my < 0) {
          nx = -nx;
          ny = -ny;
        }
        const bow = Math.max(60, len * 0.35);
        const cx = mx + nx * bow;
        const cy = my + ny * bow;
        const [sx, sy] = border(a, cx, cy);
        const [tx, ty] = border(b, cx, cy);
        path = `M${sx},${sy} Q${cx},${cy} ${tx},${ty}`;
        labelAt = [(sx + 2 * cx + tx) / 4, (sy + 2 * cy + ty) / 4];
      } else if (a.parent === b.id || b.parent === a.id) {
        const [sx, sy] = border(a, b.x, b.y);
        const [tx, ty] = border(b, a.x, a.y);
        path = `M${sx},${sy} L${tx},${ty}`;
      } else {
        const cx = ((a.x + b.x) / 2) * 0.82;
        const cy = ((a.y + b.y) / 2) * 0.82;
        const [sx, sy] = border(a, cx, cy);
        const [tx, ty] = border(b, cx, cy);
        path = `M${sx},${sy} Q${cx},${cy} ${tx},${ty}`;
      }
      const p = el("path", { class: `edge${e.recursion ? " recursion" : ""}`, d: path }, edgeLayer);
      if (e.recursion) p.setAttribute("marker-end", "url(#arrow)");
      const item = { e, p };
      if (labelAt) {
        item.t = el("text", { class: "edge-label", x: labelAt[0] + 6, y: labelAt[1] - 6 }, edgeLayer);
        item.t.textContent = "recursion";
      }
      edgeEls.push(item);
    }

    const nodeEls = new Map();
    for (const n of g.nodes) {
      const cls = ["node", n.severity || "", n.changed ? "changed" : "", n.openable ? "openable" : ""];
      const gEl = el("g", { class: cls.filter(Boolean).join(" "), transform: `translate(${n.x},${n.y})` }, nodeLayer);
      gEl.setAttribute("tabindex", "0");
      gEl.setAttribute("role", n.openable ? "button" : "img");
      gEl.setAttribute(
        "aria-label",
        [n.label, caption(n).toLowerCase(), n.severity ? `${n.severity} risk` : "", n.openable ? "open file" : ""]
          .filter(Boolean)
          .join(", "),
      );
      if (n.id === g.center) drawCenter(gEl, n);
      else {
        el("rect", { class: "pill", x: -n.w / 2, y: -PILL_H / 2, width: n.w, height: PILL_H, rx: PILL_H / 2 }, gEl);
        el("circle", { class: "dot", cx: -n.w / 2 + 15, cy: 0, r: 4.5 }, gEl);
        el("text", { class: "label", x: -n.w / 2 + 27, y: 4.5 }, gEl).textContent = n.text;
        if (n.cap)
          el("text", { class: "kind", x: 0, y: -PILL_H / 2 - 6, "text-anchor": "middle" }, gEl).textContent = n.cap;
      }
      nodeEls.set(n.id, gEl);
      const open = () => n.openable && vscode.postMessage({ type: "open", id: n.id });
      gEl.addEventListener("click", (ev) => {
        ev.stopPropagation();
        open();
      });
      gEl.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          open();
        }
      });
      const enter = (ev) => highlight(n, ev);
      gEl.addEventListener("mouseenter", enter);
      gEl.addEventListener("focus", enter);
      gEl.addEventListener("mouseleave", () => highlight());
      gEl.addEventListener("blur", () => highlight());
    }

    function highlight(n, ev) {
      if (!n) {
        for (const g of nodeEls.values()) g.classList.remove("dim", "hover");
        for (const it of edgeEls) {
          it.p.classList.remove("dim");
          it.t?.classList.remove("dim");
        }
        tip.hidden = true;
        return;
      }
      const near = new Set([n.id]);
      for (const it of edgeEls) {
        const on = it.e.from === n.id || it.e.to === n.id;
        if (on) near.add(it.e.from).add(it.e.to);
        it.p.classList.toggle("dim", !on);
        it.t?.classList.toggle("dim", !on);
      }
      for (const [id, g] of nodeEls) {
        g.classList.toggle("dim", !near.has(id));
        g.classList.toggle("hover", id === n.id);
      }
      showTip(n, ev);
    }
    if (!moved) fit();
    else apply();
  }

  function drawCenter(gEl, n) {
    gEl.classList.add("center");
    el("circle", { class: "halo", r: 62 }, gEl);
    el("circle", { class: "halo", r: 52 }, gEl);
    el("circle", { class: "disc", r: 42 }, gEl);
    el("text", { class: "glyph", x: 0, y: 11, "text-anchor": "middle" }, gEl).textContent = "Δ";
    const text = short(n.label, 48);
    const w = widthOf(text, "tag-text") + 26;
    el("rect", { class: "tag", x: -w / 2, y: 58, width: w, height: 26, rx: 5 }, gEl);
    el("text", { class: "tag-text", x: 0, y: 75.5, "text-anchor": "middle" }, gEl).textContent = text;
    const cap = n.id === "hub" ? "" : caption(n);
    if (cap) el("text", { class: "tag-kind", x: 0, y: 100, "text-anchor": "middle" }, gEl).textContent = cap;
    n.w = Math.max(w, 92);
  }

  function showTip(n, ev) {
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    const b = document.createElement("b");
    b.textContent = n.label;
    tip.appendChild(b);
    const meta = document.createElement("div");
    meta.className = "meta";
    const hops = n.depth === 0 ? "the change" : `${n.depth} hop${n.depth === 1 ? "" : "s"} from the change`;
    meta.textContent = [caption(n).toLowerCase(), hops].filter(Boolean).join(" · ");
    tip.appendChild(meta);
    if (n.findings.length) {
      const ul = document.createElement("ul");
      for (const f of n.findings.slice(0, 6)) {
        const li = document.createElement("li");
        li.className = n.severity || "";
        li.textContent = f;
        ul.appendChild(li);
      }
      tip.appendChild(ul);
    }
    if (n.openable) {
      const hint = document.createElement("div");
      hint.className = "meta";
      hint.textContent = "Click to open";
      tip.appendChild(hint);
    }
    tip.hidden = false;
    const box = ev?.target?.getBoundingClientRect?.() ?? { right: 40, top: 40, left: 40 };
    const x = Math.min(box.right + 10, window.innerWidth - tip.offsetWidth - 10);
    tip.style.left = `${Math.max(10, x < box.right ? box.left - tip.offsetWidth - 10 : x)}px`;
    tip.style.top = `${Math.max(56, Math.min(box.top, window.innerHeight - tip.offsetHeight - 10))}px`;
  }

  function renderHeader(meta) {
    $("title").textContent = meta.title || "Blast radius";
    const risk = $("risk");
    risk.hidden = !meta.risk;
    risk.className = `risk ${meta.risk || ""}`;
    risk.textContent = meta.risk ? `${meta.risk} risk` : "";
    $("summary").textContent = meta.summary || "";
    $("omitted").hidden = !graph?.omitted;
    if (graph?.omitted) $("omitted").textContent = `${graph.omitted} more not shown`;
  }

  // Pan and zoom.
  function apply() {
    viewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
  }
  function fit() {
    // Fit the nodes and edges; the outer rings may run off the edges.
    const boxes = [...viewport.children].filter((c) => !c.classList.contains("rings")).map((c) => c.getBBox());
    const x0 = Math.min(...boxes.map((b) => b.x));
    const y0 = Math.min(...boxes.map((b) => b.y));
    const box = {
      x: x0,
      y: y0,
      width: Math.max(...boxes.map((b) => b.x + b.width)) - x0,
      height: Math.max(...boxes.map((b) => b.y + b.height)) - y0,
    };
    const w = svg.clientWidth || 800;
    const h = svg.clientHeight || 600;
    const top = 52;
    const bottom = 36;
    if (!box.width || !box.height) return;
    const k = Math.min(1.4, (w - 40) / box.width, (h - top - bottom - 20) / box.height);
    view = {
      k,
      x: w / 2 - (box.x + box.width / 2) * k,
      y: top + (h - top - bottom) / 2 - (box.y + box.height / 2) * k,
    };
    moved = false;
    apply();
  }
  let pan;
  svg.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || ev.target.closest?.(".node")) return;
    pan = { x: ev.clientX - view.x, y: ev.clientY - view.y, id: ev.pointerId };
    svg.setPointerCapture(ev.pointerId);
    svg.classList.add("panning");
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!pan) return;
    view.x = ev.clientX - pan.x;
    view.y = ev.clientY - pan.y;
    moved = true;
    apply();
  });
  const endPan = () => {
    pan = undefined;
    svg.classList.remove("panning");
  };
  svg.addEventListener("pointerup", endPan);
  svg.addEventListener("pointercancel", endPan);
  svg.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const k = Math.min(3, Math.max(0.2, view.k * Math.exp(-ev.deltaY * 0.0015)));
      const r = svg.getBoundingClientRect();
      const px = ev.clientX - r.left;
      const py = ev.clientY - r.top;
      view.x = px - ((px - view.x) * k) / view.k;
      view.y = py - ((py - view.y) * k) / view.k;
      view.k = k;
      moved = true;
      apply();
    },
    { passive: false },
  );
  svg.addEventListener("dblclick", (ev) => {
    if (!ev.target.closest?.(".node")) fit();
  });
  $("fit").addEventListener("click", fit);
  $("report").addEventListener("click", () => vscode.postMessage({ type: "report" }));
  window.addEventListener("resize", () => {
    if (!moved) fit();
  });

  let lastMeta = {};
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (msg?.type !== "graph") return;
    const sameChange = graph && msg.graph && graph.center === msg.graph.center;
    graph = msg.graph;
    lastMeta = msg.meta || {};
    if (!sameChange) moved = false;
    draw(graph, lastMeta);
  });
  vscode.postMessage({ type: "ready" });
})();
