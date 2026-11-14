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
import { wrapModel, wrapTool, snapshot } from "../src/recorder.ts";
import type { ChatMessage, ChatModel, ChatRequest, ChatResponse } from "../src/schema.ts";

// ---------------------------------------------------------------------------
// Fake external systems
// ---------------------------------------------------------------------------

const ORDERS: Record<string, { orderId: string; customer: string; trackingId: string; totalCents: number }> = {
  A1001: { orderId: "A1001", customer: "Priya", trackingId: "TRK-77", totalCents: 4999 },
};

export const PAYMENTS_LEDGER: { orderId: string; amountCents: number }[] = [];

export const lookupOrder = wrapTool(
  {
    name: "lookupOrder",
    description: "Fetch an order from the orders database.",
    effect: "read",
    parameters: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
  },
  async ({ orderId }: { orderId: string }) => {
    const order = ORDERS[orderId];
    if (!order) throw new Error(`Order ${orderId} not found`);
    return order;
  },
);

export const getShipment = wrapTool(
  {
    name: "getShipment",
    description: "Fetch shipment status from the carrier API.",
    effect: "read",
    parameters: { type: "object", properties: { trackingId: { type: "string" } }, required: ["trackingId"] },
  },
  async ({ trackingId }: { trackingId: string }) => {
    await new Promise((r) => setTimeout(r, 20)); // network-ish latency
    // The carrier is mid-migration: some requests hit the v2 backend.
    const forced = process.env.SHIPMENT_API;
    const v2 = forced ? forced === "v2" : Math.random() < 0.5;
    return v2
      ? { tracking_id: trackingId, state: "LOST", insured_value: "49.99", api: "v2" }
      : { trackingId, status: "lost", insuredValueCents: 4999, api: "v1" };
  },
);

export const refundOrder = wrapTool(
  {
    name: "refundOrder",
    description: "Issue a refund to the customer's original payment method.",
    effect: "write",
    parameters: {
      type: "object",
      properties: { orderId: { type: "string" }, amountCents: { type: "integer" }, reason: { type: "string" } },
      required: ["orderId", "amountCents", "reason"],
    },
  },
  async ({ orderId, amountCents }: { orderId: string; amountCents: unknown; reason: string }) => {
    if (!Number.isInteger(amountCents) || (amountCents as number) <= 0) {
      throw new Error(`amountCents must be a positive integer, got ${JSON.stringify(amountCents)}`);
    }
    PAYMENTS_LEDGER.push({ orderId, amountCents: amountCents as number });
    console.log(`  💸 REAL SIDE EFFECT: refunded ${amountCents} cents for ${orderId}`);
    return { refundId: `RF-${orderId}`, amountCents };
  },
);

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

export const BASE_INSTRUCTIONS =
  "You are a support agent. Look up the order, check the shipment, and refund lost packages.";
export const FIXED_INSTRUCTIONS =
  BASE_INSTRUCTIONS + " Carrier APIs may report money as dollar strings; always convert to integer cents.";

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
