import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const attempts = new Map();
const windowMs = 60 * 60 * 1000;
const limit = 5;

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function clean(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 16_000) throw new Error("payload_too_large");
  }
  return JSON.parse(raw || "{}");
}

async function handleContact(request, response) {
  const ip = String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").split(",")[0].trim();
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter(time => now - time < windowMs);
  if (recent.length >= limit) return json(response, 429, { ok: false, error: "Please wait before sending another message." });

  let body;
  try { body = await readJson(request); }
  catch { return json(response, 400, { ok: false, error: "Your message could not be read." }); }

  if (clean(body.website_confirm, 10)) return json(response, 200, { ok: true });

  const message = {
    name: clean(body.name, 120),
    email: clean(body.email, 254),
    subject: clean(body.subject, 160),
    order: clean(body.order, 160),
    text: clean(body.message, 5000)
  };

  if (!message.name || !message.subject || !message.text || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.email)) {
    return json(response, 422, { ok: false, error: "Please complete the required fields with a valid email address." });
  }

  if (!process.env.RESEND_API_KEY) {
    console.error("Contact email is not configured: RESEND_API_KEY is missing");
    return json(response, 503, { ok: false, error: "Email delivery is being configured. Please try again shortly." });
  }

  const text = [
    "New MasterStudio2 contact message", "",
    `Name: ${message.name}`,
    `Email: ${message.email}`,
    `Topic: ${message.subject}`,
    `Order or receipt: ${message.order || "Not provided"}`, "",
    "Message:", message.text
  ].join("\n");

  try {
    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: process.env.CONTACT_FROM || "MasterStudio2 Website <website@forms.masterstudio2.com>",
        to: [process.env.CONTACT_TO || "contact@3rdbioai.com"],
        reply_to: message.email,
        subject: `MasterStudio2 — ${message.subject}`,
        text
      })
    });

    if (!emailResponse.ok) {
      console.error("Contact email failed", emailResponse.status, await emailResponse.text());
      return json(response, 502, { ok: false, error: "We could not send your message. Please try again." });
    }

    attempts.set(ip, [...recent, now]);
    return json(response, 200, { ok: true });
  } catch (error) {
    console.error("Contact email error", error);
    return json(response, 502, { ok: false, error: "We could not send your message. Please try again." });
  }
}

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", "http://localhost").pathname;

  if (pathname === "/health") return json(response, 200, { status: "ok", service: "masterstudio2-contact" });
  if (pathname === "/api/contact" && request.method === "POST") return handleContact(request, response);

  if (["/", "/contact", "/contact/", "/index.html"].includes(pathname)) {
    try {
      const html = await readFile(path.join(root, "index.html"));
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300"
      });
      response.end(html);
    } catch {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("Website unavailable");
    }
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Page not found");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`MasterStudio2 contact listening on port ${port}`);
});
