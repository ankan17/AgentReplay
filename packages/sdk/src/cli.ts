#!/usr/bin/env node
/**
 * agentreplay CLI — inspect recorded runs from the terminal.
 *
 *   agentreplay runs [--dir .agent-replay]
 *   agentreplay show <runId|latest>
 *   agentreplay diff <runA> <runB> [--tools]
 *
 * Replay and fork need your agent code, so they are programmatic:
 *   startRun(name, input, agent, { replay: { sourceRunId, mode: "strict" } })
 *
 * For the visual timeline: npx @agentreplay/dashboard
 */
import { FileStore } from "./store.ts";
import { formatTimeline, firstDivergence, formatDivergence } from "./inspect.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : "true";
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--dir"));
const [cmd, ...rest] = positional;
const store = new FileStore(flag("dir") ?? ".agent-replay");

const resolveRun = (id?: string) => {
  if (id && id !== "latest") return id;
  const runs = store.listRuns();
  if (!runs.length) throw new Error(`No runs found in ${store.root}`);
  return runs[runs.length - 1].runId;
};

try {
  switch (cmd) {
    case "runs":
      for (const m of store.listRuns()) {
        console.log(`${m.runId}  ${m.status.padEnd(5)}  ${m.name}  ${m.replayOf ? `${m.replayOf.mode} of ${m.replayOf.runId}` : "live"}`);
      }
      break;
    case "show":
      console.log(formatTimeline(store, resolveRun(rest[0])));
      break;
    case "diff":
      console.log(formatDivergence(firstDivergence(store, resolveRun(rest[0]), resolveRun(rest[1]), { toolsOnly: flag("tools") === "true" })));
      break;
    default:
      console.log("Usage: agentreplay <runs | show <runId> | diff <a> <b> [--tools]> [--dir .agent-replay]");
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
