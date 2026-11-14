/**
 * Trace event schema — v0.
 *
 * A run is an append-only log of events. Every value that crosses a
 * nondeterministic boundary (model, tool, clock, random) is an event.
 * Large payloads live in a content-addressed blob store and are referenced
 * by hash, so repeated system prompts / contexts deduplicate for free.
 */

export const SCHEMA_VERSION = 1;

/** sha256 hex of the canonical JSON of a payload. */
export type BlobHash = string;

export interface BlobRef {
  blob: BlobHash;
  bytes: number;
}

/** How a tool interacts with the world. Drives replay safety. */
export type ToolEffect =
  | "pure" // deterministic, no I/O — safe to re-execute
  | "read" // reads external state — re-executing may return different data
  | "write"; // mutates external state — NEVER re-executed during replay

export type RunStatus = "running" | "ok" | "error";

export interface RunMeta {
  schemaVersion: number;
  runId: string;
  name: string;
  startedAt: string; // ISO
  endedAt?: string;
  status: RunStatus;
  /** Set when this run was produced by replaying / forking another run. */
  replayOf?: { runId: string; mode: ReplayMode; forkAtSeq?: number };
  /** Version fingerprints — compared first when diffing two runs. */
  versions: {
    models: Record<string, string>; // modelId -> config hash
    tools: Record<string, string>; // toolName -> schema/effect hash
  };
  error?: { message: string; atSeq?: number };
}

export type ReplayMode = "strict" | "fork" | "hybrid";

/** Common header on every event. */
interface EventBase {
  runId: string;
  /** Monotonic per-run sequence number. Total order of the log. */
  seq: number;
  /** Milliseconds since run start (wall clock, informational only). */
  t: number;
  spanId: string;
  parentSpanId: string | null;
}

/**
 * Identifies a boundary call independently of wall-clock and ids.
 * `path` = names of enclosing spans, `index` = nth call to the same
 * target under that path. Replay matches on (path, target, index) and then
 * compares `requestHash` to detect divergence.
 */
export interface CallKey {
  path: string[];
  target: string; // "model:<id>" | "tool:<name>"
  index: number;
  requestHash: BlobHash;
}

export interface RunStartEvent extends EventBase {
  kind: "run.start";
  input: BlobRef;
}

export interface RunEndEvent extends EventBase {
  kind: "run.end";
  status: Exclude<RunStatus, "running">;
  output?: BlobRef;
  error?: string;
}

export interface ModelRequestEvent extends EventBase {
  kind: "model.request";
  key: CallKey;
  modelId: string;
  request: BlobRef; // messages + tool specs + params
}

export interface ModelResponseEvent extends EventBase {
  kind: "model.response";
  key: CallKey;
  response: BlobRef;
  latencyMs: number;
  /** "live" = real call, "log" = served from a recorded run. */
  source: "live" | "log";
}

export interface ToolCallEvent extends EventBase {
  kind: "tool.call";
  key: CallKey;
  tool: string;
  effect: ToolEffect;
  args: BlobRef;
}

export interface ToolResultEvent extends EventBase {
  kind: "tool.result";
  key: CallKey;
  ok: boolean;
  result?: BlobRef;
  error?: string;
  latencyMs: number;
  source: "live" | "log" | "blocked" | "stubbed";
}

/** Point-in-time snapshot of agent state (messages, memory, scratchpad). */
export interface SnapshotEvent extends EventBase {
  kind: "snapshot";
  label: string;
  state: BlobRef;
}

/** Emitted during replay when the agent asks for something the recording didn't. */
export interface DivergenceEvent extends EventBase {
  kind: "divergence";
  key: CallKey;
  reason: "missing" | "request_changed";
  recordedSeq: number | null;
  recordedRequestHash: BlobHash | null;
}

export type TraceEvent =
  | RunStartEvent
  | RunEndEvent
  | ModelRequestEvent
  | ModelResponseEvent
  | ToolCallEvent
  | ToolResultEvent
  | SnapshotEvent
  | DivergenceEvent;

// ---------------------------------------------------------------------------
// Minimal provider-neutral model shape. Adapters (Vercel AI SDK, OpenAI,
// Anthropic) translate to/from this so the recorder stays framework-agnostic.
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCallRequest[];
  toolCallId?: string;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  effect: ToolEffect;
  parameters: Record<string, unknown>; // JSON schema
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  params?: { temperature?: number; maxTokens?: number };
}

export interface ChatResponse {
  message: ChatMessage;
  finishReason: "stop" | "tool_calls" | "length" | "error";
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ChatModel {
  id: string;
  generate(req: ChatRequest): Promise<ChatResponse>;
}
