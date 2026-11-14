# AgentReplay

Deterministic record/replay debugging for TypeScript LLM agents (week-0 starter).
Zero runtime dependencies; runs on Node ≥ 22.18 with native TypeScript.

## Try it

```bash
node demo/cli.ts record --api v1      # passing run
node demo/cli.ts record --api v2      # fails at the refund step
node demo/cli.ts runs
node demo/cli.ts show latest          # timeline
node demo/cli.ts replay latest        # strict replay: same failure, no live calls, no refund
node demo/cli.ts diff <okRun> <badRun>          # first point where the agent's inputs differ
node demo/cli.ts fork <badRun>                  # fixed instructions, model live, tools from log,
                                                # write tool stubbed
node demo/cli.ts fork <badRun> --write block    # write tool blocked instead
npm test                                        # 3 replay-property tests
```

Run `npm i` once if you want `npm run typecheck` (TypeScript + @types/node).

## Layout

| File | What it is |
|---|---|
| `src/schema.ts` | Trace event schema (v1): `RunMeta`, `CallKey`, event union, provider-neutral `ChatModel` |
| `src/store.ts` | File store: append-only `events.jsonl` per run + content-addressed blobs |
| `src/hash.ts` | Canonical JSON + sha256 (used for request matching only) |
| `src/recorder.ts` | `startRun`, `span`, `snapshot`, `wrapTool`, `wrapModel`, `ReplaySource`, write policy |
| `src/inspect.ts` | Terminal timeline, structural JSON diff, `firstDivergence` |
| `demo/agent.ts` | Support agent with flaky carrier API (v1/v2 payload drift) and a `write` refund tool |
| `demo/cli.ts` | record / runs / show / replay / fork / diff |
| `test/replay.test.ts` | record→replay identity ×20, strict divergence throws, writes never run in fork |

## Design decisions so far

- **CallKey = (span path, target, nth call, requestHash).** Matching ignores wall-clock and
  ids; a hash mismatch at the same key *is* the divergence.
- **Blobs store exact bytes; matching uses canonical hashes.** Feeding a re-serialized
  (key-sorted) payload back to the agent changed every downstream request hash — found
  while building this, now covered by the tests.
- **Divergence is an event, not just an error.** Strict mode throws; fork/hybrid record
  it and continue live.
- **Write tools: `block` (default) | `stub` | `allow`** during any replay.
- **Run input includes agent config** (instructions), so replay rebuilds the same agent.

## Next (week 1–2 per plan)

- Vercel AI SDK adapter (`ChatModel` ↔ `generateText`/`streamText`) and auto-wrapping `tools: {}`
- Streaming chunk capture/replay
- SQLite index (`node:sqlite`) for querying across runs
- `fork --at-seq N` CLI
