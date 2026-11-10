// One-off setup: creates the Peek tools in Vapi and configures the assistant.
// Usage: node scripts/setup-vapi.js <assistantId> <publicUrl>
// Backs up the assistant to scripts/assistant-backup-<id>.json before changing it.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");

const [assistantId, publicUrlArg] = process.argv.slice(2);
const PUBLIC_URL = (publicUrlArg || process.env.PUBLIC_URL || "").replace(/\/$/, "");
if (!assistantId || !PUBLIC_URL) {
  console.error("Usage: node scripts/setup-vapi.js <assistantId> <publicUrl>");
  process.exit(1);
}
const H = { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, "Content-Type": "application/json" };
async function api(method, p, body) {
  const r = await fetch(`https://api.vapi.ai${p}`, { method, headers: H, body: body && JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} ${r.status}: ${t.slice(0, 500)}`);
  return t ? JSON.parse(t) : {};
}

const TOOLS_URL = `${PUBLIC_URL}/vapi/tools`;

const SYSTEM_PROMPT = `You are Peek, the friendly phone receptionist for a local plumbing company. You talk to customers who call with a plumbing problem.

How the call should go:
1. Greet the caller and ask what's going on with their plumbing.
2. As soon as they describe a problem, call the request_photo tool. Then tell them: "I just sent you a WhatsApp message. Can you reply to it with a photo of the problem?"
3. While you wait for the photo, keep the conversation going naturally: ask when it started, whether water is actively leaking, and what their address is. Do not invent a diagnosis or a price yourself.
4. When a system message arrives with the photo diagnosis, tell the caller right away in one or two short sentences: that you got the photo, what it looks like, and the estimated price range. Say it is an estimate until the plumber sees it in person.
5. Offer to book a plumber visit. Collect their full name, the service address, and a preferred time. Then call book_appointment with name, address, time and issue.
6. Confirm the booking details back to them, tell them the plumber has been notified, and wrap up politely.

If the photo never arrives, you can still book the visit without a diagnosis.

Style: warm, calm, concise. This is a phone call, so use short sentences, no lists, no markdown, and spell out prices naturally (for example "about one fifty to three hundred dollars").`;

const toolDefs = [
  {
    type: "function",
    async: false,
    function: {
      name: "request_photo",
      description:
        "Send the caller a WhatsApp message asking for a photo of their plumbing problem. Call this as soon as the caller describes an issue. Afterwards keep chatting; a system message with the diagnosis and price range will arrive automatically when the photo comes in.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    server: { url: TOOLS_URL, timeoutSeconds: 20 },
    messages: [{ type: "request-start", content: "Sending you a WhatsApp now." }],
  },
  {
    type: "function",
    async: false,
    function: {
      name: "book_appointment",
      description:
        "Book a plumber visit once the caller agrees. Collect their name, full address, and preferred time first. This also notifies the plumber.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Caller's full name" },
          address: { type: "string", description: "Full service address including city" },
          time: { type: "string", description: "Requested appointment date and time, e.g. 'Tomorrow 10am'" },
          issue: { type: "string", description: "Short description of the plumbing problem" },
        },
        required: ["name", "address", "time", "issue"],
      },
    },
    server: { url: TOOLS_URL, timeoutSeconds: 20 },
  },
];

(async () => {
  const before = await api("GET", `/assistant/${assistantId}`);
  const backupPath = path.join(__dirname, `assistant-backup-${assistantId}.json`);
  if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, JSON.stringify(before, null, 2));
  console.log(`Backup saved: ${backupPath}`);

  // Reuse existing Peek tools if this script already ran; update their URL.
  const existing = await api("GET", "/tool");
  const toolIds = [];
  for (const def of toolDefs) {
    const found = existing.find((t) => t.function?.name === def.function.name);
    if (found) {
      const { type, ...updatable } = def;
      await api("PATCH", `/tool/${found.id}`, updatable);
      console.log(`Updated tool ${def.function.name}: ${found.id}`);
      toolIds.push(found.id);
    } else {
      const created = await api("POST", "/tool", def);
      console.log(`Created tool ${def.function.name}: ${created.id}`);
      toolIds.push(created.id);
    }
  }

  const model = {
    provider: before.model?.provider || "openai",
    model: before.model?.model || "gpt-4.1",
    messages: [{ role: "system", content: SYSTEM_PROMPT }],
    toolIds,
  };
  if (before.model?.temperature !== undefined) model.temperature = before.model.temperature;

  const after = await api("PATCH", `/assistant/${assistantId}`, {
    name: "Peek",
    firstMessage: "Hi, thanks for calling. This is Peek. What's going on with your plumbing today?",
    model,
    transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
    silenceTimeoutSeconds: 180,
    server: { url: TOOLS_URL },
    serverMessages: ["tool-calls", "status-update", "end-of-call-report"],
    monitorPlan: { ...(before.monitorPlan || {}), controlEnabled: true },
  });
  console.log(
    `Assistant updated: name=${after.name} toolIds=${JSON.stringify(after.model?.toolIds)} server=${after.server?.url} controlEnabled=${after.monitorPlan?.controlEnabled} controlAuth=${after.monitorPlan?.controlAuthenticationEnabled ?? false}`
  );
})().catch((e) => {
  console.error("ERROR", e.message);
  process.exit(1);
});
