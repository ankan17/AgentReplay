/**
 * Week-0 demo agent: a customer-support bot that handles "my package never
 * arrived" requests.
 *
 *   1. read the customer request
 *   2. lookupOrder   (read)  fake database
 *   3. getShipment   (read)  flaky external API — sometimes returns a v2 payload
 *   4. model reasons about the shipment
 *   5. refundOrder   (write) payments — FAILS when the API returned v2
 *   6. final answer
 *
 * The planted bug: the shipping API's v2 payload reports `insured_value: "49.99"`
 * (a dollar string) instead of `insuredValueCents: 4999`. The model passes it
 * straight through, and the refund tool rejects it at step 5. Re-running the
 * agent only reproduces this about half the time.
 *
 * The model is scripted (deterministic, offline, no API key) so the replay
 * machinery can be exercised end to end. Swap in a real model via an adapter
 * that implements `ChatModel`.
 */
import { wrapModel, wrapTool, snapshot } from "agentreplay";
import type { ChatMessage, ChatModel, ChatRequest, ChatResponse } from "agentreplay";
import { BASE_INSTRUCTIONS, FIXED_INSTRUCTIONS, PAYMENTS_LEDGER, TOOL_SCHEMAS, fetchShipment, findOrder, issueRefund } from "./world.ts";

export { BASE_INSTRUCTIONS, FIXED_INSTRUCTIONS, PAYMENTS_LEDGER };

// ---------------------------------------------------------------------------
// Tools: the fake world (world.ts), wrapped for recording
// ---------------------------------------------------------------------------

export const lookupOrder = wrapTool({ name: "lookupOrder", effect: "read", ...TOOL_SCHEMAS.lookupOrder }, findOrder);
export const getShipment = wrapTool({ name: "getShipment", effect: "read", ...TOOL_SCHEMAS.getShipment }, fetchShipment);
export const refundOrder = wrapTool({ name: "refundOrder", effect: "write", ...TOOL_SCHEMAS.refundOrder }, issueRefund);

const TOOLS = { lookupOrder, getShipment, refundOrder };

// ---------------------------------------------------------------------------
// Scripted "LLM"
// ---------------------------------------------------------------------------

/** Behaves like a tool-calling model, deterministically, based on what it sees. */
export const scriptedModel: ChatModel = {
  id: "scripted-support-v1",
  async generate(req: ChatRequest): Promise<ChatResponse> {
    const system = req.messages.find((m) => m.role === "system")?.content ?? "";
    const knowsUnits = /dollar strings/i.test(system);
    const result = (name: string) => {
      const m = req.messages.find((x) => x.role === "tool" && x.toolCallId?.startsWith(name));
      return m ? JSON.parse(m.content) : undefined;
    };
    const call = (name: string, args: unknown, content = ""): ChatResponse => ({
      message: { role: "assistant", content, toolCalls: [{ id: `${name}-1`, name, args }] },
      finishReason: "tool_calls",
    });

    const orderId = req.messages.find((m) => m.role === "user")?.content.match(/#(\w+)/)?.[1];
    const order = result("lookupOrder");
    if (!order) return call("lookupOrder", { orderId });

    const shipment = result("getShipment");
    if (!shipment) return call("getShipment", { trackingId: order.trackingId });

    const lost = shipment.status === "lost" || shipment.state === "LOST";
    const refund = result("refundOrder");
    if (lost && !refund) {
      let amount = shipment.insuredValueCents ?? shipment.insured_value;
      if (knowsUnits && typeof amount === "string") amount = Math.round(parseFloat(amount) * 100);
      return call(
        "refundOrder",
        { orderId: order.orderId, amountCents: amount, reason: "Carrier reports package lost" },
        "The carrier marked the package as lost, so I'll refund the insured value.",
      );
    }

    return {
      message: {
        role: "assistant",
        content: refund
          ? `Sorry ${order.customer}! Your package was lost, so I've refunded $${((refund.amountCents ?? refund.args?.amountCents) / 100).toFixed(2)} (ref ${refund.refundId ?? "pending"}).`
          : `Hi ${order.customer}, your package is on its way.`,
      },
      finishReason: "stop",
    };
  },
};

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------


export interface AgentInput {
  request: string;
  /** Part of the recorded input so a replay rebuilds the exact same agent. */
  instructions: string;
}

export function makeAgent(model: ChatModel = scriptedModel) {
  const llm = wrapModel(model);
  const specs = Object.values(TOOLS).map((t) => t.spec);

  return async function agent(input: AgentInput): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: input.instructions },
      { role: "user", content: input.request },
    ];

    for (let turn = 0; turn < 8; turn++) {
      snapshot(`messages.turn${turn}`, messages);
      const res = await llm.generate({ messages, tools: specs, params: { temperature: 0 } });
      messages.push(res.message);
      if (!res.message.toolCalls?.length) return res.message.content;

      for (const tc of res.message.toolCalls) {
        const tool = TOOLS[tc.name as keyof typeof TOOLS];
        if (!tool) throw new Error(`Model called unknown tool ${tc.name}`);
        const out = await (tool as (a: unknown) => Promise<unknown>)(tc.args);
        messages.push({ role: "tool", toolCallId: tc.id, content: JSON.stringify(out) });
      }
    }
    throw new Error("Agent exceeded max turns");
  };
}

export const AGENT_MODELS = [scriptedModel];
export const AGENT_TOOLS = Object.values(TOOLS);
