import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRun, FileStore, firstDivergence } from "agentreplay";
import { makeAiSdkAgent, BASE_INSTRUCTIONS, FIXED_INSTRUCTIONS, type AiSdkAgentInput } from "../agent-ai-sdk.ts";
import { PAYMENTS_LEDGER } from "../world.ts";

const freshStore = () => new FileStore(mkdtempSync(join(tmpdir(), "agent-replay-ai-sdk-")));
const input = (stream: boolean): AiSdkAgentInput => ({
  request: "My order #A1001 never arrived", instructions: BASE_INSTRUCTIONS, model: "scripted", stream,
});

for (const stream of [false, true]) {
  const mode = stream ? "streamText" : "generateText";

  test(`${mode}: strict replay reproduces every recorded run exactly, with zero side effects`, async () => {
    const store = freshStore();
    const outcomes = new Set<string>();

    for (let i = 0; i < 6; i++) {
      // Record against alternating carrier backends (both the passing and the
      // failing path), then replay with the live API on the *other* backend:
      // the live world must not matter.
      process.env.SHIPMENT_API = i % 2 ? "v1" : "v2";
      const original = await startRun("t", input(stream), makeAiSdkAgent(), { store });
      outcomes.add(String(original.output).slice(0, 20));

      const ledgerBefore = PAYMENTS_LEDGER.length;
      process.env.SHIPMENT_API = i % 2 ? "v2" : "v1";
      const replayed = await startRun("t", input(stream), makeAiSdkAgent(), {
        store, replay: { sourceRunId: original.runId, mode: "strict" },
      });
      delete process.env.SHIPMENT_API;

      assert.equal(replayed.status, "ok", `run ${i}: ${replayed.error?.message}`);
      assert.equal(replayed.output, original.output, `run ${i}: output differs`);
      assert.equal(firstDivergence(store, original.runId, replayed.runId), null, `run ${i}: diverged`);
      assert.equal(PAYMENTS_LEDGER.length, ledgerBefore, `run ${i}: replay executed a real refund`);
    }
    assert.equal(outcomes.size, 2, `expected both outcomes, saw: ${[...outcomes].join(" | ")}`);
  });

  test(`${mode}: the planted bug surfaces as a refund tool error the model sees`, async () => {
    const store = freshStore();
    process.env.SHIPMENT_API = "v2";
    const run = await startRun("t", input(stream), makeAiSdkAgent(), { store });
    delete process.env.SHIPMENT_API;

    assert.equal(run.status, "ok", "the AI SDK turns tool errors into results; the run itself succeeds");
    assert.match(String(run.output), /couldn't process your refund.*"49\.99"/);
    const refund = store.readEvents(run.runId).find((e) => e.kind === "tool.result" && e.key.target === "tool:refundOrder");
    assert.ok(refund?.kind === "tool.result" && !refund.ok);
  });

  test(`${mode}: hybrid fork with fixed instructions fixes the refund without executing it`, async () => {
    const store = freshStore();
    process.env.SHIPMENT_API = "v2";
    const failing = await startRun("t", input(stream), makeAiSdkAgent(), { store });
    process.env.SHIPMENT_API = "v1"; // tools must come from the log, not the live API

    const before = PAYMENTS_LEDGER.length;
    const blocked = await startRun("t", { ...input(stream), instructions: FIXED_INSTRUCTIONS }, makeAiSdkAgent(), {
      store, replay: { sourceRunId: failing.runId, mode: "hybrid" }, // default writePolicy: block
    });
    // Blocked writes throw inside execute, which the AI SDK hands to the model as a tool error.
    assert.match(String(blocked.output), /Blocked live execution of write tool/);

    const fixed = await startRun("t", { ...input(stream), instructions: FIXED_INSTRUCTIONS }, makeAiSdkAgent(), {
      store, replay: { sourceRunId: failing.runId, mode: "hybrid", writePolicy: "stub" },
    });
    delete process.env.SHIPMENT_API;
    assert.equal(fixed.status, "ok", fixed.error?.message);
    assert.match(String(fixed.output), /refunded \$49\.99/);
    assert.equal(PAYMENTS_LEDGER.length, before, "a write tool ran during replay");

    const d = firstDivergence(store, failing.runId, fixed.runId, { toolsOnly: true });
    assert.equal(d?.a?.key.target, "tool:refundOrder");
    assert.deepEqual(d?.changes.map((c) => [c.path, c.a, c.b]), [["$.amountCents", "49.99", 4999]]);
  });
}

test("model choice is part of the recorded input; unknown models fail clearly", async () => {
  const store = freshStore();
  const run = await startRun("t", { ...input(false), model: "nope:x" }, makeAiSdkAgent(), { store });
  assert.equal(run.status, "error");
  assert.match(run.error!.message, /Unknown model "nope:x"/);
});
