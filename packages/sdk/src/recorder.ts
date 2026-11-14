import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { hashValue } from "./hash.ts";
import { FileStore } from "./store.ts";
import { CHAT_FORMAT } from "./formats.ts";
import {
  SCHEMA_VERSION,
  type CallKey,
  type ChatModel,
  type ChatRequest,
  type ChatResponse,
  type ModelRequestEvent,
  type ReplayMode,
  type RunMeta,
  type ToolCallEvent,
  type ToolEffect,
  type ToolResultEvent,
  type ModelResponseEvent,
  type ToolSpec,
  type TraceEvent,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Context propagation
// ---------------------------------------------------------------------------

interface RunState {
  meta: RunMeta;
  store: FileStore;
  startMs: number;
  seq: number;
  callCounters: Map<string, number>;
  replay?: ReplaySource;
  /**
   * First strict-mode divergence. Kept on the run so the run still fails if
   * agent code — or a framework, e.g. AI SDK `streamText`, which routes
   * errors to `onError` — catches the thrown DivergenceError.
   */
  divergence?: DivergenceError;
}

interface Ctx {
  run: RunState;
  stack: { id: string; name: string }[];
}

const als = new AsyncLocalStorage<Ctx>();

function ctx(): Ctx | undefined {
  return als.getStore();
}

type EventBody<E> = E extends TraceEvent ? Omit<E, "runId" | "seq" | "t" | "spanId" | "parentSpanId"> : never;

function emit(c: Ctx, body: EventBody<TraceEvent>): TraceEvent {
  const top = c.stack[c.stack.length - 1];
  const parent = c.stack[c.stack.length - 2];
  const event = {
    ...body,
    runId: c.run.meta.runId,
    seq: c.run.seq++,
    t: Date.now() - c.run.startMs,
    spanId: top?.id ?? "root",
    parentSpanId: parent?.id ?? null,
  } as TraceEvent;
  c.run.store.appendEvent(event);
  return event;
}

function nextKey(c: Ctx, target: string, request: unknown): CallKey {
  const path = c.stack.map((s) => s.name);
  const counterKey = `${path.join("/")}|${target}`;
  const index = c.run.callCounters.get(counterKey) ?? 0;
  c.run.callCounters.set(counterKey, index + 1);
  return { path, target, index, requestHash: hashValue(request) };
}

/** Run `fn` inside a named child span. Span names form the replay call path. */
export function span<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const c = ctx();
  if (!c) return fn();
  return als.run({ run: c.run, stack: [...c.stack, { id: randomUUID().slice(0, 8), name }] }, fn);
}

/** Record a labelled snapshot of agent state (e.g. the message list). */
export function snapshot(label: string, state: unknown): void {
  const c = ctx();
  if (c) emit(c, { kind: "snapshot", label, state: c.run.store.putBlob(state) });
}

// ---------------------------------------------------------------------------
// Replay source
// ---------------------------------------------------------------------------

export class DivergenceError extends Error {
  readonly key: CallKey;
  readonly expectedHash: string | null;
  readonly recordedSeq: number | null;
  constructor(message: string, key: CallKey, expectedHash: string | null, recordedSeq: number | null) {
    super(message);
    this.name = "DivergenceError";
    this.key = key;
    this.expectedHash = expectedHash;
    this.recordedSeq = recordedSeq;
  }
}

interface RecordedCall {
  request: ModelRequestEvent | ToolCallEvent;
  response?: ModelResponseEvent | ToolResultEvent;
}

export interface ReplayOptions {
  sourceRunId: string;
  /**
   * strict  every call served from the log; any divergence throws.
   * fork    calls recorded before `forkAtSeq` come from the log (a mismatch there is a
   *         divergence, recorded, then live); from the first call at/after `forkAtSeq`
   *         — or once the pre-fork calls are used up — everything is live. Write tools
   *         that go live still obey `writePolicy`.
   * hybrid  model calls go live, tool calls come from the log when they match.
   */
  mode: ReplayMode;
  forkAtSeq?: number;
  /**
   * What happens when a `write` tool would execute live during a replay:
   * block (default) → throw; stub → return { stubbed: true } without executing;
   * allow → really execute it.
   */
  writePolicy?: "block" | "stub" | "allow";
}

export const keyStr = (k: Pick<CallKey, "path" | "target" | "index">) =>
  `${k.path.join("/")}|${k.target}#${k.index}`;

type Resolution =
  | { action: "log"; response: NonNullable<RecordedCall["response"]> }
  | { action: "live" }
  | { action: "diverged"; reason: "missing" | "request_changed"; recorded?: RecordedCall };

export class ReplaySource {
  readonly opts: ReplayOptions;
  private calls = new Map<string, RecordedCall>();
  /** Fork mode: recorded calls before the fork point not yet replayed. */
  private preForkRemaining = 0;
  /** Fork mode: the run has reached the fork point and is running live. */
  private forked = false;

  constructor(store: FileStore, opts: ReplayOptions) {
    this.opts = opts;
    if (opts.mode === "fork" && opts.forkAtSeq !== undefined && !(Number.isInteger(opts.forkAtSeq) && opts.forkAtSeq >= 0)) {
      throw new Error(`forkAtSeq must be a non-negative integer, got ${opts.forkAtSeq}`);
    }
    for (const e of store.readEvents(opts.sourceRunId)) {
      if (e.kind === "model.request" || e.kind === "tool.call") {
        this.calls.set(keyStr(e.key), { request: e });
        if (e.seq < (opts.forkAtSeq ?? Infinity)) this.preForkRemaining++;
      } else if (e.kind === "model.response" || e.kind === "tool.result") {
        const rec = this.calls.get(keyStr(e.key));
        if (rec && e.source !== "blocked") rec.response = e;
      }
    }
  }

  resolve(key: CallKey): Resolution {
    const { mode, forkAtSeq = Infinity } = this.opts;
    const rec = this.calls.get(keyStr(key));

    if (mode === "hybrid" && key.target.startsWith("model:")) return { action: "live" };
    if (mode === "fork") {
      // From the fork point on everything is live, including calls the
      // recording never made — taking a new path is the point of a fork,
      // so those are not divergences.
      if (rec && rec.request.seq >= forkAtSeq) this.forked = true;
      if (this.forked || (!rec && this.preForkRemaining === 0)) {
        this.forked = true;
        return { action: "live" };
      }
      if (rec) this.preForkRemaining--;
    }

    if (!rec || !rec.response) return { action: "diverged", reason: "missing", recorded: rec };
    if (rec.request.key.requestHash !== key.requestHash) {
      return { action: "diverged", reason: "request_changed", recorded: rec };
    }
    return { action: "log", response: rec.response };
  }
}

/**
 * Shared replay decision for both wrappers. Returns the recorded response to
 * serve, or null to execute live. Emits a divergence event when needed and
 * throws in strict mode.
 */
function replayDecision(c: Ctx, key: CallKey) {
  const replay = c.run.replay;
  if (!replay) return null;
  const r = replay.resolve(key);
  if (r.action === "log") return r.response;
  if (r.action === "live") return null;

  emit(c, {
    kind: "divergence", key, reason: r.reason,
    recordedSeq: r.recorded?.request.seq ?? null,
    recordedRequestHash: r.recorded?.request.key.requestHash ?? null,
  });
  if (replay.opts.mode === "strict") {
    const err = new DivergenceError(
      r.reason === "missing"
        ? `No recorded call for ${keyStr(key)} — the agent took a path the original run never took.`
        : `Request for ${keyStr(key)} differs from the recording (seq ${r.recorded!.request.seq}).`,
      key, r.recorded?.request.key.requestHash ?? null, r.recorded?.request.seq ?? null,
    );
    c.run.divergence ??= err;
    throw err;
  }
  return null; // non-strict: record the divergence and continue live
}

// ---------------------------------------------------------------------------
// Boundary wrappers
// ---------------------------------------------------------------------------

export interface WrappedTool<A, R, X extends unknown[] = []> {
  (args: A, ...extra: X): Promise<R>;
  spec: ToolSpec;
}

/**
 * Wrap a tool so every call is recorded and replayable. Only `args` is
 * recorded and hashed; any `extra` arguments (call ids, abort signals,
 * framework context) are passed through to `fn` untouched.
 */
export function wrapTool<A, R, X extends unknown[] = []>(
  spec: Omit<ToolSpec, "effect"> & { effect: ToolEffect },
  fn: (args: A, ...extra: X) => Promise<R>,
): WrappedTool<A, R, X> {
  const target = `tool:${spec.name}`;

  const wrapped = async (args: A, ...extra: X): Promise<R> => {
    const c = ctx();
    if (!c) return fn(args, ...extra); // not inside a run → plain call

    const key = nextKey(c, target, args);
    const store = c.run.store;
    emit(c, { kind: "tool.call", key, tool: spec.name, effect: spec.effect, args: store.putBlob(args) });

    const recorded = replayDecision(c, key) as ToolResultEvent | null;
    if (recorded) {
      emit(c, {
        kind: "tool.result", key, ok: recorded.ok, result: recorded.result,
        error: recorded.error, latencyMs: 0, source: "log",
      });
      if (!recorded.ok) throw new Error(recorded.error);
      return store.getBlob<R>(recorded.result!);
    }

    // Live execution of a write tool during replay is governed by writePolicy.
    const policy = c.run.replay?.opts.writePolicy ?? "block";
    if (c.run.replay && spec.effect === "write" && policy !== "allow") {
      if (policy === "stub") {
        const result = { stubbed: true, tool: spec.name, args } as R;
        emit(c, { kind: "tool.result", key, ok: true, result: store.putBlob(result), latencyMs: 0, source: "stubbed" });
        return result;
      }
      const error = `Blocked live execution of write tool "${spec.name}" during replay (writePolicy: "stub" or "allow" to change).`;
      emit(c, { kind: "tool.result", key, ok: false, error, latencyMs: 0, source: "blocked" });
      throw new Error(error);
    }

    const t0 = performance.now();
    try {
      const result = await fn(args, ...extra);
      emit(c, {
        kind: "tool.result", key, ok: true, result: store.putBlob(result),
        latencyMs: Math.round(performance.now() - t0), source: "live",
      });
      return result;
    } catch (err) {
      emit(c, {
        kind: "tool.result", key, ok: false, error: (err as Error).message,
        latencyMs: Math.round(performance.now() - t0), source: "live",
      });
      throw err;
    }
  };

  wrapped.spec = spec;
  return wrapped;
}

/**
 * Handle for one in-flight model call, returned by `beginModelCall`.
 * Adapters (e.g. `@agentreplay/ai-sdk`) build on this instead of `ChatModel`.
 */
export interface ModelCall<Res> {
  /** Set when replay serves this call from the log; the caller must not go live. */
  readonly recorded: Res | null;
  /** Record the live response. Call once, and only when `recorded` is null. */
  finish(response: Res): void;
}

/**
 * Low-level model boundary. Emits `model.request`, consults the replay source,
 * and returns a handle that records the response later — so a streamed
 * response can be recorded when the stream ends, not when the call returns.
 *
 * `request` is stored verbatim; `hashInput` (default: `request`) is what the
 * CallKey hashes, so adapters can keep transport noise out of matching.
 * `format` names the payload shape for viewers (default "chat"; see formats.ts).
 * Returns null outside a run.
 */
export function beginModelCall<Res>(
  modelId: string,
  request: unknown,
  opts: { hashInput?: unknown; format?: string } = {},
): ModelCall<Res> | null {
  const c = ctx();
  if (!c) return null;

  const key = nextKey(c, `model:${modelId}`, "hashInput" in opts ? opts.hashInput : request);
  const store = c.run.store;
  const format = opts.format ?? CHAT_FORMAT;
  emit(c, { kind: "model.request", key, modelId, request: store.putBlob(request), format });

  const recorded = replayDecision(c, key) as ModelResponseEvent | null;
  if (recorded) {
    emit(c, {
      kind: "model.response", key, response: recorded.response,
      format: recorded.format ?? CHAT_FORMAT, latencyMs: 0, source: "log",
    });
    return { recorded: store.getBlob<Res>(recorded.response), finish: () => {} };
  }

  const t0 = performance.now();
  let done = false;
  return {
    recorded: null,
    finish(response: Res) {
      if (done) throw new Error(`model call ${keyStr(key)} already finished`);
      done = true;
      emit(c, {
        kind: "model.response", key, response: store.putBlob(response), format,
        latencyMs: Math.round(performance.now() - t0), source: "live",
      });
    },
  };
}

export function wrapModel(model: ChatModel): ChatModel {
  return {
    id: model.id,
    async generate(req: ChatRequest): Promise<ChatResponse> {
      const call = beginModelCall<ChatResponse>(model.id, req);
      if (!call) return model.generate(req);
      if (call.recorded) return call.recorded;
      const res = await model.generate(req);
      call.finish(res);
      return res;
    },
  };
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export interface RunOptions {
  store?: FileStore;
  replay?: ReplayOptions;
  models?: ChatModel[];
  tools?: { spec: ToolSpec }[];
}

export interface RunResult<T> {
  runId: string;
  status: "ok" | "error";
  output?: T;
  error?: Error;
}

export async function startRun<I, T>(
  name: string,
  input: I,
  fn: (input: I) => Promise<T>,
  opts: RunOptions = {},
): Promise<RunResult<T>> {
  const store = opts.store ?? new FileStore();
  // Validate replay options (and read the source run) before anything is written,
  // so a bad replay request doesn't leave a "running" run behind in the store.
  const replay = opts.replay ? new ReplaySource(store, opts.replay) : undefined;
  const runId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;

  const meta: RunMeta = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    name,
    startedAt: new Date().toISOString(),
    status: "running",
    replayOf: opts.replay
      ? { runId: opts.replay.sourceRunId, mode: opts.replay.mode, forkAtSeq: opts.replay.forkAtSeq }
      : undefined,
    versions: {
      models: Object.fromEntries((opts.models ?? []).map((m) => [m.id, hashValue(m.id)])),
      tools: Object.fromEntries((opts.tools ?? []).map((t) => [t.spec.name, hashValue(t.spec)])),
    },
  };
  store.writeMeta(meta);

  const run: RunState = {
    meta, store, startMs: Date.now(), seq: 0, callCounters: new Map(),
    replay,
  };
  const root: Ctx = { run, stack: [{ id: "root", name }] };

  return als.run(root, async () => {
    emit(root, { kind: "run.start", input: store.putBlob(input) });
    try {
      const output = await fn(input);
      if (run.divergence) throw run.divergence; // swallowed somewhere inside fn
      emit(root, { kind: "run.end", status: "ok", output: store.putBlob(output) });
      store.writeMeta({ ...meta, status: "ok", endedAt: new Date().toISOString() });
      return { runId, status: "ok", output };
    } catch (err) {
      const e = err as Error;
      emit(root, { kind: "run.end", status: "error", error: e.message });
      store.writeMeta({
        ...meta, status: "error", endedAt: new Date().toISOString(),
        error: { message: e.message, atSeq: run.seq - 1 },
      });
      return { runId, status: "error", error: e };
    }
  });
}
