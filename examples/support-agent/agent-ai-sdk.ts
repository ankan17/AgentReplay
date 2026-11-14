/**
 * The same support agent and planted step-5 bug as agent.ts, written the
 * Vercel AI SDK way: `generateText`/`streamText` with `tools: {}`, recorded
 * through @agentreplay/ai-sdk.
 *
 * One behavioural difference from agent.ts, and it's the AI SDK's: a tool
 * that throws doesn't end the run. The SDK turns the error into a tool-error
 * result and hands it to the model, so the planted bug shows up as an ERROR
 * on the refundOrder step followed by the model apologising — not as a
 * crashed run.
 *
 * Model: `scripted` (default; offline, deterministic, no key), or a real one
 * via `openai:<modelId>` / `anthropic:<modelId>` (needs OPENAI_API_KEY /
 * ANTHROPIC_API_KEY to record). The model choice is part of the recorded
 * input, so replay rebuilds the same agent — and a strict replay of a
 * real-model run makes no API calls, so it needs no key.
 */
import { generateText, streamText, tool, jsonSchema, isStepCount, wrapLanguageModel, type LanguageModel } from "ai";
import { recordedModel, recordedTools } from "@agentreplay/ai-sdk";
import { BASE_INSTRUCTIONS, FIXED_INSTRUCTIONS, TOOL_SCHEMAS, fetchShipment, findOrder, issueRefund } from "./world.ts";

export { BASE_INSTRUCTIONS, FIXED_INSTRUCTIONS };

export interface AiSdkAgentInput {
  request: string;
  instructions: string;
  /** "scripted" | "openai:<modelId>" | "anthropic:<modelId>" */
  model: string;
  stream: boolean;
}

// ---------------------------------------------------------------------------
// Tools: plain AI SDK tools over the fake world, auto-wrapped for recording
// ---------------------------------------------------------------------------

const schema = <T>(s: { parameters: object }) => jsonSchema<T>(s.parameters as Parameters<typeof jsonSchema>[0]);

export const TOOLS = recordedTools(
  {
    lookupOrder: tool({
      description: TOOL_SCHEMAS.lookupOrder.description,
      inputSchema: schema<{ orderId: string }>(TOOL_SCHEMAS.lookupOrder),
      execute: findOrder,
    }),
    getShipment: tool({
      description: TOOL_SCHEMAS.getShipment.description,
      inputSchema: schema<{ trackingId: string }>(TOOL_SCHEMAS.getShipment),
      execute: fetchShipment,
    }),
    refundOrder: tool({
      description: TOOL_SCHEMAS.refundOrder.description,
      inputSchema: schema<{ orderId: string; amountCents: number; reason: string }>(TOOL_SCHEMAS.refundOrder),
      execute: issueRefund,
    }),
  },
  { effects: { lookupOrder: "read", getShipment: "read", refundOrder: "write" } },
);

// ---------------------------------------------------------------------------
// Scripted model: a LanguageModelV4 that behaves like a tool-calling LLM,
// deterministically, based on what it sees in the prompt
// ---------------------------------------------------------------------------

type Model = Exclude<LanguageModel, string>;
/** The current spec version (LanguageModelV4), without depending on @ai-sdk/provider. */
type ModelV4 = ReturnType<typeof wrapLanguageModel>;
type CallOptions = Parameters<ModelV4["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<ModelV4["doGenerate"]>>;
type Part = { type: string; [k: string]: any };

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function decide({ prompt }: CallOptions): { tool: string; args: object; text?: string } | { text: string } {
  const system = prompt.find((m) => m.role === "system")?.content ?? "";
  const knowsUnits = /dollar strings/i.test(String(system));
  const results = prompt.flatMap((m) => (m.role === "tool" ? (m.content as Part[]) : [])).filter((p) => p.type === "tool-result");
  const result = (name: string) => results.find((r) => r.toolName === name)?.output as { type: string; value: any } | undefined;

  const request = prompt.filter((m) => m.role === "user").flatMap((m) => m.content as Part[]).map((p) => p.text ?? "").join(" ");
  const order = result("lookupOrder")?.value;
  if (!order) return { tool: "lookupOrder", args: { orderId: request.match(/#(\w+)/)?.[1] } };

  const shipment = result("getShipment")?.value;
  if (!shipment) return { tool: "getShipment", args: { trackingId: order.trackingId } };

  const lost = shipment.status === "lost" || shipment.state === "LOST";
  const refund = result("refundOrder");
  if (lost && !refund) {
    let amount = shipment.insuredValueCents ?? shipment.insured_value;
    if (knowsUnits && typeof amount === "string") amount = Math.round(parseFloat(amount) * 100);
    return {
      tool: "refundOrder",
      args: { orderId: order.orderId, amountCents: amount, reason: "Carrier reports package lost" },
      text: "The carrier marked the package as lost, so I'll refund the insured value.",
    };
  }
  if (refund?.type.startsWith("error")) {
    return { text: `Sorry ${order.customer}, I couldn't process your refund (${String(refund.value).slice(0, 80)}). A human will follow up.` };
  }
  if (refund) {
    const r = refund.value; // during a fork with writePolicy "stub": { stubbed: true, args }
    const cents = r.amountCents ?? r.args?.amountCents;
    return { text: `Sorry ${order.customer}! Your package was lost, so I've refunded $${(cents / 100).toFixed(2)} (ref ${r.refundId ?? "pending"}).` };
  }
  return { text: `Hi ${order.customer}, your package is on its way.` };
}

function content(step: ReturnType<typeof decide>, n: number): Part[] {
  const parts: Part[] = [];
  if (step.text) parts.push({ type: "text", text: step.text });
  if ("tool" in step) parts.push({ type: "tool-call", toolCallId: `${step.tool}-${n}`, toolName: step.tool, input: JSON.stringify(step.args) });
  return parts;
}

export function scriptedModel(): ModelV4 {
  let n = 0;
  const generate = async (options: CallOptions): Promise<GenerateResult> => {
    const step = decide(options);
    return {
      content: content(step, ++n) as GenerateResult["content"],
      finishReason: "tool" in step ? { unified: "tool-calls", raw: "tool_calls" } : { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    };
  };
  return {
    specificationVersion: "v4",
    provider: "scripted",
    modelId: "support-v1",
    supportedUrls: {},
    doGenerate: generate,
    async doStream(options) {
      const { content, finishReason } = await generate(options);
      const parts: Part[] = [{ type: "stream-start", warnings: [] }];
      for (const c of content as Part[]) {
        if (c.type === "text") {
          parts.push({ type: "text-start", id: "t" });
          for (const w of c.text.split(/(?<= )/)) parts.push({ type: "text-delta", id: "t", delta: w });
          parts.push({ type: "text-end", id: "t" });
        } else parts.push(c);
      }
      parts.push({ type: "finish", usage, finishReason });
      return {
        stream: new ReadableStream<any>({
          start(ctrl) {
            for (const p of parts) ctrl.enqueue(p);
            ctrl.close();
          },
        }),
      };
    },
  };
}

async function resolveModel(spec: string): Promise<Model> {
  if (spec === "scripted") return scriptedModel();
  const [provider, ...rest] = spec.split(":");
  const id = rest.join(":");
  if (provider === "openai" && id) return (await import("@ai-sdk/openai")).openai(id);
  if (provider === "anthropic" && id) return (await import("@ai-sdk/anthropic")).anthropic(id);
  throw new Error(`Unknown model "${spec}". Use scripted, openai:<modelId> or anthropic:<modelId>.`);
}

// ---------------------------------------------------------------------------
// Agent: the AI SDK runs the tool loop; every step is recorded by the adapter
// ---------------------------------------------------------------------------

export function makeAiSdkAgent(overrideModel?: Model) {
  return async function agent(input: AiSdkAgentInput): Promise<string> {
    const model = recordedModel(overrideModel ?? (await resolveModel(input.model)));
    const args = {
      model, tools: TOOLS, system: input.instructions, prompt: input.request,
      stopWhen: isStepCount(8), temperature: 0,
    };
    if (!input.stream) return (await generateText(args)).text;
    // Consume the stream like a UI would; textStream spans every step, so the
    // answer is the final step's text — the same thing generateText returns.
    const result = streamText(args);
    for await (const _ of result.textStream);
    return await result.text;
  };
}

export const AI_SDK_TOOLS = Object.values(TOOLS).map((t) => t.execute as unknown as { spec: import("agentreplay").ToolSpec });
