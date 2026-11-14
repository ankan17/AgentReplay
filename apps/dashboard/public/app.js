// AgentReplay dashboard — vanilla JS, no build step.
// All payload text is inserted via textContent (trace data is untrusted).

const $ = (sel) => document.querySelector(sel);
const api = (path) => fetch(path).then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error)))));
const blobCache = new Map();
const blob = (ref) => {
  const h = typeof ref === "string" ? ref : ref?.blob;
  if (!h) return Promise.resolve(undefined);
  if (!blobCache.has(h)) blobCache.set(h, api(`/api/blobs/${h}`));
  return blobCache.get(h);
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

const keyStr = (k) => `${k.path.join("/")}|${k.target}#${k.index}`;
const short = (v, n = 110) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const badge = (text, cls = text) => el("span", { class: `badge ${cls}` }, text);

let state = { runs: [], current: null, steps: [], selected: null };

// ---------------------------------------------------------------------------
// Runs list
// ---------------------------------------------------------------------------

async function loadRuns() {
  const { dir, runs } = await api("/api/runs");
  state.runs = runs;
  $("#store").textContent = dir;
  const list = $("#runs");
  list.replaceChildren(
    ...runs.map((r) =>
      el("li", { onclick: () => openRun(r.runId), "data-id": r.runId },
        el("div", { class: "run-name" }, el("span", { class: `dot ${r.status}` }), r.name,
          r.replayOf ? badge(r.replayOf.mode, "log") : badge("live")),
        el("div", { class: "run-id" }, r.runId),
      ),
    ),
  );
  const fromHash = location.hash.slice(1);
  if (fromHash && runs.some((r) => r.runId === fromHash)) openRun(fromHash);
  else if (runs[0]) openRun(runs[0].runId);
}

// ---------------------------------------------------------------------------
// Timeline: pair each request with its response + any divergence, by CallKey
// ---------------------------------------------------------------------------

function buildSteps(events) {
  const steps = [];
  const byKey = new Map();
  let start, end;
  for (const e of events) {
    if (e.kind === "run.start") start = e;
    else if (e.kind === "run.end") end = e;
    else if (e.kind === "model.request" || e.kind === "tool.call") {
      const step = { request: e, key: keyStr(e.key) };
      steps.push(step);
      byKey.set(step.key, step);
    } else if (e.kind === "model.response" || e.kind === "tool.result") {
      const s = byKey.get(keyStr(e.key));
      if (s) s.response = e;
    } else if (e.kind === "divergence") {
      const s = byKey.get(keyStr(e.key));
      if (s) s.divergence = e;
    }
  }
  return { steps, start, end };
}

async function openRun(runId) {
  location.hash = runId;
  document.querySelectorAll("#runs li").forEach((li) => li.classList.toggle("active", li.dataset.id === runId));
  const { meta, events } = await api(`/api/runs/${runId}`);
  const { steps, start, end } = buildSteps(events);
  state = { ...state, current: meta, steps, selected: null };
  closeDetail();
  renderHeader(meta, events);
  renderCompare(meta);
  await renderTimeline(steps, start, end);
}

function renderHeader(meta, events) {
  const h = $("#run-header");
  h.classList.remove("empty");
  const ms = meta.endedAt ? new Date(meta.endedAt) - new Date(meta.startedAt) : null;
  h.replaceChildren(
    el("h2", {}, el("span", { class: `dot ${meta.status}` }), " ", meta.name),
    el("div", { class: "meta" },
      el("span", {}, meta.runId),
      el("span", {}, `status: ${meta.status}`),
      ms != null && el("span", {}, `${ms} ms`),
      el("span", {}, `${events.length} events`),
      meta.replayOf && el("span", {}, `${meta.replayOf.mode} replay of `,
        el("a", { href: `#${meta.replayOf.runId}`, onclick: (e) => { e.preventDefault(); openRun(meta.replayOf.runId); } }, meta.replayOf.runId)),
      meta.error && el("span", { class: "minus" }, meta.error.message),
    ),
  );
}

async function stepSummary(step) {
  const { request: rq, response: rs } = step;
  if (rq.kind === "model.request") {
    if (!rs) return "no response";
    const r = await blob(rs.response);
    const calls = r?.message?.toolCalls;
    return calls?.length ? `→ ${calls.map((c) => `${c.name}(${short(c.args, 60)})`).join(", ")}` : `→ ${short(r?.message?.content ?? "")}`;
  }
  const args = await blob(rq.args);
  if (!rs) return `${short(args, 70)} → (no result)`;
  return `${short(args, 60)} → ${rs.ok ? short(await blob(rs.result), 70) : `ERROR ${rs.error}`}`;
}

async function renderTimeline(steps, start, end) {
  const maxLatency = Math.max(1, ...steps.map((s) => s.response?.latencyMs ?? 0));
  const items = await Promise.all(
    steps.map(async (s, i) => {
      const isModel = s.request.kind === "model.request";
      const failed = s.response && s.response.ok === false;
      const latency = s.response?.latencyMs ?? 0;
      return el("li", {
          class: `step${s.divergence ? " diverged" : ""}${failed ? " failed" : ""}`,
          onclick: (ev) => selectStep(i, ev.currentTarget),
        },
        el("div", { class: "num" }, `#${i + 1}`),
        el("div", {},
          el("div", { class: "title" },
            el("span", { class: "kind" }, isModel ? `model ${s.request.modelId}` : `tool ${s.request.tool}`),
            !isModel && s.request.effect === "write" && badge("write"),
            s.response && badge(s.response.source),
            failed && badge("error"),
          ),
          el("div", { class: "summary" }, await stepSummary(s)),
          s.divergence && el("div", { class: "warn" }, `⚠ divergence: ${s.divergence.reason.replace("_", " ")} (recorded seq ${s.divergence.recordedSeq ?? "—"})`),
        ),
        el("div", { class: "timing" }, `${latency} ms`, el("div", { class: "bar", style: `width:${Math.max(2, (latency / maxLatency) * 80)}px` })),
      );
    }),
  );
  const startText = start ? `▶ input ${short(await blob(start.input), 140)}` : "▶ start";
  const endText = end ? `■ ${end.status}${end.error ? `: ${end.error}` : ""}` : "■ (still running or crashed)";
  $("#timeline").replaceChildren(el("li", { class: "edge" }, startText), ...items, el("li", { class: end?.status === "error" ? "edge minus" : "edge" }, endText));
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function pre(value) {
  return el("pre", {}, JSON.stringify(value, null, 2));
}

function messages(list) {
  return el("div", {}, ...list.map((m) =>
    el("div", { class: "msg" },
      el("div", { class: "role" }, m.role + (m.toolCallId ? ` · ${m.toolCallId}` : "")),
      m.content && el("div", { class: "content" }, m.content),
      m.toolCalls?.length && pre(m.toolCalls),
    )));
}

async function selectStep(i, node) {
  document.querySelectorAll(".step").forEach((n) => n.classList.remove("selected"));
  node.classList.add("selected");
  const s = state.steps[i];
  const body = [];
  if (s.request.kind === "model.request") {
    const req = await blob(s.request.request);
    body.push(el("h4", {}, `Context window (${req.messages.length} messages)`), messages(req.messages));
    body.push(el("h4", {}, `Tools available (${req.tools.length})`), el("div", {}, ...req.tools.map((t) => el("div", { class: "summary" }, `${t.name} [${t.effect}] — ${t.description}`))));
    if (req.params) body.push(el("h4", {}, "Params"), pre(req.params));
    if (s.response) body.push(el("h4", {}, `Response [${s.response.source}]`), pre(await blob(s.response.response)));
  } else {
    body.push(el("h4", {}, `Arguments`), pre(await blob(s.request.args)));
    if (s.response) {
      body.push(el("h4", {}, `Result [${s.response.source}]`), s.response.ok ? pre(await blob(s.response.result)) : el("pre", { class: "minus" }, s.response.error));
    }
  }
  if (s.divergence) body.push(el("h4", {}, "Divergence"), pre(s.divergence));
  body.push(el("h4", {}, "Call key"), pre(s.request.key));

  $("#detail-title").textContent = `#${i + 1} ${s.request.kind === "model.request" ? s.request.modelId : s.request.tool}`;
  $("#detail-body").replaceChildren(...body);
  $("#detail").classList.remove("hidden");
}

function closeDetail() {
  $("#detail").classList.add("hidden");
  document.querySelectorAll(".step").forEach((n) => n.classList.remove("selected"));
}

// ---------------------------------------------------------------------------
// Compare two runs: first divergence
// ---------------------------------------------------------------------------

function renderCompare(meta) {
  $("#compare").classList.remove("hidden");
  const sel = $("#compare-select");
  const others = state.runs.filter((r) => r.runId !== meta.runId);
  sel.replaceChildren(el("option", { value: "" }, "—"), ...others.map((r) => el("option", { value: r.runId }, `${r.runId} (${r.status})`)));
  if (meta.replayOf) sel.value = meta.replayOf.runId;
  renderDiff();
}

async function renderDiff() {
  const other = $("#compare-select").value;
  const box = $("#diff");
  if (!other || !state.current) return box.replaceChildren();
  const tools = $("#tools-only").checked ? "&tools=1" : "";
  const { divergence: d } = await api(`/api/diff?a=${other}&b=${state.current.runId}${tools}`);
  if (!d) return box.replaceChildren(el("div", { class: "diff-box same" }, "No divergence — both runs made identical boundary calls."));
  const where = (e) => (e ? `${keyStr(e.key)} (seq ${e.seq})` : "—");
  box.replaceChildren(
    el("div", { class: "diff-box" },
      el("div", {}, `First divergence at boundary call #${d.index + 1}: ${d.reason.replace("_", " ")}`),
      el("div", { class: "diff-row" }, `A (${other}): ${where(d.a)}`),
      el("div", { class: "diff-row" }, `B (this run): ${where(d.b)}`),
      ...d.changes.slice(0, 20).map((c) =>
        el("div", { class: "diff-row" }, c.path,
          el("div", { class: "minus" }, `- ${short(JSON.stringify(c.a), 160)}`),
          el("div", { class: "plus" }, `+ ${short(JSON.stringify(c.b), 160)}`))),
    ),
  );
}

$("#compare-select").addEventListener("change", renderDiff);
$("#tools-only").addEventListener("change", renderDiff);
$("#close").addEventListener("click", closeDetail);
loadRuns().catch((e) => ($("#run-header").textContent = `Failed to load runs: ${e.message}`));
