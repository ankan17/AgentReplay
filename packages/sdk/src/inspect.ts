import type { FileStore } from "./store.ts";
import type { ModelRequestEvent, ToolCallEvent, TraceEvent } from "./schema.ts";
import { keyStr } from "./recorder.ts";
import { viewModelRequest, viewModelResponse, type MessageView } from "./formats.ts";

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

const short = (v: unknown, n = 90) => {
  const s = JSON.stringify(v) ?? "(absent)"; // undefined: a key present on one side only
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

export function formatTimeline(store: FileStore, runId: string): string {
  const meta = store.readMeta(runId);
  const lines = [
    `run ${meta.runId}  "${meta.name}"  status=${meta.status}` +
      (meta.replayOf
        ? `  (${meta.replayOf.mode} replay of ${meta.replayOf.runId}` +
          (meta.replayOf.forkAtSeq !== undefined ? ` at seq ${meta.replayOf.forkAtSeq}` : "") + ")"
        : ""),
  ];
  let step = 0;
  for (const e of store.readEvents(runId)) {
    const p = `  ${String(e.seq).padStart(3)} ${String(e.t).padStart(5)}ms `;
    switch (e.kind) {
      case "run.start":
        lines.push(`${p}▶ input ${short(store.getBlob(e.input))}`);
        break;
      case "model.request": {
        const v = viewModelRequest(e.format, store.getBlob(e.request));
        const note = v.note ? `  (${v.note})` : "";
        lines.push(`${p}[call ${++step}] model ${e.modelId} ← ${v.messages.length} messages${note}`);
        break;
      }
      case "model.response": {
        const v = viewModelResponse(e.format, store.getBlob(e.response));
        const calls = v.toolCalls.map((t) => `${t.name}(${short(t.args, 60)})`).join(", ");
        const note = v.note ? `  (${v.note})` : "";
        lines.push(`${p}         model → ${calls ? `call ${calls}` : short(v.text)}  [${e.source}]${note}`);
        break;
      }
      case "tool.call":
        lines.push(`${p}[call ${++step}] tool ${e.tool} (${e.effect}) ← ${short(store.getBlob(e.args), 70)}`);
        break;
      case "tool.result":
        lines.push(
          `${p}         tool → ${e.ok ? short(store.getBlob(e.result!)) : `ERROR ${e.error}`}  [${e.source}]`,
        );
        break;
      case "divergence":
        lines.push(`${p}⚠ DIVERGENCE ${e.reason} at ${keyStr(e.key)} (recorded seq ${e.recordedSeq ?? "—"})`);
        break;
      case "snapshot":
        break; // shown in the UI later; noisy in a terminal
      case "run.end":
        lines.push(`${p}■ ${e.status}${e.error ? `: ${e.error}` : ""}`);
        break;
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// First divergence between two runs
// ---------------------------------------------------------------------------

type RequestEvent = ModelRequestEvent | ToolCallEvent;
const isRequest = (e: TraceEvent): e is RequestEvent => e.kind === "model.request" || e.kind === "tool.call";

export interface JsonChange {
  path: string;
  a: unknown;
  b: unknown;
}

/** Minimal structural diff — good enough to point at the changed field. */
export function jsonDiff(a: unknown, b: unknown, path = "$", out: JsonChange[] = []): JsonChange[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const sub = Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`;
      jsonDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], sub, out);
    }
    return out;
  }
  out.push({ path, a, b });
  return out;
}

export interface Divergence {
  index: number; // nth boundary call
  a?: RequestEvent;
  b?: RequestEvent;
  reason: "different_target" | "different_request" | "a_ended" | "b_ended";
  /** Raw structural changes between the two stored payloads. */
  changes: JsonChange[];
  /**
   * For model requests: the change in terms of the conversation (which
   * message, which tool, which param), from the payload formatters — so it
   * reads the same whatever integration recorded the runs. Absent for tools.
   */
  summary?: string[];
}

// ---------------------------------------------------------------------------
// Model-request diff in conversation terms
// ---------------------------------------------------------------------------

const clip = (v: unknown, n = 100) => {
  const s = typeof v === "string" ? v : (JSON.stringify(v) ?? "(absent)");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

/** Both texts, clipped to start a little before the first character that differs. */
function textChange(a: string, b: string): [string, string] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  const from = p > 30 ? p - 20 : 0;
  const cut = (t: string) => (from ? "…" : "") + clip(t.slice(from), 100);
  return [cut(a), cut(b)];
}

const label = (m: MessageView, i: number) => `message ${i + 1} (${m.role}${m.toolName ? ` · ${m.toolName}` : ""})`;
const callsText = (m: MessageView) => (m.toolCalls ?? []).map((t) => `${t.name}(${clip(t.args, 60)})`).join(", ");
/** Provider-issued ids differ between any two live runs; compare without them. */
const withoutIds = (m: MessageView) =>
  JSON.stringify({ ...m, toolCallId: undefined, toolCalls: m.toolCalls?.map((t) => ({ name: t.name, args: t.args })) });

export function summarizeModelRequestChange(
  a: { format?: string; payload: unknown },
  b: { format?: string; payload: unknown },
): string[] {
  if ((a.format ?? "chat") !== (b.format ?? "chat")) {
    return [`payload formats differ: ${a.format ?? "chat"} → ${b.format ?? "chat"}`];
  }
  const va = viewModelRequest(a.format, a.payload);
  const vb = viewModelRequest(b.format, b.payload);
  const out: string[] = [];

  if (va.note !== vb.note) out.push(`call type: ${va.note ?? "—"} → ${vb.note ?? "—"}`);

  let idOnly = 0;
  for (let i = 0; i < Math.max(va.messages.length, vb.messages.length); i++) {
    const ma = va.messages[i];
    const mb = vb.messages[i];
    if (!ma) { out.push(`+ ${label(mb, i)}: ${clip(mb.text || callsText(mb))}`); continue; }
    if (!mb) { out.push(`- ${label(ma, i)}: ${clip(ma.text || callsText(ma))}`); continue; }
    if (JSON.stringify(ma) === JSON.stringify(mb)) continue;
    if (withoutIds(ma) === withoutIds(mb)) { idOnly++; continue; }
    if (ma.role !== mb.role || ma.toolName !== mb.toolName) {
      out.push(`${label(ma, i)} → ${label(mb, i)}`);
      continue;
    }
    if (ma.text !== mb.text) {
      const [ta, tb] = textChange(ma.text, mb.text);
      out.push(`${label(ma, i)}: text changed`, `    - ${ta}`, `    + ${tb}`);
    }
    if (callsText(ma) !== callsText(mb)) out.push(`${label(ma, i)}: tool calls changed`, `    - ${callsText(ma) || "(none)"}`, `    + ${callsText(mb) || "(none)"}`);
  }

  const toolsA = new Map(va.tools.map((t) => [t.name, t]));
  const toolsB = new Map(vb.tools.map((t) => [t.name, t]));
  for (const [name] of toolsB) if (!toolsA.has(name)) out.push(`+ tool ${name}`);
  for (const [name, t] of toolsA) {
    if (!toolsB.has(name)) out.push(`- tool ${name}`);
    else if (t.description !== toolsB.get(name)!.description) out.push(`tool ${name}: description changed`);
  }

  for (const c of jsonDiff(va.params ?? {}, vb.params ?? {}, "params")) {
    out.push(`${c.path}: ${clip(c.a, 40)} → ${clip(c.b, 40)}`);
  }

  if (!out.length) {
    return [idOnly
      ? "only provider-issued ids differ (e.g. tool call ids) — expected between two live runs"
      : "no difference in messages, tools or params; see raw changes (likely provider options or schemas)"];
  }
  if (idOnly) out.push(`(${idOnly} other message${idOnly > 1 ? "s" : ""} differ only in provider-issued ids)`);
  return out;
}

export function firstDivergence(
  store: FileStore,
  runA: string,
  runB: string,
  opts: { toolsOnly?: boolean } = {},
): Divergence | null {
  const keep = (e: TraceEvent): e is RequestEvent => isRequest(e) && (!opts.toolsOnly || e.kind === "tool.call");
  const a = store.readEvents(runA).filter(keep);
  const b = store.readEvents(runB).filter(keep);
  const blob = (e: RequestEvent) => store.getBlob(e.kind === "model.request" ? e.request : e.args);

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ea = a[i];
    const eb = b[i];
    if (!ea) return { index: i, b: eb, reason: "a_ended", changes: [] };
    if (!eb) return { index: i, a: ea, reason: "b_ended", changes: [] };
    if (ea.key.target !== eb.key.target) {
      return { index: i, a: ea, b: eb, reason: "different_target", changes: [] };
    }
    if (ea.key.requestHash !== eb.key.requestHash) {
      const d: Divergence = { index: i, a: ea, b: eb, reason: "different_request", changes: jsonDiff(blob(ea), blob(eb)) };
      if (ea.kind === "model.request" && eb.kind === "model.request") {
        d.summary = summarizeModelRequestChange(
          { format: ea.format, payload: blob(ea) },
          { format: eb.format, payload: blob(eb) },
        );
      }
      return d;
    }
  }
  return null;
}

export function formatDivergence(d: Divergence | null): string {
  if (!d) return "No divergence: both runs made identical boundary calls.";
  const where = (e?: RequestEvent) => (e ? `${keyStr(e.key)} (seq ${e.seq})` : "—");
  const lines = [`First divergence at boundary call #${d.index + 1}: ${d.reason}`, `  A: ${where(d.a)}`, `  B: ${where(d.b)}`];
  const maxRaw = d.summary ? 6 : 12;
  if (d.summary) {
    for (const line of d.summary) lines.push(`  ${line}`);
    if (d.changes.length) lines.push(`  raw changes:`);
  }
  for (const c of d.changes.slice(0, maxRaw)) {
    lines.push(`  ${c.path}\n    - ${short(c.a, 110)}\n    + ${short(c.b, 110)}`);
  }
  if (d.changes.length > maxRaw) lines.push(`  … ${d.changes.length - maxRaw} more changes`);
  return lines.join("\n");
}
