/**
 * MIRACKLE — SUPPORT INTAKE WORKER
 * ---------------------------------------------------------------
 * Routes
 *   POST /api/submit          receives the form, stores media, emails the team
 *   GET  /f/:ticket/:name?t=  serves a stored file (token-protected)
 *   GET  /health              quick check
 *   everything else           served from ./public (the form itself)
 *
 * Storage layout in R2
 *   temp/<ticket>/<file>       deleted automatically after 90 days
 *   keep/<ticket>/<file>       warranty candidates, never auto-deleted
 * ---------------------------------------------------------------
 */

const MAX_FILE_BYTES  = 60 * 1024 * 1024;   // per file
const MAX_TOTAL_BYTES = 90 * 1024 * 1024;   // per ticket

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }
    if (url.pathname === "/api/submit") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return handleSubmit(request, env, url);
    }
    if (url.pathname.startsWith("/f/")) {
      return serveFile(request, env, url);
    }
    // static assets (the form)
    return env.ASSETS.fetch(request);
  },
};

/* ============================ INTAKE ============================ */

async function handleSubmit(request, env, url) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Bad form data" }, 400);
  }

  const ticket = clean(form.get("ticket"), 40);
  if (!/^MRK-\d{6}-[A-Z0-9]{4}$/.test(ticket)) return json({ error: "Bad ticket id" }, 400);

  const company = clean(form.get("company"), 200);
  const invoice = clean(form.get("invoice"), 100);
  if (!company || !invoice) return json({ error: "Company and invoice are required" }, 400);

  const priority = ["critical", "high", "medium", "low"].includes(form.get("priority"))
    ? form.get("priority") : "medium";
  const category = clean(form.get("category"), 20);
  const warranty = form.get("warranty") === "1";
  const lang     = form.get("lang") === "es" ? "es" : "en";
  const report   = clean(form.get("report"), 20000);

  let payload = {};
  try { payload = JSON.parse(form.get("payload") || "{}"); } catch {}
  const id = payload.id || {};

  const token  = randomToken();
  const prefix = warranty ? "keep" : "temp";

  /* ---- store files in R2 ---- */
  const stored = [];
  let total = 0;

  for (const [key, value] of form.entries()) {
    if (!key.startsWith("file_") || typeof value === "string") continue;
    const size = value.size || 0;
    if (size === 0 || size > MAX_FILE_BYTES) continue;
    total += size;
    if (total > MAX_TOTAL_BYTES) break;

    const safe = key.slice(5).replace(/[^a-zA-Z0-9._-]/g, "_");
    const name = safe.includes(".") ? safe : safe + guessExt(value.type);
    const path = `${prefix}/${ticket}/${name}`;

    try {
      await env.MEDIA.put(path, value.stream(), {
        httpMetadata: { contentType: value.type || "application/octet-stream" },
      });
      stored.push({ name, path, size, type: value.type || "" });
    } catch (e) {
      console.error("R2 put failed", path, e);
    }
  }

  /* ---- record in D1 (text is permanent, even after photos expire) ---- */
  try {
    await env.DB.prepare(
      `INSERT INTO tickets
       (ticket, created_at, priority, category, warranty, company, invoice,
        contact, email, phone, purchase_date, site, model, lang, report,
        payload, files, token, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'new')`
    ).bind(
      ticket, new Date().toISOString(), priority, category, warranty ? 1 : 0,
      company, invoice,
      clean(id.contact, 200), clean(id.email, 200), clean(id.phone, 60),
      clean(id.purchase, 40), clean(id.site, 200), clean(id.model, 100),
      lang, report, JSON.stringify(payload), JSON.stringify(stored), token
    ).run();
  } catch (e) {
    console.error("D1 insert failed", e);
    // media is already saved; keep going so the email still goes out
  }

  /* ---- email the team ---- */
  let emailed = false;
  try {
    emailed = await sendEmail(env, url.origin, {
      ticket, priority, category, warranty, company, invoice,
      id, report, stored, token, lang,
    });
  } catch (e) {
    console.error("Email failed", e);
  }

  return json({ ok: true, ticket, files: stored.length, emailed });
}

/* ============================ EMAIL ============================ */

const CAT_LABEL = {
  ship: "Shipping or missing parts",
  asm:  "Assembly or mounting",
  cfg:  "Screen configuration",
  hw:   "Hardware failure",
  oth:  "Other",
};
const PRIO_COLOR = {
  critical: "#B3261E", high: "#D9382C", medium: "#C2761B", low: "#5B6470",
};

async function sendEmail(env, origin, t) {
  const provider = env.BREVO_API_KEY ? "brevo" : (env.RESEND_API_KEY ? "resend" : null);
  if (!provider) return false;

  const toList = (env.MAIL_TO || "contact@mirackle.us").split(",").map(s => s.trim());
  const fromEmail = env.MAIL_FROM_EMAIL || "no-reply@mirackle.us";
  const fromName  = env.MAIL_FROM_NAME  || "Mirackle Support";

  const link = f => `${origin}/f/${t.ticket}/${encodeURIComponent(f.name)}?t=${t.token}`;
  const photos = t.stored.filter(f => !f.name.endsWith(".pdf") && !f.type.startsWith("video"));
  const videos = t.stored.filter(f => f.type.startsWith("video"));
  const pdf    = t.stored.find(f => f.name.endsWith(".pdf"));

  const row = (k, v) => v
    ? `<tr><td style="padding:7px 14px 7px 0;color:#70707C;font-size:13px;white-space:nowrap">${esc(k)}</td>
         <td style="padding:7px 0;color:#0C0C10;font-size:14px;font-weight:600">${esc(v)}</td></tr>`
    : "";

  const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#F5F5F7;padding:24px">
 <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E6E6EA">
  <div style="background:#0C0C10;padding:20px 24px">
    <div style="color:#fff;font-size:13px;letter-spacing:.18em;font-weight:700">MIRACKLE</div>
    <div style="color:#9A9AA4;font-size:11px;letter-spacing:.12em;margin-top:3px">SUPPORT INTAKE</div>
  </div>

  <div style="padding:22px 24px 6px">
    <span style="display:inline-block;background:${PRIO_COLOR[t.priority]};color:#fff;
      font-size:11px;font-weight:700;letter-spacing:.12em;padding:6px 11px;border-radius:6px">
      ${t.priority.toUpperCase()}</span>
    ${t.warranty ? `<span style="display:inline-block;margin-left:6px;border:1px solid #D9382C;color:#D9382C;
      font-size:11px;font-weight:700;letter-spacing:.1em;padding:5px 10px;border-radius:6px">WARRANTY</span>` : ""}
    <div style="font-family:ui-monospace,Menlo,monospace;font-size:22px;color:#0C0C10;margin:14px 0 4px">
      ${esc(t.ticket)}</div>
    <div style="color:#70707C;font-size:14px">${esc(CAT_LABEL[t.category] || t.category)}</div>
  </div>

  <div style="padding:16px 24px 4px">
    <table style="width:100%;border-collapse:collapse">
      ${row("Company", t.company)}
      ${row("Invoice", t.invoice)}
      ${row("Contact", t.id.contact)}
      ${row("Email", t.id.email)}
      ${row("Phone", t.id.phone)}
      ${row("Purchase date", t.id.purchase)}
      ${row("Site", t.id.site)}
      ${row("Panel model", t.id.model)}
      ${row("Language", t.lang.toUpperCase())}
    </table>
  </div>

  <div style="padding:14px 24px 0">
    <div style="color:#D9382C;font-size:11px;font-weight:700;letter-spacing:.14em;margin-bottom:8px">
      FULL REPORT</div>
    <pre style="background:#FAFAFB;border:1px solid #EAEAEE;border-radius:10px;padding:14px;
      font-size:12px;line-height:1.55;color:#3A3A44;white-space:pre-wrap;word-break:break-word;margin:0">${esc(t.report)}</pre>
  </div>

  ${photos.length ? `
  <div style="padding:18px 24px 0">
    <div style="color:#D9382C;font-size:11px;font-weight:700;letter-spacing:.14em;margin-bottom:8px">
      PHOTOS (${photos.length})</div>
    ${photos.map(f => `<a href="${link(f)}" style="display:inline-block;margin:0 6px 6px 0;padding:9px 13px;
      background:#F3F3F6;border:1px solid #E2E2E8;border-radius:8px;color:#0C0C10;
      font-size:13px;text-decoration:none">${esc(f.name)}</a>`).join("")}
  </div>` : ""}

  ${videos.length ? `
  <div style="padding:14px 24px 0">
    <div style="color:#D9382C;font-size:11px;font-weight:700;letter-spacing:.14em;margin-bottom:8px">VIDEO</div>
    ${videos.map(f => `<a href="${link(f)}" style="display:inline-block;padding:9px 13px;background:#FDF3F2;
      border:1px solid #F0C9C5;border-radius:8px;color:#B3261E;font-size:13px;
      text-decoration:none">${esc(f.name)}</a>`).join("")}
  </div>` : ""}

  <div style="padding:20px 24px 26px;color:#9B9BA6;font-size:11.5px;line-height:1.6">
    ${pdf ? "The customer PDF is attached to this email.<br>" : ""}
    Photo links expire when media is purged${t.warranty ? " (this ticket is flagged for warranty and is retained)" : " after 90 days"}.
  </div>
 </div>
</div>`;

  const subject = `[${t.priority.toUpperCase()}] ${t.ticket} — ${CAT_LABEL[t.category] || t.category} — ${t.company} — INV ${t.invoice}`;

  /* attach the customer PDF (small enough to email) */
  let pdfB64 = null;
  if (pdf) {
    try {
      const obj = await env.MEDIA.get(pdf.path);
      if (obj) pdfB64 = toBase64(await obj.arrayBuffer());
    } catch (e) { console.error("PDF attach failed", e); }
  }

  /* ---------- Brevo: works with a single verified sender, no DNS ---------- */
  if (provider === "brevo") {
    const body = {
      sender: { name: fromName, email: fromEmail },
      to: toList.map(email => ({ email })),
      subject,
      htmlContent: html,
    };
    if (t.id.email) body.replyTo = { email: t.id.email };
    if (pdfB64) body.attachment = [{ name: `${t.ticket}.pdf`, content: pdfB64 }];

    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": env.BREVO_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error("Brevo error", res.status, await res.text());
      return false;
    }
    return true;
  }

  /* ---------- Resend: requires a verified domain ---------- */
  const body = {
    from: `${fromName} <${fromEmail}>`,
    to: toList,
    subject,
    html,
  };
  if (t.id.email) body.reply_to = t.id.email;
  if (pdfB64) body.attachments = [{ filename: `${t.ticket}.pdf`, content: pdfB64 }];

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error("Resend error", res.status, await res.text());
    return false;
  }
  return true;
}

/* ========================= FILE ACCESS ========================= */

async function serveFile(request, env, url) {
  const parts = url.pathname.split("/").filter(Boolean); // f, ticket, name
  if (parts.length < 3) return new Response("Not found", { status: 404 });

  const ticket = decodeURIComponent(parts[1]);
  const name   = decodeURIComponent(parts.slice(2).join("/"));
  const token  = url.searchParams.get("t") || "";

  let rowToken = null, warranty = 0;
  try {
    const row = await env.DB.prepare("SELECT token, warranty FROM tickets WHERE ticket = ?")
      .bind(ticket).first();
    if (row) { rowToken = row.token; warranty = row.warranty; }
  } catch (e) { console.error("D1 read failed", e); }

  if (!rowToken || !timingSafeEqual(rowToken, token)) {
    return new Response("Not authorized", { status: 403 });
  }

  const path = `${warranty ? "keep" : "temp"}/${ticket}/${name}`;
  const obj  = await env.MEDIA.get(path);
  if (!obj) return new Response("File not found or expired", { status: 404 });

  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("etag", obj.httpEtag);
  h.set("Cache-Control", "private, max-age=3600");
  h.set("Content-Disposition", `inline; filename="${name.replace(/"/g, "")}"`);
  return new Response(obj.body, { headers: h });
}

/* ============================ UTILS ============================ */

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function randomToken() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(36).padStart(2, "0")).join("").slice(0, 28);
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function guessExt(type = "") {
  if (type.includes("pdf")) return ".pdf";
  if (type.startsWith("video")) return ".mp4";
  if (type.includes("png")) return ".png";
  return ".jpg";
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
