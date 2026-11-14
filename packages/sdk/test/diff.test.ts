import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeModelRequestChange, formatDivergence, type ChatRequest, type Divergence } from "agentreplay";

const base: ChatRequest = {
  messages: [
    { role: "system", content: "You are a support agent. Look up the order, check the shipment, and refund lost packages." },
    { role: "user", content: "Order #A1001 never arrived" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "lookupOrder", args: { orderId: "A1001" } }] },
    { role: "tool", toolCallId: "call_1", content: '{"status":"lost"}' },
  ],
  tools: [
    { name: "lookupOrder", description: "Fetch an order.", effect: "read", parameters: {} },
    { name: "refundOrder", description: "Refund.", effect: "write", parameters: {} },
  ],
  params: { temperature: 0 },
};
const chat = (payload: ChatRequest) => ({ format: "chat", payload });
const clone = (): ChatRequest => structuredClone(base);

test("a changed message is reported by position and role, clipped near the change", () => {
  const b = clone();
  b.messages[0].content += " Carrier APIs may report money as dollar strings.";
  assert.deepEqual(summarizeModelRequestChange(chat(base), chat(b)), [
    "message 1 (system): text changed",
    "    - …efund lost packages.",
    "    + …efund lost packages. Carrier APIs may report money as dollar strings.",
  ]);
});

test("added and removed messages, tool calls, tools and params", () => {
  const b = clone();
  b.messages[2].toolCalls![0].args = { orderId: "B2002" };
  b.messages.push({ role: "user", content: "hello?" });
  b.tools = [b.tools[0], { name: "getShipment", description: "Track.", effect: "read", parameters: {} }];
  b.params = { temperature: 0.7 };
  assert.deepEqual(summarizeModelRequestChange(chat(base), chat(b)), [
    "message 3 (assistant): tool calls changed",
    '    - lookupOrder({"orderId":"A1001"})',
    '    + lookupOrder({"orderId":"B2002"})',
    "+ message 5 (user): hello?",
    "+ tool getShipment",
    "- tool refundOrder",
    "params.temperature: 0 → 0.7",
  ]);
});

test("differences only in provider-issued ids are named as such", () => {
  const b = clone();
  b.messages[2].toolCalls![0].id = "call_XYZ";
  b.messages[3].toolCallId = "call_XYZ";
  assert.deepEqual(summarizeModelRequestChange(chat(base), chat(b)), [
    "only provider-issued ids differ (e.g. tool call ids) — expected between two live runs",
  ]);

  // …and mentioned alongside real changes
  b.messages[1].content = "Order #A1001 is late";
  const s = summarizeModelRequestChange(chat(base), chat(b));
  assert.equal(s[0], "message 2 (user): text changed");
  assert.equal(s.at(-1), "(2 other messages differ only in provider-issued ids)");
});

test("different payload formats are reported instead of compared", () => {
  assert.deepEqual(summarizeModelRequestChange(chat(base), { format: "ai-sdk/v4", payload: { prompt: [] } }), [
    "payload formats differ: chat → ai-sdk/v4",
  ]);
});

test("formatDivergence prints keys present on one side only instead of crashing", () => {
  const d: Divergence = {
    index: 0, reason: "different_request",
    changes: [{ path: "$.a", a: 1, b: undefined }, { path: "$.b", a: undefined, b: 2 }],
  };
  const out = formatDivergence(d);
  assert.match(out, /\$\.a\n\s+- 1\n\s+\+ \(absent\)/);
  assert.match(out, /\$\.b\n\s+- \(absent\)\n\s+\+ 2/);
});
