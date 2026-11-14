/**
 * Real provider packages (@ai-sdk/openai, @ai-sdk/anthropic) against fake
 * HTTP servers: does a recording made through real provider code replay
 * with zero divergence? This is the hash-stability question — anything the
 * AI SDK or a provider injects into requests per run (ids, timestamps,
 * metadata) would surface here as a divergence.
 *
 * What this can't cover: provider-side API changes and real model behaviour.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, streamText, tool, jsonSchema, isStepCount } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { startRun, FileStore, firstDivergence, formatTimeline } from "agentreplay";
import { recordedModel, recordedTools } from "../src/index.ts";
import { fakeServer, type FakeApi, type FakeServer } from "./fake-providers.ts";

const API_KEY = "sk-agentreplay-test-DO-NOT-STORE";

function modelFor(api: FakeApi, server: FakeServer) {
  switch (api) {
    case "openai-responses": return createOpenAI({ apiKey: API_KEY, fetch: server.fetch })("gpt-5");
    case "openai-chat":      return createOpenAI({ apiKey: API_KEY, fetch: server.fetch }).chat("gpt-5");
    case "anthropic":        return createAnthropic({ apiKey: API_KEY, fetch: server.fetch })("claude-sonnet-5-5");
  }
}

let lookups = 0;
const tools = recordedTools(
  {
    lookupOrder: tool({
      description: "Fetch an order by id.",
      inputSchema: jsonSchema<{ orderId: string }>({
        type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"], additionalProperties: false,
      }),
      execute: async ({ orderId }) => {
        lookups++;
        return { orderId, status: "packed" };
      },
    }),
  },
  { effects: { lookupOrder: "read" } },
);

const input = { system: "You are a support agent.", request: "Where is order #A1001?" };

function agent(api: FakeApi, server: FakeServer, stream: boolean) {
  const model = recordedModel(modelFor(api, server));
  return async (i: typeof input) => {
    const args = { model, tools, system: i.system, prompt: i.request, stopWhen: isStepCount(4) };
    if (!stream) return (await generateText(args)).text;
    let text = "";
    for await (const d of streamText(args).textStream) text += d;
    return text;
  };
}

const freshStore = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentreplay-providers-"));
  return { dir, store: new FileStore(dir) };
};

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

for (const api of ["openai-responses", "openai-chat", "anthropic"] as const) {
  for (const stream of [false, true]) {
    describe(`${api} · ${stream ? "streamText" : "generateText"}`, () => {
      test("records a live run through the real provider package", async () => {
        const { store } = freshStore();
        const server = fakeServer(api);
        const run = await startRun("t", input, agent(api, server, stream), { store });
        assert.equal(run.status, "ok", run.error?.stack);
        assert.equal(run.output, "Order A1001 is packed.");
        assert.equal(server.requests.length, 2, "one HTTP call per step");
        assert.equal(!!server.requests[0].body.stream, stream);
        // Sanity: the timeline renders provider-recorded payloads.
        assert.match(formatTimeline(store, run.runId), /model → call lookupOrder\(\{"orderId":"A1001"\}\)/);
      });

      test("strict replay: no HTTP, no tool execution, no divergence", async () => {
        const { store } = freshStore();
        const original = await startRun("t", input, agent(api, fakeServer(api), stream), { store });
        assert.equal(original.status, "ok", original.error?.stack);

        const replayServer = fakeServer(api); // different random ids — must never be reached
        const lookupsBefore = lookups;
        const replayed = await startRun("t", input, agent(api, replayServer, stream), {
          store, replay: { sourceRunId: original.runId, mode: "strict" },
        });
        assert.equal(replayed.status, "ok", replayed.error?.stack);
        assert.equal(replayed.output, original.output);
        assert.equal(replayServer.requests.length, 0, "replay made a live HTTP call");
        assert.equal(lookups, lookupsBefore, "replay re-ran the tool");
        assert.equal(firstDivergence(store, original.runId, replayed.runId), null);
      });

      test("two live runs with identical server behaviour make identical requests", async () => {
        // Same seed → same ids from the server. If the SDK or provider put
        // anything run-specific into the call options, the hashes would differ.
        const { store } = freshStore();
        const a = await startRun("t", input, agent(api, fakeServer(api, { seed: "s" }), stream), { store });
        const b = await startRun("t", input, agent(api, fakeServer(api, { seed: "s" }), stream), { store });
        assert.equal(a.status, "ok", a.error?.stack);
        assert.equal(b.status, "ok", b.error?.stack);
        const d = firstDivergence(store, a.runId, b.runId);
        assert.equal(d, null, d ? JSON.stringify(d.changes, null, 2) : "");
      });

      test("two live runs that differ only in server-issued ids are summarized as such", async () => {
        const { store } = freshStore();
        const a = await startRun("t", input, agent(api, fakeServer(api, { seed: "a" }), stream), { store });
        const b = await startRun("t", input, agent(api, fakeServer(api, { seed: "b" }), stream), { store });
        const d = firstDivergence(store, a.runId, b.runId);
        assert.ok(d, "ids flow back into the next request, so the runs do diverge");
        assert.deepEqual(d.summary, ["only provider-issued ids differ (e.g. tool call ids) — expected between two live runs"]);
      });

      test("the API key never reaches the trace store", async () => {
        const { dir, store } = freshStore();
        const server = fakeServer(api);
        await startRun("t", input, agent(api, server, stream), { store });
        const sent = JSON.stringify(server.requests[0].headers);
        assert.ok(sent.includes(API_KEY), "precondition: the provider did send the key");
        for (const f of filesUnder(dir)) assert.ok(!readFileSync(f, "utf8").includes(API_KEY), `key found in ${f}`);
      });
    });
  }
}
