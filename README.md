# AgentReplay

Deterministic record/replay debugging for TypeScript LLM agents.

AgentReplay records every boundary an agent crosses (model calls, tool calls)
and lets you replay a run exactly from the log, fork it with changed instructions,
and see the first point where two runs diverge — without re-executing
side-effecting tools.

## Repository layout

```
packages/sdk/              agentreplay           ← the npm package you install in your agent
apps/dashboard/            @agentreplay/dashboard ← local web UI for recorded runs
examples/support-agent/    demo agent with a planted step-5 failure + tests
```

| Level | What it does | Who uses it |
|---|---|---|
| **SDK** (`agentreplay`) | `wrapModel`, `wrapTool`, `startRun`, replay modes, trace store, `agentreplay` CLI | Imported into the agent's code |
| **Dashboard** (`@agentreplay/dashboard`) | Reads the trace store; timeline, context-window inspector, run diff | Run locally next to the agent |

The two levels share only the **trace store format** (`.agent-replay/`), so the
dashboard can later read from S3/Postgres or a hosted collector without SDK changes.

## Quick start (from source)

Requires Node ≥ 22.18 (runs TypeScript natively; no build needed in development).

```bash
npm install                                  # links the workspaces

npm run demo -- record --api v1              # passing run
npm run demo -- record --api v2              # fails at the refund step
npm run demo -- replay latest                # strict replay: same failure, no live calls, no refund
npm run demo -- fork latest                  # fixed instructions; model live, tools from log, write stubbed

npm run dashboard                            # → http://localhost:4317
npm test
```

## Using the SDK in your agent

```ts
import { startRun, wrapModel, wrapTool } from "agentreplay";

const lookupOrder = wrapTool(
  { name: "lookupOrder", description: "…", effect: "read", parameters: { … } },
  async ({ orderId }) => db.orders.find(orderId),
);
const refund = wrapTool({ name: "refund", effect: "write", … }, async (args) => payments.refund(args));
const model = wrapModel(myChatModel); // provider-neutral ChatModel; adapters coming

// record
const { runId } = await startRun("support-agent", input, agent);

// replay exactly from the log (throws DivergenceError if the agent asks for anything new)
await startRun("support-agent", input, agent, { replay: { sourceRunId: runId, mode: "strict" } });

// re-run with a fix: model live, tool results from the log, write tools stubbed
await startRun("support-agent", fixedInput, agent, {
  replay: { sourceRunId: runId, mode: "hybrid", writePolicy: "stub" },
});
```

CLI: `npx agentreplay runs | show <runId> | diff <a> <b> [--tools]`

## Design decisions so far

- **CallKey = (span path, target, nth call, requestHash).** Matching ignores wall-clock and
  ids; a hash mismatch at the same key *is* the divergence.
- **Blobs store exact bytes; matching uses canonical hashes.** Re-serialized payloads change
  every downstream request hash.
- **Divergence is an event, not just an error.** Strict mode throws; fork/hybrid record it
  and continue live.
- **Write tools during replay: `block` (default) | `stub` | `allow`.**
- **Run input includes agent config**, so replay rebuilds the same agent.
- **Packages export TS source under the `development` condition** and compiled `dist/`
  otherwise (`npm run build`).

## Roadmap

- [ ] Vercel AI SDK adapter (`ChatModel` ↔ `generateText`/`streamText`), auto-wrap `tools: {}`
- [ ] Streaming chunk capture and replay
- [ ] `fork --at-seq N`
- [ ] SQLite index (`node:sqlite`) for cross-run queries
- [ ] Dashboard: side-by-side run view, React/Vite rewrite once the views settle
- [ ] Redaction at record time
