/**
 * The fake outside world both demo agents talk to (core `wrapModel` agent in
 * agent.ts, Vercel AI SDK agent in agent-ai-sdk.ts). Plain functions, no
 * recording: each agent wraps them its own way.
 */

export const ORDERS: Record<string, { orderId: string; customer: string; trackingId: string; totalCents: number }> = {
  A1001: { orderId: "A1001", customer: "Priya", trackingId: "TRK-77", totalCents: 4999 },
};

export const PAYMENTS_LEDGER: { orderId: string; amountCents: number }[] = [];

/** Orders database (read). */
export async function findOrder({ orderId }: { orderId: string }) {
  const order = ORDERS[orderId];
  if (!order) throw new Error(`Order ${orderId} not found`);
  return order;
}

/**
 * Carrier API (read). Mid-migration: some requests hit the v2 backend, which
 * reports money as a dollar string. SHIPMENT_API=v1|v2 pins it.
 */
export async function fetchShipment({ trackingId }: { trackingId: string }) {
  await new Promise((r) => setTimeout(r, 20)); // network-ish latency
  const forced = process.env.SHIPMENT_API;
  const v2 = forced ? forced === "v2" : Math.random() < 0.5;
  return v2
    ? { tracking_id: trackingId, state: "LOST", insured_value: "49.99", api: "v2" }
    : { trackingId, status: "lost", insuredValueCents: 4999, api: "v1" };
}

/** Payments (write) — the planted failure: rejects non-integer amounts. */
export async function issueRefund({ orderId, amountCents }: { orderId: string; amountCents: unknown; reason: string }) {
  if (!Number.isInteger(amountCents) || (amountCents as number) <= 0) {
    throw new Error(`amountCents must be a positive integer, got ${JSON.stringify(amountCents)}`);
  }
  PAYMENTS_LEDGER.push({ orderId, amountCents: amountCents as number });
  console.log(`  💸 REAL SIDE EFFECT: refunded ${amountCents} cents for ${orderId}`);
  return { refundId: `RF-${orderId}`, amountCents };
}

export const BASE_INSTRUCTIONS =
  "You are a support agent. Look up the order, check the shipment, and refund lost packages.";
export const FIXED_INSTRUCTIONS =
  BASE_INSTRUCTIONS + " Carrier APIs may report money as dollar strings; always convert to integer cents.";

/** JSON schemas of the three tools, shared by both agents. */
export const TOOL_SCHEMAS = {
  lookupOrder: {
    description: "Fetch an order from the orders database.",
    parameters: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
  },
  getShipment: {
    description: "Fetch shipment status from the carrier API.",
    parameters: { type: "object", properties: { trackingId: { type: "string" } }, required: ["trackingId"] },
  },
  refundOrder: {
    description: "Issue a refund to the customer's original payment method.",
    parameters: {
      type: "object",
      properties: { orderId: { type: "string" }, amountCents: { type: "integer" }, reason: { type: "string" } },
      required: ["orderId", "amountCents", "reason"],
    },
  },
} as const;
