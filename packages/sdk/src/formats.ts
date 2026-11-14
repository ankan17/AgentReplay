/**
 * Model payload formats.
 *
 * The recorder stores model requests/responses exactly as the integration
 * produced them (needed for faithful replay), so their shape depends on
 * where they came from: `wrapModel` stores `ChatRequest`/`ChatResponse`,
 * the AI SDK adapter stores LanguageModelV4 call options and results.
 * Each `model.request` / `model.response` event names its `format`; viewers
 * (CLI timeline, dashboard) turn a payload into a common `ModelRequestView` /
 * `ModelResponseView` through the formatter registered for that name.
 *
 * Formatters are pure data parsers with no framework dependency, so a viewer
 * can read any trace store without the adapter that produced it installed.
 * Payloads are untrusted input: a formatter that throws falls back to raw.
 */
import type { ChatRequest, ChatResponse } from "./schema.ts";

export const CHAT_FORMAT = "chat";
export const AI_SDK_V4_FORMAT = "ai-sdk/v4";

export interface ToolCallView {
  id?: string;
  name: string;
  args: unknown;
}

export interface MessageView {
  role: string;
  text: string;
  toolCalls?: ToolCallView[];
  /** Set on tool-result messages. */
  toolCallId?: string;
  toolName?: string;
}

export interface ModelRequestView {
  messages: MessageView[];
  tools: { name: string; description?: string; effect?: string }[];
  params?: Record<string, unknown>;
  /** Formatter-specific one-liner, e.g. "stream". */
  note?: string;
}

export interface ModelResponseView {
  text: string;
  toolCalls: ToolCallView[];
  finishReason?: string;
  usage?: unknown;
  note?: string;
}

export interface ModelFormat {
  request(payload: unknown): ModelRequestView;
  response(payload: unknown): ModelResponseView;
}

const formats = new Map<string, ModelFormat>();

/** Register a formatter for a payload format name (e.g. from a third-party adapter). */
export function registerModelFormat(name: string, format: ModelFormat): void {
  formats.set(name, format);
}

/** `format` absent = traces written before formats existed = "chat". */
export function viewModelRequest(format: string | undefined, payload: unknown): ModelRequestView {
  const f = formats.get(format ?? CHAT_FORMAT);
  try {
    if (f) return f.request(payload);
  } catch {
    /* fall through to raw */
  }
  return { messages: [], tools: [], note: unknownNote(format) };
}

export function viewModelResponse(format: string | undefined, payload: unknown): ModelResponseView {
  const f = formats.get(format ?? CHAT_FORMAT);
  try {
    if (f) return f.response(payload);
  } catch {
    /* fall through to raw */
  }
  return { text: "", toolCalls: [], note: unknownNote(format) };
}

const unknownNote = (format: string | undefined) =>
  formats.has(format ?? CHAT_FORMAT)
    ? `payload doesn't match format "${format ?? CHAT_FORMAT}"; showing raw only`
    : `unknown payload format "${format}"; showing raw only`;

// ---------------------------------------------------------------------------
// "chat" — the core ChatRequest / ChatResponse shape
// ---------------------------------------------------------------------------

registerModelFormat(CHAT_FORMAT, {
  request(payload) {
    const req = payload as ChatRequest;
    if (!Array.isArray(req.messages)) throw new Error("not a ChatRequest");
    return {
      messages: req.messages.map((m) => ({
        role: m.role,
        text: m.content ?? "",
        toolCalls: m.toolCalls?.map((t) => ({ id: t.id, name: t.name, args: t.args })),
        toolCallId: m.toolCallId,
      })),
      tools: (req.tools ?? []).map((t) => ({ name: t.name, description: t.description, effect: t.effect })),
      params: req.params,
    };
  },
  response(payload) {
    const res = payload as ChatResponse;
    if (!res.message) throw new Error("not a ChatResponse");
    return {
      text: res.message.content ?? "",
      toolCalls: (res.message.toolCalls ?? []).map((t) => ({ id: t.id, name: t.name, args: t.args })),
      finishReason: res.finishReason,
      usage: res.usage,
    };
  },
});

// ---------------------------------------------------------------------------
// "ai-sdk/v4" — Vercel AI SDK LanguageModelV4 (ai@7), as stored by
// @agentreplay/ai-sdk. Typed loosely on purpose: this parses stored JSON.
// ---------------------------------------------------------------------------

type Part = { type: string; [k: string]: any };

/** Tool inputs are JSON strings in results and stream parts, objects in prompts. */
const parseInput = (input: unknown) => {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
};

const toolCall = (p: Part): ToolCallView => ({ id: p.toolCallId, name: p.toolName, args: parseInput(p.input) });

function toolOutputText(output: Part | undefined): string {
  if (!output) return "";
  switch (output.type) {
    case "text":
    case "error-text":
      return (output.type === "error-text" ? "ERROR " : "") + output.value;
    case "json":
    case "error-json":
      return (output.type === "error-json" ? "ERROR " : "") + JSON.stringify(output.value);
    case "execution-denied":
      return `execution denied${output.reason ? `: ${output.reason}` : ""}`;
    case "content":
      return (output.value as Part[]).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("");
    default:
      return JSON.stringify(output);
  }
}

/** Text of non-tool parts; files and other media shown as placeholders. */
function partsText(parts: Part[]): string {
  return parts
    .map((p) => {
      if (p.type === "text") return p.text;
      if (p.type === "reasoning") return `[reasoning] ${p.text}`;
      if (p.type === "file") return `[file ${p.mediaType ?? ""}${p.filename ? ` ${p.filename}` : ""}]`;
      return p.type === "tool-call" || p.type === "tool-result" ? "" : `[${p.type}]`;
    })
    .filter(Boolean)
    .join("\n");
}

function aiSdkMessages(prompt: { role: string; content: string | Part[] }[]): MessageView[] {
  const out: MessageView[] = [];
  for (const m of prompt) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, text: m.content });
      continue;
    }
    const results = m.content.filter((p) => p.type === "tool-result");
    const calls = m.content.filter((p) => p.type === "tool-call").map(toolCall);
    const text = partsText(m.content);
    if (m.role !== "tool" || text) out.push({ role: m.role, text, toolCalls: calls.length ? calls : undefined });
    // One view per tool result, like the chat format's role:"tool" messages.
    for (const r of results) {
      out.push({ role: "tool", text: toolOutputText(r.output), toolCallId: r.toolCallId, toolName: r.toolName });
    }
  }
  return out;
}

function finishReasonOf(fr: unknown): string | undefined {
  if (!fr) return undefined;
  if (typeof fr === "string") return fr;
  const { unified, raw } = fr as { unified?: string; raw?: string };
  return raw && raw !== unified ? `${unified} (${raw})` : unified;
}

registerModelFormat(AI_SDK_V4_FORMAT, {
  request(payload) {
    // Shown params are the sampling knobs; transport/config flags stay in the raw view.
    const { mode, prompt, tools, toolChoice: _tc, providerOptions: _po, responseFormat: _rf, includeRawChunks: _rc, ...params } =
      payload as { mode?: string; prompt: { role: string; content: string | Part[] }[]; tools?: Part[]; [k: string]: unknown };
    if (!Array.isArray(prompt)) throw new Error("not an AI SDK request");
    return {
      messages: aiSdkMessages(prompt),
      tools: (tools ?? []).map((t) =>
        t.type === "provider" ? { name: t.name, description: `provider tool ${t.id}` } : { name: t.name, description: t.description },
      ),
      params: Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)),
      note: mode,
    };
  },
  response(payload) {
    const p = payload as { content?: Part[]; parts?: Part[]; complete?: boolean; finishReason?: unknown; usage?: unknown };
    if (Array.isArray(p.content)) {
      // generate: { content, finishReason, usage, ... }
      return {
        text: partsText(p.content),
        toolCalls: p.content.filter((c) => c.type === "tool-call").map(toolCall),
        finishReason: finishReasonOf(p.finishReason),
        usage: p.usage,
      };
    }
    if (Array.isArray(p.parts)) {
      // stream: { parts, complete } — reassemble from the chunks
      let text = "";
      const toolCalls: ToolCallView[] = [];
      let finish: Part | undefined;
      const errors: string[] = [];
      for (const c of p.parts) {
        if (c.type === "text-delta") text += c.delta;
        else if (c.type === "tool-call") toolCalls.push(toolCall(c));
        else if (c.type === "finish") finish = c;
        else if (c.type === "error") errors.push(c.error?.message ?? JSON.stringify(c.error));
      }
      const notes = [`stream, ${p.parts.length} chunks`];
      if (!p.complete) notes.push("incomplete (cancelled or errored)");
      if (errors.length) notes.push(`error: ${errors.join("; ")}`);
      return { text, toolCalls, finishReason: finishReasonOf(finish?.finishReason), usage: finish?.usage, note: notes.join(", ") };
    }
    throw new Error("not an AI SDK response");
  },
});
