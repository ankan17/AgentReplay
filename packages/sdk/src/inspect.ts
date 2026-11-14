import type { FileStore } from "./store.ts";
import type { ModelRequestEvent, ToolCallEvent, TraceEvent } from "./schema.ts";
import { keyStr } from "./recorder.ts";
import { viewModelRequest, viewModelResponse } from "./formats.ts";

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

const short = (v: unknown, n = 90) => {
  const s = JSON.stringify(v);
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
  changes: JsonChange[];
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
      return { index: i, a: ea, b: eb, reason: "different_request", changes: jsonDiff(blob(ea), blob(eb)) };
    }
  }
  return null;
}

export function formatDivergence(d: Divergence | null): string {
  if (!d) return "No divergence: both runs made identical boundary calls.";
  const where = (e?: RequestEvent) => (e ? `${keyStr(e.key)} (seq ${e.seq})` : "—");
  const lines = [`First divergence at boundary call #${d.index + 1}: ${d.reason}`, `  A: ${where(d.a)}`, `  B: ${where(d.b)}`];
  for (const c of d.changes.slice(0, 12)) {
    lines.push(`  ${c.path}\n    - ${short(c.a, 110)}\n    + ${short(c.b, 110)}`);
  }
  if (d.changes.length > 12) lines.push(`  … ${d.changes.length - 12} more changes`);
  return lines.join("\n");
}
