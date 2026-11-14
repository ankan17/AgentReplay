import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, streamText, tool, jsonSchema, isStepCount } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { startRun, FileStore, firstDivergence } from "agentreplay";
import { recordedModel, recordedTools } from "../src/index.ts";

type MockOpts = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>;
type GenerateResult = Exclude<MockOpts["doGenerate"], Function | unknown[] | undefined>;
type StreamPart = Exclude<MockOpts["doStream"], Function | unknown[] | undefined>["stream"] extends ReadableStream<infer P> ? P : never;

// ---------------------------------------------------------------------------
// Fixture: a 3-step support agent (lookup → refund → answer) on a mock model
// ---------------------------------------------------------------------------

const freshStore = () => new FileStore(mkdtempSync(join(tmpdir(), "agentreplay-ai-sdk-")));

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

type Prompt = { role: string; content: unknown }[];
const toolResults = (prompt: Prompt) =>
  prompt.filter((m) => m.role === "tool").flatMap((m) => m.content as { toolName: string; output: { value: any } }[]);

/** The "model": decides the next step from what the prompt contains. */
type Step = { tool: "lookupOrder" | "refundOrder"; input: object } | { text: string };
function nextStep(prompt: Prompt): Step {
  const results = toolResults(prompt);
  const order = results.find((r) => r.toolName === "lookupOrder")?.output.value;
  const refund = results.find((r) => r.toolName === "refundOrder")?.output.value;
  if (!order) return { tool: "lookupOrder", input: { orderId: "A1001" } };
  if (!refund) return { tool: "refundOrder", input: { orderId: order.orderId, amountCents: order.totalCents } };
  return { text: `Refunded ${refund.amountCents} cents (ref ${refund.refundId}).` };
}

function mockModel() {
  let n = 0;
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "support-v1",
    doGenerate: async ({ prompt }) => {
      const step = nextStep(prompt as Prompt);
      n++;
      const result: GenerateResult = "tool" in step
        ? {
            content: [{ type: "tool-call", toolCallId: `call-${n}`, toolName: step.tool, input: JSON.stringify(step.input) }],
            finishReason: { unified: "tool-calls", raw: "tool_use" }, usage, warnings: [],
            response: { id: `resp-${n}`, timestamp: new Date(), modelId: "support-v1" },
          }
        : {
            content: [{ type: "text", text: step.text }],
            finishReason: { unified: "stop", raw: "end_turn" }, usage, warnings: [],
            response: { id: `resp-${n}`, timestamp: new Date(), modelId: "support-v1" },
          };
      return result;
    },
    doStream: async ({ prompt }) => {
      const step = nextStep(prompt as Prompt);
      n++;
      const meta = { type: "response-metadata" as const, id: `resp-${n}`, timestamp: new Date(), modelId: "support-v1" };
      return {
        stream: convertArrayToReadableStream<StreamPart>(
          "tool" in step
            ? [
                { type: "stream-start" as const, warnings: [] }, meta,
                { type: "tool-call" as const, toolCallId: `call-${n}`, toolName: step.tool, input: JSON.stringify(step.input) },
                { type: "finish" as const, usage, finishReason: { unified: "tool-calls" as const, raw: "tool_use" } },
              ]
            : [
                { type: "stream-start" as const, warnings: [] }, meta,
                { type: "text-start" as const, id: "t" },
                ...step.text.split(" ").map((w, i) => ({ type: "text-delta" as const, id: "t", delta: (i ? " " : "") + w })),
                { type: "text-end" as const, id: "t" },
                { type: "finish" as const, usage, finishReason: { unified: "stop" as const, raw: "end_turn" } },
              ],
        ),
      };
    },
  });
}

/** Fake world. `totalCents` changes between runs to prove replay serves tool results from the log. */
const world = { totalCents: 4999, lookups: 0, ledger: [] as { orderId: string; amountCents: number }[] };

const rawTools = {
  lookupOrder: tool({
    description: "Fetch an order.",
    inputSchema: jsonSchema<{ orderId: string }>({ type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] }),
    execute: async ({ orderId }) => {
      world.lookups++;
      return { orderId, totalCents: world.totalCents };
    },
  }),
  refundOrder: tool({
    description: "Refund an order.",
    inputSchema: jsonSchema<{ orderId: string; amountCents: number }>({
      type: "object", properties: { orderId: { type: "string" }, amountCents: { type: "integer" } }, required: ["orderId", "amountCents"],
    }),
    execute: async ({ orderId, amountCents }) => {
      world.ledger.push({ orderId, amountCents });
      return { refundId: `RF-${orderId}`, amountCents };
    },
  }),
};

function makeAgent(model = mockModel(), opts: { stream?: boolean } = {}) {
  const wrapped = recordedModel(model);
  const tools = recordedTools(rawTools, { effects: { lookupOrder: "read", refundOrder: "write" } });
  return async (input: { system: string; request: string }) => {
    const args = { model: wrapped, tools, system: input.system, prompt: input.request, stopWhen: isStepCount(5) };
    if (!opts.stream) return (await generateText(args)).text;
    const result = streamText(args);
    let text = "";
    for await (const delta of result.textStream) text += delta;
    return text;
  };
}

const input = { system: "You are a support agent.", request: "Order #A1001 never arrived." };

// ---------------------------------------------------------------------------

test("generateText: strict replay reproduces the run with no model calls and no side effects", async () => {
  const store = freshStore();
  world.totalCents = 4999;
  const original = await startRun("t", input, makeAgent(), { store });
  assert.equal(original.status, "ok", original.error?.message);
  assert.equal(original.output, "Refunded 4999 cents (ref RF-A1001).");

  // One model.request per step of the internal tool loop, not one per generateText.
  const events = store.readEvents(original.runId);
  assert.equal(events.filter((e) => e.kind === "model.request").length, 3);
  assert.equal(events.filter((e) => e.kind === "tool.call").length, 2);

  world.totalCents = 1; // the live world changed since the recording
  const lookupsBefore = world.lookups, ledgerBefore = world.ledger.length;
  const model = mockModel();
  const replayed = await startRun("t", input, makeAgent(model), {
    store, replay: { sourceRunId: original.runId, mode: "strict" },
  });

  assert.equal(replayed.status, "ok", replayed.error?.message);
  assert.equal(replayed.output, original.output);
  assert.equal(model.doGenerateCalls.length, 0, "replay called the live model");
  assert.equal(world.lookups, lookupsBefore, "replay re-ran a read tool");
  assert.equal(world.ledger.length, ledgerBefore, "replay executed a real refund");
  assert.equal(firstDivergence(store, original.runId, replayed.runId), null);
});

test("generateText: changing the system prompt is caught as a divergence in strict mode", async () => {
  const store = freshStore();
  const original = await startRun("t", input, makeAgent(), { store });
  const changed = await startRun("t", { ...input, system: "Be terse." }, makeAgent(), {
    store, replay: { sourceRunId: original.runId, mode: "strict" },
  });
  assert.equal(changed.status, "error");
  assert.equal(changed.error?.name, "DivergenceError");
});

test("hybrid replay: model live, read tools from the log, write tools stubbed", async () => {
  const store = freshStore();
  world.totalCents = 4999;
  const original = await startRun("t", input, makeAgent(), { store });

  world.totalCents = 1;
  const lookupsBefore = world.lookups, ledgerBefore = world.ledger.length;
  const model = mockModel();
  const forked = await startRun("t", input, makeAgent(model), {
    store, replay: { sourceRunId: original.runId, mode: "hybrid", writePolicy: "stub" },
  });

  assert.equal(forked.status, "ok", forked.error?.message);
  assert.equal(model.doGenerateCalls.length, 3, "hybrid should call the model live");
  assert.equal(world.lookups, lookupsBefore, "lookupOrder should come from the log");
  assert.equal(world.ledger.length, ledgerBefore, "refund should be stubbed");
  const sources = store.readEvents(forked.runId).flatMap((e) => (e.kind === "tool.result" ? [e.source] : []));
  // The refund request matches the recording (its args derive from the logged
  // lookup), so hybrid serves it from the log too; the write never runs live.
  assert.deepEqual(sources, ["log", "log"]);
});

test("streamText: chunks are recorded and replayed as a stream", async () => {
  const store = freshStore();
  world.totalCents = 4999;
  const original = await startRun("t", input, makeAgent(mockModel(), { stream: true }), { store });
  assert.equal(original.status, "ok", original.error?.message);
  assert.equal(original.output, "Refunded 4999 cents (ref RF-A1001).");

  world.totalCents = 1;
  const model = mockModel();
  const ledgerBefore = world.ledger.length;
  const replayed = await startRun("t", input, makeAgent(model, { stream: true }), {
    store, replay: { sourceRunId: original.runId, mode: "strict" },
  });
  assert.equal(replayed.status, "ok", replayed.error?.message);
  assert.equal(replayed.output, original.output);
  assert.equal(model.doStreamCalls.length, 0, "replay called the live model");
  assert.equal(world.ledger.length, ledgerBefore);
});

// streamText routes model errors to onError and ends textStream quietly, so the
// DivergenceError never reaches the agent. The run must still fail.
test("a generateText recording does not silently serve streamText", async () => {
  const store = freshStore();
  const original = await startRun("t", input, makeAgent(), { store });
  const replayed = await startRun("t", input, makeAgent(mockModel(), { stream: true }), {
    store, replay: { sourceRunId: original.runId, mode: "strict" },
  });
  assert.equal(replayed.status, "error");
  assert.equal(replayed.error?.name, "DivergenceError");
});

test("request headers are neither hashed nor stored", async () => {
  const store = freshStore();
  const model = recordedModel(mockModel());
  const r = await startRun("t", {}, async () =>
    (await generateText({ model, prompt: "hi", headers: { authorization: "Bearer sk-secret" } })).text, { store },
  );
  const req = store.readEvents(r.runId).find((e) => e.kind === "model.request");
  assert.ok(req && req.kind === "model.request");
  assert.ok(!JSON.stringify(store.getBlob(req.request)).includes("sk-secret"));
});

test("tools without an effect annotation default to write", async () => {
  const tools = recordedTools(rawTools, { effects: { lookupOrder: "read" } });
  assert.equal((tools.lookupOrder.execute as unknown as { spec: { effect: string } }).spec.effect, "read");
  assert.equal((tools.refundOrder.execute as unknown as { spec: { effect: string } }).spec.effect, "write");
});
