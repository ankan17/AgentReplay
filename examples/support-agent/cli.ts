/**
 * Demo CLI.
 *
 *   npm run demo -- record [--api v1|v2] [--fixed]   run the agent live and record it
 *   npm run demo -- runs                             list recorded runs
 *   npm run demo -- show <runId|latest>              print the execution timeline
 *   npm run demo -- replay <runId|latest>            strict replay from the log
 *   npm run demo -- fork <runId> [--write stub|block|allow]
 *                                                     re-run with fixed instructions; model
 *                                                     live, tools from the log (hybrid)
 *   npm run demo -- diff <runA> <runB> [--tools]     first point of divergence
 */
import { startRun, FileStore, formatTimeline, firstDivergence, formatDivergence, type RunStartEvent } from "agentreplay";
import { makeAgent, BASE_INSTRUCTIONS, FIXED_INSTRUCTIONS, AGENT_MODELS, AGENT_TOOLS, type AgentInput } from "./agent.ts";

const store = new FileStore();
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : "true";
};
const resolveRun = (id?: string) => {
  if (id && id !== "latest" && !id.startsWith("--")) return id;
  const runs = store.listRuns();
  if (!runs.length) throw new Error("No runs recorded yet. Try: npm run demo -- record");
  return runs[runs.length - 1].runId;
};
const recordedInput = (runId: string): AgentInput => {
  const start = store.readEvents(runId).find((e): e is RunStartEvent => e.kind === "run.start");
  if (!start) throw new Error(`Run ${runId} has no run.start event`);
  return store.getBlob<AgentInput>(start.input);
};
const REQUEST = "Hi, my order #A1001 never arrived. Can you help?";
const runOpts = { store, models: AGENT_MODELS, tools: AGENT_TOOLS };

async function main() {
  switch (cmd) {
    case "record": {
      if (flag("api")) process.env.SHIPMENT_API = flag("api");
      const input = { request: REQUEST, instructions: flag("fixed") ? FIXED_INSTRUCTIONS : BASE_INSTRUCTIONS };
      const r = await startRun("support-agent", input, makeAgent(), runOpts);
      console.log(formatTimeline(store, r.runId));
      break;
    }
    case "runs":
      for (const m of store.listRuns()) {
        console.log(`${m.runId}  ${m.status.padEnd(5)}  ${m.replayOf ? `${m.replayOf.mode} of ${m.replayOf.runId}` : "live"}`);
      }
      break;
    case "show":
      console.log(formatTimeline(store, resolveRun(rest[0])));
      break;
    case "replay": {
      const source = resolveRun(rest[0]);
      // Point the live "API" at a fixed version: a strict replay must ignore it entirely.
      process.env.SHIPMENT_API = "v1";
      const r = await startRun("support-agent", recordedInput(source), makeAgent(), {
        ...runOpts, replay: { sourceRunId: source, mode: "strict" },
      });
      console.log(formatTimeline(store, r.runId));
      break;
    }
    case "fork": {
      const source = resolveRun(rest[0]);
      const writePolicy = (flag("write") ?? "stub") as "stub" | "block" | "allow";
      const input = { ...recordedInput(source), instructions: FIXED_INSTRUCTIONS }; // the "modified instructions"
      const r = await startRun("support-agent", input, makeAgent(), {
        ...runOpts, replay: { sourceRunId: source, mode: "hybrid", writePolicy },
      });
      console.log(formatTimeline(store, r.runId));
      console.log("\n" + formatDivergence(firstDivergence(store, source, r.runId, { toolsOnly: true })));
      break;
    }
    case "diff": {
      const [a, b] = [resolveRun(rest[0]), resolveRun(rest[1])];
      console.log(formatDivergence(firstDivergence(store, a, b, { toolsOnly: flag("tools") === "true" })));
      break;
    }
    default:
      console.log("Commands: record | runs | show | replay | fork | diff  (see header of demo/cli.ts)");
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
