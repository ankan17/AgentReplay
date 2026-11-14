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

test("fork --at-seq: exact replay before the fork point, live from it, new paths are not divergences", async () => {
  const store = freshStore();
  process.env.SHIPMENT_API = "v2";
  const failing = await startRun("t", input, makeAgent(), { store });
  assert.equal(failing.status, "error");
  const getShipment = store.readEvents(failing.runId).find((e) => e.kind === "tool.call" && e.tool === "getShipment")!;

  // What if the carrier had answered v1 at that point?
  process.env.SHIPMENT_API = "v1";
  const before = PAYMENTS_LEDGER.length;
  const forked = await startRun("t", input, makeAgent(), {
    store, replay: { sourceRunId: failing.runId, mode: "fork", forkAtSeq: getShipment.seq, writePolicy: "stub" },
  });
  delete process.env.SHIPMENT_API;

  assert.equal(forked.status, "ok", forked.error?.message);
  assert.equal(PAYMENTS_LEDGER.length, before, "the refund after the fork point must obey writePolicy");
  assert.equal(store.readMeta(forked.runId).replayOf?.forkAtSeq, getShipment.seq);

  const events = store.readEvents(forked.runId);
  const sources = events.flatMap((e) => (e.kind === "model.response" || e.kind === "tool.result" ? [e.source] : []));
  // lookupOrder model+tool, getShipment model from the log; then all live, the write stubbed.
  assert.deepEqual(sources, ["log", "log", "log", "live", "live", "stubbed", "live"]);
  // The final model call (call 7) never happened in the failing run: new path, not a divergence.
  assert.equal(events.filter((e) => e.kind === "divergence").length, 0);
});

test("fork --at-seq: a mismatch before the fork point is still a divergence", async () => {
  const store = freshStore();
  process.env.SHIPMENT_API = "v1";
  const original = await startRun("t", input, makeAgent(), { store });
  const lastModel = store.readEvents(original.runId).filter((e) => e.kind === "model.request").at(-1)!;

  // Changed instructions alter the very first model request, which is before the fork point.
  const forked = await startRun("t", { ...input, instructions: FIXED_INSTRUCTIONS }, makeAgent(), {
    store, replay: { sourceRunId: original.runId, mode: "fork", forkAtSeq: lastModel.seq, writePolicy: "stub" },
  });
  delete process.env.SHIPMENT_API;
  const divergences = store.readEvents(forked.runId).filter((e) => e.kind === "divergence");
  assert.ok(divergences.length > 0);
  assert.equal(divergences[0].kind === "divergence" && divergences[0].reason, "request_changed");
});

test("fork --at-seq rejects a nonsense seq", async () => {
  const store = freshStore();
  const original = await startRun("t", input, makeAgent(), { store });
  const r = await startRun("t", input, makeAgent(), {
    store, replay: { sourceRunId: original.runId, mode: "fork", forkAtSeq: -1 },
  }).catch((e: Error) => ({ status: "threw", error: e }));
  assert.match(String(r.error?.message), /forkAtSeq must be a non-negative integer/);
  assert.deepEqual(store.listRuns().map((m) => m.runId), [original.runId], "the rejected fork left a run behind");
});
