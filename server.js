// Conteur d'histoires : frontend (HTML ci-dessous) + backend (Node) dans un seul fichier.
const fs = require("fs");
const http = require("http");
const path = require("path");

const MAX_MESSAGES = 20;
const MAX_CHARS = 500;

// Nettoie l'historique reçu du navigateur. Retourne [] si l'entrée est invalide.
function cleanMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const msgs = [];
  for (const m of raw.slice(-MAX_MESSAGES)) {
    if (!m || typeof m !== "object" || typeof m.content !== "string") continue;
    if (m.content.includes("�")) continue; // UTF-8 invalide
    let text = m.content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim();
    text = [...text].slice(0, MAX_CHARS).join("");
    if (!text) continue;
    // Seuls "user" et "assistant" sont acceptés : tout autre rôle (ex. "system") devient "user".
    const role = m.role === "assistant" ? "assistant" : "user";
    if (!msgs.length && role !== "user") continue;
    msgs.push({ role, content: text });
  }
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return [];
  return msgs;
}

async function askGemini(msgs, system, key, models) {
  const contents = msgs.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  for (const model of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        signal: AbortSignal.timeout(25000),
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { temperature: 0.8 },
        }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts;
      if (parts) return parts.map((p) => p.text ?? "").join("");
    } catch {
      // modèle indisponible ou trop lent : on essaie le suivant
    }
  }
  return null;
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > limit) {
        reject(new Error("trop gros"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function createServer() {
  const key = process.env.GEMINI_API_KEY;
  const models = (process.env.MODELS || "gemini-3.5-flash-lite").split(",").map((s) => s.trim()).filter(Boolean);
  const system = fs.readFileSync(path.join(__dirname, "system_prompt.txt"), "utf8");

  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/") return send(res, 200, "text/html; charset=utf-8", PAGE);
    if (req.method !== "POST" || req.url !== "/chat") return send(res, 404, "text/plain", "Introuvable");

    let input;
    try {
      input = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, "application/json", JSON.stringify({ error: "Message invalide" }));
    }
    const msgs = cleanMessages(input?.messages);
    if (!msgs.length) return send(res, 400, "application/json", JSON.stringify({ error: "Message invalide" }));

    const reply = await askGemini(msgs, system, key, models);
    if (reply === null) {
      return send(res, 502, "application/json", JSON.stringify({ error: "Le conteur est indisponible, réessaie dans un instant." }));
    }
    send(res, 200, "application/json", JSON.stringify({ reply }));
  });
}

const PAGE = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conteur d'histoires</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 16px; background: #fffaf0; }
  #log { min-height: 300px; }
  .msg { padding: 10px 14px; border-radius: 12px; margin: 8px 0; white-space: pre-wrap; }
  .user { background: #dbeafe; margin-left: 20%; }
  .bot { background: #fde68a; margin-right: 10%; }
  form { display: flex; gap: 8px; }
  input { flex: 1; padding: 10px; font-size: 16px; }
  button { padding: 10px 16px; font-size: 16px; }
</style>
</head>
<body>
<h1>📖 Conteur d'histoires</h1>
<div id="log"></div>
<form id="f">
  <input id="q" autocomplete="off" placeholder="Demande une histoire…" maxlength="${MAX_CHARS}" required>
  <button>Envoyer</button>
</form>
<script>
const log = document.getElementById("log"), q = document.getElementById("q"), btn = document.querySelector("button");
const messages = [];
function add(cls, text) {
  const d = document.createElement("div");
  d.className = "msg " + cls;
  d.textContent = text;
  log.appendChild(d);
  d.scrollIntoView();
}
document.getElementById("f").onsubmit = async (e) => {
  e.preventDefault();
  const text = q.value.trim();
  if (!text) return;
  q.value = "";
  add("user", text);
  messages.push({ role: "user", content: text });
  btn.disabled = true;
  try {
    const r = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Erreur");
    messages.push({ role: "assistant", content: data.reply });
    add("bot", data.reply);
  } catch (err) {
    messages.pop();
    add("bot", "Oups : " + err.message);
  }
  btn.disabled = false;
  q.focus();
};
</script>
</body>
</html>`;

module.exports = { cleanMessages, createServer, MAX_MESSAGES, MAX_CHARS };

if (require.main === module) {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY manquante (voir .env).");
    process.exit(1);
  }
  const port = process.env.PORT || 3000;
  createServer().listen(port, () => console.log(`http://localhost:${port}`));
}
