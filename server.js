require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");

const {
  PORT = 3000,
  PUBLIC_URL, // e.g. https://abc123.ngrok-free.app (used for photo links sent to the contractor)
  VAPI_API_KEY, // only needed if controlAuthenticationEnabled is on (use the PUBLIC key then)
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  CONTRACTOR_WHATSAPP,
  ANTHROPIC_API_KEY,
  VISION_MODEL = "claude-sonnet-5-5",
} = process.env;

// Lazy so the server still boots (and the dashboard works) before keys are filled in.
let _twilio;
const twilioClient = {
  messages: {
    create: (opts) => (_twilio ||= twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)).messages.create(opts),
  },
};
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
const callsByPhone = new Map(); // normalized phone -> call record
const callsById = new Map(); // vapi call id -> same call record
let latestCallId = null;

function normalizePhone(p) {
  if (!p) return "";
  return "+" + String(p).replace(/^whatsapp:/i, "").replace(/\D/g, "");
}
function wa(p) {
  const s = String(p || "");
  return s.startsWith("whatsapp:") ? s : `whatsapp:${normalizePhone(s)}`;
}
function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

function getOrCreateCall(call) {
  const id = call?.id;
  if (!id) return null;
  let rec = callsById.get(id);
  if (!rec) {
    rec = {
      callId: id,
      phone: normalizePhone(call.customer?.number),
      controlUrl: call.monitor?.controlUrl || null,
      status: "in-progress",
      events: [],
      startedAt: new Date().toISOString(),
      photo: null, // { buffer, contentType }
      diagnosis: null,
      booking: null,
      contractorMessage: null,
    };
    callsById.set(id, rec);
  }
  if (call.monitor?.controlUrl) rec.controlUrl = call.monitor.controlUrl;
  if (call.customer?.number) rec.phone = normalizePhone(call.customer.number);
  if (rec.phone) callsByPhone.set(rec.phone, rec);
  latestCallId = id;
  return rec;
}
function event(rec, text) {
  rec.events.push({ at: new Date().toISOString(), text });
  log(`[${rec.callId.slice(0, 8)}] ${text}`);
}

// ---------------------------------------------------------------------------
// Vapi Live Call Control
// https://docs.vapi.ai/calls/call-features  (POST JSON to call.monitor.controlUrl)
// ---------------------------------------------------------------------------
async function vapiControl(rec, body) {
  if (!rec.controlUrl) throw new Error("No controlUrl for this call");
  const headers = { "Content-Type": "application/json" };
  // Only required when the assistant has controlAuthenticationEnabled=true,
  // and then it must be your PUBLIC key (a private key returns 400 Unauthorized).
  if (process.env.VAPI_CONTROL_AUTH === "true" && VAPI_API_KEY) {
    headers.Authorization = `Bearer ${VAPI_API_KEY}`;
  }
  const r = await fetch(rec.controlUrl, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`controlUrl ${r.status}: ${text}`);
  return text;
}

// ---------------------------------------------------------------------------
// Vapi webhook: tool calls (+ status updates if you point the server URL here)
// ---------------------------------------------------------------------------
app.post("/vapi/tools", async (req, res) => {
  const msg = req.body?.message || {};
  const call = msg.call || req.body?.call;
  const rec = getOrCreateCall(call);

  if (msg.type === "status-update" && rec) {
    rec.status = msg.status || rec.status;
    event(rec, `Call status: ${rec.status}`);
    return res.json({});
  }
  if (msg.type === "end-of-call-report" && rec) {
    rec.status = "ended";
    event(rec, `Call ended (${msg.endedReason || "unknown reason"})`);
    return res.json({});
  }
  if (msg.type !== "tool-calls") return res.json({});

  const toolCalls = msg.toolCallList || msg.toolCalls || [];
  const results = [];
  for (const tc of toolCalls) {
    const name = tc.function?.name || tc.name;
    let args = tc.function?.arguments ?? tc.arguments ?? {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    let result;
    try {
      if (!rec) throw new Error("No call object in payload");
      if (name === "request_photo") result = await requestPhoto(rec);
      else if (name === "book_appointment") result = await bookAppointment(rec, args);
      else result = `Unknown tool ${name}`;
    } catch (err) {
      log(`Tool ${name} failed:`, err.message);
      result = `Error: ${err.message}`;
    }
    results.push({ toolCallId: tc.id, result });
  }
  res.json({ results });
});

async function requestPhoto(rec) {
  if (!rec.phone || rec.phone === "+") {
    return "I couldn't get the caller's phone number (web calls have none). Ask them to describe the problem instead.";
  }
  const uploadLink = PUBLIC_URL ? `${PUBLIC_URL.replace(/\/$/, "")}/u/${rec.callId}` : null;
  rec.uploadLink = uploadLink;
  rec.status = "waiting-for-photo";
  try {
    await twilioClient.messages.create({
      from: wa(TWILIO_WHATSAPP_FROM),
      to: wa(rec.phone),
      body:
        "Hi, this is Peek 👋 Please send us a photo of the plumbing problem " +
        "(leak, fixture, pipe, etc.). We'll look at it while you're still on the call." +
        (uploadLink ? `\n\nTap here to send it: ${uploadLink}` : ""),
    });
    event(rec, `WhatsApp photo request sent to ${rec.phone}`);
  } catch (err) {
    // Don't break the call if WhatsApp isn't set up; the dashboard upload still works.
    event(rec, `WhatsApp send failed (${err.message}); use the dashboard upload`);
  }
  return (
    "Photo request sent to the caller on WhatsApp. Tell them to reply with a photo, " +
    "then keep chatting (ask about the problem, when it started, their address). " +
    "You'll receive a system message with the diagnosis as soon as the photo arrives."
  );
}

async function bookAppointment(rec, { name, address, time, issue }) {
  rec.booking = { name, address, time, issue, bookedAt: new Date().toISOString() };
  rec.status = "booked";
  event(rec, `Booked: ${name} @ ${time}, ${address}`);

  const d = rec.diagnosis;
  const lines = [
    "🔧 *Nueva cita – Peek*",
    `👤 Cliente: ${name || "—"}`,
    `📞 Teléfono: ${rec.phone || "—"}`,
    `📍 Dirección: ${address || "—"}`,
    `🕒 Hora: ${time || "—"}`,
    `📝 Problema: ${d?.issue_es || issue || "—"}`,
    `🩺 Diagnóstico: ${d?.diagnosis_es || "Sin foto / sin diagnóstico"}`,
    `💵 Estimado: ${d ? `$${d.price_low}–$${d.price_high} USD` : "Por determinar"}`,
  ];
  const body = lines.join("\n");
  rec.contractorMessage = body;

  const payload = { from: wa(TWILIO_WHATSAPP_FROM), to: wa(CONTRACTOR_WHATSAPP), body };
  const base = PUBLIC_URL || rec.publicBase;
  if (rec.photo && base) payload.mediaUrl = [`${base.replace(/\/$/, "")}/media/${rec.callId}`];

  try {
    await twilioClient.messages.create(payload);
    event(rec, "Spanish summary sent to contractor on WhatsApp");
  } catch (err) {
    event(rec, `Contractor WhatsApp failed: ${err.message}`);
  }
  return `Appointment booked for ${name} at ${time}, ${address}. The plumber has been notified. Confirm the details to the caller.`;
}

// ---------------------------------------------------------------------------
// Twilio WhatsApp webhook: customer's photo reply
// ---------------------------------------------------------------------------
app.post("/twilio/whatsapp", async (req, res) => {
  // Reply to Twilio immediately with an empty 200 (no TwiML: the new-console
  // "Try out WhatsApp" trial flow doesn't accept TwiML responses); process async.
  res.status(200).end();

  const from = normalizePhone(req.body.From);
  const numMedia = parseInt(req.body.NumMedia || "0", 10);
  const rec = callsByPhone.get(from);
  if (!rec) return log(`WhatsApp from ${from} with no active call, ignoring`);

  // Remember our public URL from the ngrok host, as a fallback for PUBLIC_URL.
  const host = req.get("x-forwarded-host") || req.get("host");
  if (host) rec.publicBase = `https://${host}`;

  if (numMedia < 1) {
    event(rec, `WhatsApp text (no photo): "${req.body.Body || ""}"`);
    return;
  }

  try {
    event(rec, "Photo received on WhatsApp, downloading…");
    const photo = await downloadTwilioMedia(req.body.MediaUrl0, req.body.MediaContentType0);
    await processPhoto(rec, photo, req.body.Body);
  } catch (err) {
    rec.status = "error";
    event(rec, `Photo pipeline failed: ${err.message}`);
  }
});

// Web upload: works without any Twilio inbound webhook. The customer gets this
// link in the WhatsApp message; the dashboard also has an upload button.
app.get("/u/:callId", (req, res) => res.type("html").send(UPLOAD_HTML));
app.post(
  "/upload/:callId",
  express.raw({ type: "image/*", limit: "15mb" }),
  async (req, res) => {
    const rec = req.params.callId === "latest" ? callsById.get(latestCallId) : callsById.get(req.params.callId);
    if (!rec) return res.status(404).json({ error: "No active call" });
    if (!req.body?.length) return res.status(400).json({ error: "No image" });
    event(rec, "Photo uploaded via web link");
    res.json({ ok: true });
    try {
      await processPhoto(rec, { buffer: req.body, contentType: req.get("content-type") });
    } catch (err) {
      rec.status = "error";
      event(rec, `Photo pipeline failed: ${err.message}`);
    }
  }
);

async function processPhoto(rec, photo, caption) {
  {
    rec.photo = photo;
    rec.status = "diagnosing";
    event(rec, `Photo received (${Math.round(photo.buffer.length / 1024)} KB), diagnosing…`);

    const diagnosis = await diagnose(photo, caption);
    rec.diagnosis = diagnosis;
    rec.status = "diagnosed";
    event(rec, `Diagnosis: ${diagnosis.diagnosis} ($${diagnosis.price_low}–$${diagnosis.price_high})`);

    try {
    await vapiControl(rec, {
      type: "add-message",
      message: {
        role: "system",
        content:
          `The customer's photo just arrived. Diagnosis: ${diagnosis.diagnosis} ` +
          `Severity: ${diagnosis.severity}. Estimated price range: $${diagnosis.price_low} to $${diagnosis.price_high}. ` +
          "Tell the caller right now, in one or two friendly sentences, that you got their photo, " +
          "what it looks like, and the price range (say it's an estimate pending an on-site visit). " +
          "Then offer to book a plumber visit.",
      },
      triggerResponseEnabled: true,
    });
    event(rec, "Diagnosis injected into live call");
    } catch (err) {
      event(rec, `Diagnosis ready, but couldn't speak it into the call (is the call still live?): ${err.message}`);
    }
  }
}

const UPLOAD_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Peek · Send a photo</title>
<style>body{margin:0;font:17px/1.5 -apple-system,system-ui,sans-serif;background:#f6f7f9;color:#14171a;display:flex;min-height:100vh;align-items:center;justify-content:center}
.c{background:#fff;border-radius:16px;padding:28px 22px;max-width:380px;width:calc(100% - 32px);text-align:center;box-shadow:0 2px 12px #0001}
label{display:block;background:#0f766e;color:#fff;border-radius:12px;padding:16px;font-weight:600;cursor:pointer;margin-top:16px}
input{display:none}img{max-width:100%;border-radius:10px;margin-top:14px}#s{margin-top:12px;color:#667085}</style></head>
<body><div class="c"><h2 style="margin:0">📸 Send us a photo</h2><p>Take a photo of the plumbing problem. We'll look at it while you're on the call.</p>
<label>Take or choose photo<input id="f" type="file" accept="image/*" capture="environment"></label><div id="p"></div><div id="s"></div></div>
<script>
document.getElementById("f").onchange=async e=>{const file=e.target.files[0];if(!file)return;
document.getElementById("p").innerHTML='<img src="'+URL.createObjectURL(file)+'">';const s=document.getElementById("s");s.textContent="Sending…";
const id=location.pathname.split("/").pop();
try{const r=await fetch("/upload/"+encodeURIComponent(id),{method:"POST",headers:{"Content-Type":file.type||"image/jpeg"},body:file});
s.textContent=r.ok?"✅ Got it! You can go back to the call.":"Something went wrong ("+r.status+"). Please try again.";}catch(err){s.textContent="Upload failed, please try again."}};
</script></body></html>`;

async function downloadTwilioMedia(url, contentType) {
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` }, redirect: "follow" });
  if (!r.ok) throw new Error(`Media download ${r.status}`);
  const buffer = Buffer.from(await r.arrayBuffer());
  return { buffer, contentType: contentType || r.headers.get("content-type") || "image/jpeg" };
}

const SUPPORTED_IMAGE = ["image/jpeg", "image/png", "image/gif", "image/webp"];

async function diagnose(photo, caption) {
  const mediaType = SUPPORTED_IMAGE.includes(photo.contentType) ? photo.contentType : "image/jpeg";
  const resp = await anthropic.messages.create({
    model: VISION_MODEL,
    max_tokens: 400,
    system:
      "You are an experienced licensed plumber in the US triaging a customer's photo. " +
      "Reply with ONLY a JSON object, no markdown, with keys: " +
      '"diagnosis" (1-2 short spoken-style English sentences), ' +
      '"diagnosis_es" (same in Spanish), "issue_es" (3-6 word Spanish summary of the problem), ' +
      '"severity" ("low" | "medium" | "urgent"), "price_low" (integer USD), "price_high" (integer USD). ' +
      "Price is a typical labor+parts range for a residential service call. " +
      "If the image is not plumbing-related or unclear, say so in diagnosis and give a generic service-call range.",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: photo.buffer.toString("base64") } },
          { type: "text", text: caption ? `Customer's note: "${caption}"` : "Diagnose this plumbing problem." },
        ],
      },
    ],
  });
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const d = JSON.parse(json);
  return {
    diagnosis: d.diagnosis,
    diagnosis_es: d.diagnosis_es,
    issue_es: d.issue_es,
    severity: d.severity || "medium",
    price_low: Number(d.price_low) || 0,
    price_high: Number(d.price_high) || 0,
  };
}

// ---------------------------------------------------------------------------
// Media + dashboard
// ---------------------------------------------------------------------------
app.get("/media/:callId", (req, res) => {
  const rec = callsById.get(req.params.callId);
  if (!rec?.photo) return res.sendStatus(404);
  res.type(rec.photo.contentType).send(rec.photo.buffer);
});

app.get("/api/latest", (req, res) => {
  const rec = latestCallId && callsById.get(latestCallId);
  if (!rec) return res.json(null);
  const { photo, controlUrl, ...rest } = rec;
  res.json({ ...rest, hasPhoto: !!photo });
});

app.get("/dashboard", (req, res) => res.type("html").send(DASHBOARD_HTML));
app.get("/", (req, res) => res.redirect("/dashboard"));

const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Peek Dashboard</title>
<style>
  :root{--bg:#f6f7f9;--card:#fff;--text:#14171a;--muted:#667085;--border:#e4e7ec;--accent:#0f766e;--pill:#e6f4f1}
  @media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--text:#e6edf3;--muted:#8b949e;--border:#30363d;--accent:#2dd4bf;--pill:#12302c}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif}
  main{max-width:1000px;margin:0 auto;padding:24px 16px}
  header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}
  h1{margin:0;font-size:22px}h2{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  .status{padding:4px 12px;border-radius:999px;background:var(--pill);color:var(--accent);font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px}
  img{max-width:100%;border-radius:8px;display:block}
  .muted{color:var(--muted)}.big{font-size:22px;font-weight:700}
  pre{white-space:pre-wrap;margin:0;font:14px/1.5 ui-monospace,Menlo,monospace}
  ul{margin:0;padding-left:18px}li{margin:2px 0}
  .up{display:inline-block;margin-top:10px;padding:8px 12px;border-radius:8px;background:var(--pill);color:var(--accent);font-weight:600;cursor:pointer}.up input{display:none}
  dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:4px 12px}dt{color:var(--muted)}dd{margin:0}
</style></head><body><main>
<header><h1>Peek · Latest call</h1><div><label class="up">📷 Upload photo<input type="file" accept="image/*" onchange="up(this)"></label> <span id="status" class="status">waiting</span></div></header>
<div id="root" class="muted">No calls yet. Call your Vapi number.</div>
</main>
<script>
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
let lastPhoto=null;
async function tick(){
  try{
    const r=await fetch("/api/latest");const c=await r.json();
    if(!c){return}
    document.getElementById("status").textContent=c.status;
    const d=c.diagnosis,b=c.booking;
    const photo=c.hasPhoto?'<img src="/media/'+encodeURIComponent(c.callId)+'?v='+(d?1:0)+'" alt="Customer photo">':'<p class="muted">No photo yet</p>';
    document.getElementById("root").className="";
    document.getElementById("root").innerHTML=
     '<div class="grid">'+
      '<div class="card"><h2>Call</h2><dl><dt>Caller</dt><dd>'+esc(c.phone)+'</dd><dt>Call ID</dt><dd>'+esc(c.callId.slice(0,12))+'…</dd><dt>Started</dt><dd>'+new Date(c.startedAt).toLocaleTimeString()+'</dd></dl></div>'+
      '<div class="card"><h2>Photo</h2>'+photo+'</div>'+
      '<div class="card"><h2>Diagnosis</h2>'+(d?'<div class="big">$'+d.price_low+' – $'+d.price_high+'</div><p>'+esc(d.diagnosis)+'</p><p class="muted">Severity: '+esc(d.severity)+'</p>':'<p class="muted">Waiting for photo</p>')+'</div>'+
      '<div class="card"><h2>Booking</h2>'+(b?'<dl><dt>Name</dt><dd>'+esc(b.name)+'</dd><dt>Time</dt><dd>'+esc(b.time)+'</dd><dt>Address</dt><dd>'+esc(b.address)+'</dd><dt>Issue</dt><dd>'+esc(b.issue)+'</dd></dl>':'<p class="muted">Not booked yet</p>')+'</div>'+
      '<div class="card"><h2>Sent to contractor (ES)</h2>'+(c.contractorMessage?'<pre>'+esc(c.contractorMessage)+'</pre>':'<p class="muted">Nothing sent yet</p>')+'</div>'+
      '<div class="card"><h2>Timeline</h2><ul>'+c.events.slice().reverse().map(e=>'<li><span class="muted">'+new Date(e.at).toLocaleTimeString()+'</span> '+esc(e.text)+'</li>').join("")+'</ul></div>'+
     '</div>';
  }catch(e){}
}
async function up(input){const f=input.files[0];if(!f)return;await fetch("/upload/latest",{method:"POST",headers:{"Content-Type":f.type||"image/jpeg"},body:f});tick();}
tick();setInterval(tick,2000);
</script></body></html>`;

app.listen(PORT, () => {
  log(`Peek listening on http://localhost:${PORT}  (dashboard: /dashboard)`);
  const missing = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM", "CONTRACTOR_WHATSAPP", "ANTHROPIC_API_KEY"]
    .filter((k) => !process.env[k]);
  if (missing.length) log(`⚠️  Missing env vars: ${missing.join(", ")}`);
  if (!PUBLIC_URL) log("ℹ️  PUBLIC_URL not set; the contractor photo link will use the ngrok host from the WhatsApp webhook.");
});
