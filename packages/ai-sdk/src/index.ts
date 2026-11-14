/**
 * Vercel AI SDK adapter for AgentReplay (targets `ai@7`, LanguageModelV4).
 *
 *   const model = recordedModel(openai("gpt-5"));
 *   const tools = recordedTools({ lookupOrder, refund }, { effects: { lookupOrder: "read", refund: "write" } });
 *   await startRun("agent", input, (i) => generateText({ model, tools, prompt: i.request, stopWhen: stepCountIs(8) }));
 *
 * Why middleware and not a wrapper around generateText/streamText:
 * `generateText` with `stopWhen` runs a multi-step model→tools loop
 * internally. The middleware sees each *step* as its own `doGenerate` /
 * `doStream`, which is exactly one CallKey per model call — the same
 * granularity the recorder already uses. The loop itself is deterministic
 * given the model and tool outputs, so it needs no recording.
 */
import { wrapLanguageModel } from "ai";
import type { LanguageModel, LanguageModelMiddleware, Tool, ToolSet } from "ai";
import { AI_SDK_V4_FORMAT, beginModelCall, wrapTool, type ToolEffect } from "agentreplay";

// Provider spec types, derived from the public middleware type so we don't
// need a direct dependency on @ai-sdk/provider.
type WrapGenerate = NonNullable<LanguageModelMiddleware["wrapGenerate"]>;
type WrapStream = NonNullable<LanguageModelMiddleware["wrapStream"]>;
type CallOptions = Parameters<WrapGenerate>[0]["params"];
type GenerateResult = Awaited<ReturnType<WrapGenerate>>;
type StreamResult = Awaited<ReturnType<WrapStream>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

// ---------------------------------------------------------------------------
// Model middleware
// ---------------------------------------------------------------------------

/**
 * What gets stored and hashed for a model call.
 *
 * Dropped entirely: `abortSignal` (not data) and `headers` (transport, and
 * the most likely place for credentials to leak into a trace).
 * `mode` is part of the hash: a recording made with generateText does not
 * silently serve a streamText call — that shows up as a divergence.
 */
function requestOf(mode: "generate" | "stream", params: CallOptions) {
  const { abortSignal: _a, headers: _h, ...rest } = params;
  return { mode, ...rest };
}

/** Recorded generate result: provider transport details stripped. */
function storableResult(r: GenerateResult): GenerateResult {
  const { request: _req, response, ...rest } = r;
  if (!response) return rest;
  const { headers: _h, body: _b, ...meta } = response;
  return { ...rest, response: meta };
}

/** JSON turns Dates into strings; the AI SDK expects `response.timestamp` to be a Date. */
function reviveTimestamp<T extends { timestamp?: unknown }>(x: T): T {
  return typeof x.timestamp === "string" ? { ...x, timestamp: new Date(x.timestamp) } : x;
}

function reviveResult(r: GenerateResult): GenerateResult {
  return r.response ? { ...r, response: reviveTimestamp(r.response) } : r;
}

/** Errors don't survive JSON either; store the message. */
function storablePart(p: StreamPart): StreamPart {
  if (p.type === "error") {
    const e = p.error;
    return { type: "error", error: e instanceof Error ? { name: e.name, message: e.message } : e };
  }
  return p;
}

function revivePart(p: StreamPart): StreamPart {
  return p.type === "response-metadata" ? reviveTimestamp(p) : p;
}

function streamFrom(parts: StreamPart[]): ReadableStream<StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(revivePart(p));
      controller.close();
    },
  });
}

interface RecordedStream {
  parts: StreamPart[];
  /** false when the consumer cancelled or the provider errored mid-stream. */
  complete: boolean;
}

export function agentReplayMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",

    async wrapGenerate({ doGenerate, params, model }) {
      const call = beginModelCall<GenerateResult>(modelIdOf(model), requestOf("generate", params), { format: AI_SDK_V4_FORMAT });
      if (!call) return doGenerate();
      if (call.recorded) return reviveResult(call.recorded);

      const result = await doGenerate();
      call.finish(storableResult(result));
      return result;
    },

    async wrapStream({ doStream, params, model }) {
      const call = beginModelCall<RecordedStream>(modelIdOf(model), requestOf("stream", params), { format: AI_SDK_V4_FORMAT });
      if (!call) return doStream();
      if (call.recorded) return { stream: streamFrom(call.recorded.parts) };

      // Live: pass chunks through untouched while collecting them; the
      // response is recorded when the stream ends, however it ends.
      const { stream, ...rest } = await doStream();
      const parts: StreamPart[] = [];
      let finished = false;
      const finish = (complete: boolean) => {
        if (finished) return;
        finished = true;
        call.finish({ parts, complete });
      };

      const reader = stream.getReader();
      const recorded = new ReadableStream<StreamPart>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              finish(true);
              controller.close();
              return;
            }
            parts.push(storablePart(value));
            controller.enqueue(value);
          } catch (err) {
            finish(false);
            controller.error(err);
          }
        },
        async cancel(reason) {
          finish(false);
          await reader.cancel(reason);
        },
      });
      return { ...rest, stream: recorded };
    },
  };
}

function modelIdOf(model: { provider: string; modelId: string }) {
  return `${model.provider}/${model.modelId}`;
}

/** `wrapLanguageModel(model, agentReplayMiddleware())`, for convenience. */
export function recordedModel(model: Exclude<LanguageModel, string>) {
  return wrapLanguageModel({ model, middleware: agentReplayMiddleware() });
}

// ---------------------------------------------------------------------------
// Tool auto-wrap
// ---------------------------------------------------------------------------

export interface RecordedToolsOptions<T extends ToolSet> {
  /** Replay safety class per tool. `write` tools are never re-executed during replay. */
  effects?: Partial<Record<keyof T & string, ToolEffect>>;
  /**
   * Effect for tools missing from `effects`. Defaults to "write": an
   * unannotated tool is assumed to have side effects, so replay blocks or
   * stubs it instead of silently re-running it. Set "read" to opt out.
   */
  defaultEffect?: ToolEffect;
}

/**
 * Wrap every executable tool in an AI SDK `tools` object with `wrapTool`.
 * Tools without `execute` (client-side / provider-executed) are left alone:
 * their results arrive through the prompt, which the model hash covers.
 */
export function recordedTools<T extends ToolSet>(tools: T, opts: RecordedToolsOptions<T> = {}): T {
  const out: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools) as [keyof T & string, Tool][]) {
    if (!("execute" in t) || typeof t.execute !== "function") {
      out[name] = t;
      continue;
    }
    const execute = t.execute;
    const effect = opts.effects?.[name] ?? opts.defaultEffect ?? "write";
    const wrapped = wrapTool(
      { name, description: typeof t.description === "string" ? t.description : "", effect, parameters: syncJsonSchema(t) },
      async (input: unknown, options: Parameters<typeof execute>[1]) => {
        const result = await execute(input, options);
        if (isAsyncIterable(result)) {
          // Streaming tool output (preliminary results) isn't recorded yet.
          throw new Error(`agentreplay: tool "${name}" returns an AsyncIterable; streaming tool output is not supported yet.`);
        }
        return result;
      },
    );
    out[name] = { ...t, execute: wrapped } as Tool;
  }
  return out as T;
}

function syncJsonSchema(t: Tool): Record<string, unknown> {
  // Metadata only (run version fingerprints). Matching never depends on it:
  // the tool schemas the model sees are already part of the model request hash.
  const schema = (t as { inputSchema?: { jsonSchema?: unknown } }).inputSchema?.jsonSchema;
  return schema && typeof schema === "object" && !("then" in schema) ? (schema as Record<string, unknown>) : {};
}

function isAsyncIterable(x: unknown): x is AsyncIterable<unknown> {
  return x != null && typeof (x as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
}
