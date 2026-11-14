/**
 * Demo CLI.
 *
 *   npm run demo -- record [--api v1|v2] [--fixed]   run the agent live and record it
 *        [--ai-sdk [--stream] [--model scripted|openai:<id>|anthropic:<id>]]
 *                                                     …using the Vercel AI SDK version of the agent
 *   npm run demo -- runs                             list recorded runs
 *   npm run demo -- show <runId|latest>              print the execution timeline
 *   npm run demo -- replay <runId|latest>            strict replay from the log
 *   npm run demo -- fork <runId> [--write stub|block|allow]
 *                                                     re-run with fixed instructions; model
 *                                                     live, tools from the log (hybrid)
 *   npm run demo -- diff <runA> <runB> [--tools]     first point of divergence
 */
import { startRun, FileStore, formatTimeline, firstDivergence, formatDivergence, type ReplayOptions, type RunStartEvent } from "agentreplay";
import { makeAgent, BASE_INSTRUCTIONS, FIXED_INSTRUCTIONS, AGENT_MODELS, AGENT_TOOLS, type AgentInput } from "./agent.ts";
import { makeAiSdkAgent, AI_SDK_TOOLS, type AiSdkAgentInput } from "./agent-ai-sdk.ts";

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
const recordedInput = <I = AgentInput>(runId: string): I => {
  const start = store.readEvents(runId).find((e): e is RunStartEvent => e.kind === "run.start");
  if (!start) throw new Error(`Run ${runId} has no run.start event`);
  return store.getBlob<I>(start.input);
};
const REQUEST = "Hi, my order #A1001 never arrived. Can you help?";

/** Both agents, keyed by run name, so replay/fork rebuild whichever agent recorded the run. */
const AGENTS = {
  "support-agent": { make: makeAgent, opts: { store, models: AGENT_MODELS, tools: AGENT_TOOLS } },
  "support-agent-ai-sdk": { make: () => makeAiSdkAgent(), opts: { store, tools: AI_SDK_TOOLS } },
} as const;
type AgentName = keyof typeof AGENTS;
const agentOf = (runId: string) => {
  const name = store.readMeta(runId).name as AgentName;
  if (!(name in AGENTS)) throw new Error(`Run ${runId} was recorded by "${name}", which this demo doesn't know.`);
  return { name, ...AGENTS[name] };
};
/** Type-erased start, since the two agents take different inputs. */
const run = (name: AgentName, input: unknown, replay?: ReplayOptions) =>
  startRun(name, input, AGENTS[name].make() as (i: unknown) => Promise<string>, { ...AGENTS[name].opts, replay });

async function main() {
  switch (cmd) {
    case "record": {
      if (flag("api")) process.env.SHIPMENT_API = flag("api");
      const instructions = flag("fixed") ? FIXED_INSTRUCTIONS : BASE_INSTRUCTIONS;
      const r = flag("ai-sdk")
        ? await run("support-agent-ai-sdk", {
            request: REQUEST, instructions, model: flag("model") ?? "scripted", stream: flag("stream") === "true",
          } satisfies AiSdkAgentInput)
        : await run("support-agent", { request: REQUEST, instructions } satisfies AgentInput);
      console.log(formatTimeline(store, r.runId));
      if (r.output) console.log(`\n${r.output}`);
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
      const r = await run(agentOf(source).name, recordedInput(source), { sourceRunId: source, mode: "strict" });
      console.log(formatTimeline(store, r.runId));
      break;
    }
    case "fork": {
      const source = resolveRun(rest[0]);
      const writePolicy = (flag("write") ?? "stub") as "stub" | "block" | "allow";
      const input = { ...recordedInput(source), instructions: FIXED_INSTRUCTIONS }; // the "modified instructions"
      const r = await run(agentOf(source).name, input, { sourceRunId: source, mode: "hybrid", writePolicy });
      console.log(formatTimeline(store, r.runId));
      if (r.output) console.log(`\n${r.output}`);
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
