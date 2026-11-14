import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRun, FileStore, firstDivergence } from "agentreplay";
import { makeAgent, PAYMENTS_LEDGER, BASE_INSTRUCTIONS, FIXED_INSTRUCTIONS } from "../agent.ts";

const freshStore = () => new FileStore(mkdtempSync(join(tmpdir(), "agent-replay-")));
const input = { request: "My order #A1001 never arrived", instructions: BASE_INSTRUCTIONS };

test("strict replay reproduces every recorded run exactly, with zero side effects", async () => {
  const store = freshStore();
  delete process.env.SHIPMENT_API; // let the flaky API be flaky

  for (let i = 0; i < 20; i++) {
    const original = await startRun("t", input, makeAgent(), { store });

    const ledgerBefore = PAYMENTS_LEDGER.length;
    const replayed = await startRun("t", input, makeAgent(), {
      store, replay: { sourceRunId: original.runId, mode: "strict" },
    });

    assert.equal(replayed.status, original.status, `run ${i}: status differs`);
    assert.equal(replayed.output, original.output, `run ${i}: output differs`);
    assert.equal(firstDivergence(store, original.runId, replayed.runId), null, `run ${i}: diverged`);
    assert.equal(PAYMENTS_LEDGER.length, ledgerBefore, `run ${i}: replay executed a real refund`);
  }
});

test("strict replay throws on divergence instead of guessing", async () => {
  const store = freshStore();
  const original = await startRun("t", input, makeAgent(), { store });
  const changed = await startRun("t", { ...input, instructions: FIXED_INSTRUCTIONS }, makeAgent(), {
    store, replay: { sourceRunId: original.runId, mode: "strict" },
  });
  assert.equal(changed.status, "error");
  assert.equal(changed.error?.name, "DivergenceError");
  assert.ok(store.readEvents(changed.runId).some((e) => e.kind === "divergence"));
});

test("hybrid fork never executes a write tool unless allowed", async () => {
  const store = freshStore();
  process.env.SHIPMENT_API = "v2";
  const failing = await startRun("t", input, makeAgent(), { store });
  assert.equal(failing.status, "error");

  const before = PAYMENTS_LEDGER.length;
  const blocked = await startRun("t", { ...input, instructions: FIXED_INSTRUCTIONS }, makeAgent(), {
    store, replay: { sourceRunId: failing.runId, mode: "hybrid" }, // default writePolicy: block
  });
  assert.equal(blocked.status, "error");
  assert.match(blocked.error!.message, /Blocked live execution of write tool/);

  const stubbed = await startRun("t", { ...input, instructions: FIXED_INSTRUCTIONS }, makeAgent(), {
    store, replay: { sourceRunId: failing.runId, mode: "hybrid", writePolicy: "stub" },
  });
  assert.equal(stubbed.status, "ok");
  assert.equal(PAYMENTS_LEDGER.length, before, "a write tool ran during replay");

  // The fix is visible as the first tool-level divergence: "49.99" → 4999.
  const d = firstDivergence(store, failing.runId, stubbed.runId, { toolsOnly: true });
  assert.equal(d?.a?.key.target, "tool:refundOrder");
  assert.deepEqual(d?.changes.map((c) => [c.path, c.a, c.b]), [["$.amountCents", "49.99", 4999]]);
  delete process.env.SHIPMENT_API;
});
