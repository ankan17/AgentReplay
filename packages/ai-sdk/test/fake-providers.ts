/**
 * Fake provider HTTP servers, as `fetch` implementations.
 *
 * Each one is a tiny scripted "model" that reads the request body the real
 * provider package built and answers in that API's wire format (JSON or SSE):
 *
 *   no tool result in the conversation yet → call lookupOrder({ orderId })
 *   otherwise                              → answer with text
 *
 * This lets the real @ai-sdk/openai and @ai-sdk/anthropic code run end to
 * end — request building, response parsing, stream parsing, tool-call ids,
 * provider metadata — with no API key and no network.
 *
 * Ids in responses are random per call, like a real API's, so any id that
 * leaks into a later request makes replay diverge (which is what the tests
 * check for). Pass `seed` to make them deterministic instead.
 */
import { randomUUID } from "node:crypto";

export type FakeApi = "openai-responses" | "openai-chat" | "anthropic";

export interface FakeServer {
  fetch: typeof globalThis.fetch;
  /** Every request the provider sent: url, parsed body, headers. */
  requests: { url: string; body: any; headers: Record<string, string> }[];
}

export function fakeServer(api: FakeApi, opts: { seed?: string; answer?: (order: unknown) => string } = {}): FakeServer {
  const requests: FakeServer["requests"] = [];
  let n = 0;
  const id = (prefix: string) => `${prefix}_${opts.seed ? `${opts.seed}${n}` : randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const answer = opts.answer ?? ((order: any) => `Order ${order.orderId} is ${order.status}.`);

  const fetch: typeof globalThis.fetch = async (input, init) => {
    n++;
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push({ url, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });

    const result = toolResultOf(api, body);
    const step: Step = result === undefined
      ? { tool: "lookupOrder", args: { orderId: "A1001" } }
      : { text: answer(typeof result === "string" ? JSON.parse(result) : result) };

    switch (api) {
      case "openai-responses": return respond(openaiResponses(step, body, id, !!body.stream));
      case "openai-chat":      return respond(openaiChat(step, body, id, !!body.stream));
      case "anthropic":        return respond(anthropic(step, body, id, !!body.stream));
    }
  };
  return { fetch, requests };
}

type Step = { tool: string; args: object } | { text: string };

/** The tool output in the request's conversation, if the agent already called the tool. */
function toolResultOf(api: FakeApi, body: any): unknown {
  switch (api) {
    case "openai-responses":
      return body.input?.find((i: any) => i.type === "function_call_output")?.output;
    case "openai-chat":
      return body.messages?.find((m: any) => m.role === "tool")?.content;
    case "anthropic": {
      const block = body.messages?.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
        .find((c: any) => c.type === "tool_result");
      if (!block) return undefined;
      return typeof block.content === "string" ? block.content : block.content.map((c: any) => c.text).join("");
    }
  }
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

type Reply = { json: unknown } | { events: [string | null, unknown][] };

/** JSON body, or SSE: `events` is [eventName | null, data][]; string data is sent verbatim (e.g. "[DONE]"). */
function respond(r: Reply): Response {
  if ("json" in r) return new Response(JSON.stringify(r.json), { status: 200, headers: { "content-type": "application/json" } });
  return new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        for (const [event, data] of r.events) {
          const payload = typeof data === "string" ? data : JSON.stringify(data);
          c.enqueue(enc.encode(`${event ? `event: ${event}\n` : ""}data: ${payload}\n\n`));
        }
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const words = (text: string) => text.split(" ").map((w, i) => (i ? " " : "") + w);
const NOW = 1_763_000_000; // fixed timestamp; ids carry the per-call randomness

// ---------------------------------------------------------------------------
// OpenAI Responses API (POST /responses) — the default for openai(modelId)
// ---------------------------------------------------------------------------

function openaiResponses(step: Step, req: any, id: (p: string) => string, stream: boolean) {
  const usage = { input_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens: 8, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 28 };
  const item = "tool" in step
    ? { type: "function_call", id: id("fc"), call_id: id("call"), name: step.tool, arguments: JSON.stringify(step.args), status: "completed" }
    : { type: "message", id: id("msg"), role: "assistant", status: "completed", content: [{ type: "output_text", text: step.text, annotations: [] }] };
  const response = {
    id: id("resp"), object: "response", created_at: NOW, status: "completed", model: req.model,
    output: [item], incomplete_details: null, error: null, usage,
  };
  if (!stream) return { json: response };

  let seq = 0;
  const ev = (type: string, data: object): [string, unknown] => [type, { type, sequence_number: seq++, ...data }];
  const started = { ...response, status: "in_progress", output: [], usage: null };
  const events: [string, unknown][] = [ev("response.created", { response: started }), ev("response.in_progress", { response: started })];
  if (item.type === "function_call") {
    events.push(ev("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } }));
    events.push(ev("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: item.arguments }));
    events.push(ev("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: item.arguments }));
  } else {
    const text = (item as any).content[0].text as string;
    events.push(ev("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } }));
    events.push(ev("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
    for (const d of words(text)) events.push(ev("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: d, logprobs: [] }));
    events.push(ev("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text, logprobs: [] }));
    events.push(ev("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text, annotations: [] } }));
  }
  events.push(ev("response.output_item.done", { output_index: 0, item }));
  events.push(ev("response.completed", { response }));
  return { events: events.map(([, d]) => [null, d] as [null, unknown]) };
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions (POST /chat/completions) — openai.chat(modelId)
// ---------------------------------------------------------------------------

function openaiChat(step: Step, req: any, id: (p: string) => string, stream: boolean) {
  const cid = id("chatcmpl");
  const usage = { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 };
  const finish = "tool" in step ? "tool_calls" : "stop";
  const toolCall = "tool" in step ? { id: id("call"), type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } } : null;
  if (!stream) {
    return {
      json: {
        id: cid, object: "chat.completion", created: NOW, model: req.model,
        choices: [{ index: 0, message: { role: "assistant", content: "text" in step ? step.text : null, ...(toolCall && { tool_calls: [toolCall] }) }, finish_reason: finish }],
        usage,
      },
    };
  }
  const chunk = (delta: object, finish_reason: string | null = null, extra: object = {}): [null, unknown] =>
    [null, { id: cid, object: "chat.completion.chunk", created: NOW, model: req.model, choices: [{ index: 0, delta, finish_reason }], ...extra }];
  const events: [null, unknown][] = [chunk({ role: "assistant", content: "" })];
  if (toolCall) {
    const args = toolCall.function.arguments;
    events.push(chunk({ tool_calls: [{ index: 0, id: toolCall.id, type: "function", function: { name: toolCall.function.name, arguments: "" } }] }));
    events.push(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, 5) } }] }));
    events.push(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] }));
  } else {
    for (const d of words((step as { text: string }).text)) events.push(chunk({ content: d }));
  }
  events.push(chunk({}, finish));
  events.push([null, { id: cid, object: "chat.completion.chunk", created: NOW, model: req.model, choices: [], usage }]);
  events.push([null, "[DONE]"]);
  return { events };
}

// ---------------------------------------------------------------------------
// Anthropic Messages (POST /messages)
// ---------------------------------------------------------------------------

function anthropic(step: Step, req: any, id: (p: string) => string, stream: boolean) {
  const block = "tool" in step
    ? { type: "tool_use", id: id("toolu"), name: step.tool, input: step.args }
    : { type: "text", text: step.text };
  const stop = "tool" in step ? "tool_use" : "end_turn";
  const message = {
    id: id("msg"), type: "message", role: "assistant", model: req.model,
    content: [block], stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
  if (!stream) return { json: message };

  const ev = (type: string, data: object): [string, unknown] => [type, { type, ...data }];
  const events: [string, unknown][] = [
    ev("message_start", { message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 1 } } }),
  ];
  if (block.type === "tool_use") {
    const args = JSON.stringify((block as any).input);
    events.push(ev("content_block_start", { index: 0, content_block: { ...block, input: {} } }));
    events.push(ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: args.slice(0, 5) } }));
    events.push(ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: args.slice(5) } }));
  } else {
    events.push(ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
    for (const d of words((block as any).text)) events.push(ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: d } }));
  }
  events.push(ev("content_block_stop", { index: 0 }));
  events.push(ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 8 } }));
  events.push(ev("message_stop", {}));
  return { events };
}
