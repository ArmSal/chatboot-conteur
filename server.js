// Conteur d'histoires : frontend (HTML ci-dessous) + backend (Node) dans un seul fichier.
const fs = require("fs");
const http = require("http");
const path = require("path");
const { checkStory, findLeaks } = require("./lib/story-rules.js");

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
      if (parts) return { text: parts.map((p) => p.text ?? "").join("") };
      return { blocked: true }; // Gemini a répondu mais refusé de générer (filtres de sécurité)
    } catch {
      // modèle indisponible ou trop lent : on essaie le suivant
    }
  }
  return null;
}

const FALLBACK_STORY =
  "Il était une fois un petit nuage qui voulait raconter une belle histoire. Il ne trouvait pas les mots. Alors il s'est reposé sous le soleil et il a rêvé de beaux jours. Fin.";
const MAX_ATTEMPTS = 3;

// Vérifie la réponse avant de l'envoyer : si elle ne respecte pas les règles, on régénère,
// puis on renvoie une histoire de secours. Retourne null seulement si Gemini est indisponible.
async function safeReply(msgs, system, key, models) {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const r = await askGemini(msgs, system, key, models);
    if (r === null) return null;
    if (r.blocked) return FALLBACK_STORY;
    const text = r.text.trim();
    if (!checkStory(text).length && !findLeaks(text, system).length) return text;
  }
  return FALLBACK_STORY;
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
  const logo = fs.readFileSync(path.join(__dirname, "assets", "coda.webp"));

  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/") return send(res, 200, "text/html; charset=utf-8", PAGE);
    if (req.method === "GET" && req.url === "/coda.webp") {
      res.writeHead(200, { "Content-Type": "image/webp", "Cache-Control": "public, max-age=86400" });
      return res.end(logo);
    }
    if (req.method !== "POST" || req.url !== "/chat") return send(res, 404, "text/plain", "Introuvable");

    let input;
    try {
      input = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, "application/json", JSON.stringify({ error: "Message invalide" }));
    }
    const msgs = cleanMessages(input?.messages);
    if (!msgs.length) return send(res, 400, "application/json", JSON.stringify({ error: "Message invalide" }));

    const reply = await safeReply(msgs, system, key, models);
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
  :root {
    --bg: #ffffff; --surface: #f0f4f9; --surface2: #e3e8ef; --text: #1f1f1f; --muted: #5f6368; --user: #e9eef6; --logo: 0.1;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #131314; --surface: #1e1f20; --surface2: #333537; --text: #e3e3e3; --muted: #9aa0a6; --user: #282a2c; --logo: 0.3; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100dvh; display: flex; flex-direction: column;
    background: var(--bg); color: var(--text);
    font-family: "Google Sans", "Segoe UI", system-ui, -apple-system, sans-serif;
  }
  /* Logo Coda en fond */
  body::before {
    content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background: url("/coda.webp") center / min(72vmin, 560px) no-repeat; opacity: var(--logo);
  }
  header, main, footer { position: relative; z-index: 1; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; }
  .brand { font-size: 1.25rem; font-weight: 500; }
  .download {
    display: inline-flex; align-items: center; gap: 8px; padding: 9px 16px; border-radius: 999px;
    background: var(--surface); color: var(--text); text-decoration: none; font-size: 0.9rem; font-weight: 500;
  }
  .download:hover { background: var(--surface2); }
  .download svg { width: 18px; height: 18px; fill: currentColor; }
  @media (max-width: 520px) { .brand { font-size: 1.05rem; } .download .long { display: none; } .chip { max-width: none; flex: 1 1 140px; } }
  main { flex: 1; overflow-y: auto; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 0 20px 24px; }
  #hello { padding-top: 12vh; }
  #hello h1 { margin: 0; font-size: clamp(2rem, 6vw, 3.4rem); font-weight: 500; line-height: 1.15; }
  #hello h1 span { background: linear-gradient(90deg, #4285f4, #9b72cb, #d96570); -webkit-background-clip: text; background-clip: text; color: transparent; }
  #hello h2 { margin: 4px 0 28px; font-size: clamp(1.6rem, 5vw, 3rem); font-weight: 500; color: var(--muted); }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; }
  .chip {
    border: 0; cursor: pointer; background: var(--surface); color: var(--text); font: inherit; font-size: 0.95rem;
    padding: 14px 18px; border-radius: 16px; text-align: left; max-width: 220px;
  }
  .chip:hover { background: var(--surface2); }
  .row { display: flex; gap: 14px; margin: 22px 0; }
  .row.user { justify-content: flex-end; }
  .row.user .text { background: var(--user); padding: 12px 18px; border-radius: 20px; max-width: 80%; }
  .row.bot .spark { flex: none; width: 28px; height: 28px; margin-top: 2px; }
  .text { white-space: pre-wrap; line-height: 1.65; font-size: 1rem; overflow-wrap: anywhere; }
  .typing { display: inline-flex; gap: 5px; padding-top: 8px; }
  .typing i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); animation: blink 1.2s infinite; }
  .typing i:nth-child(2) { animation-delay: 0.2s; }
  .typing i:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
  footer { padding: 0 20px 14px; }
  form {
    max-width: 760px; margin: 0 auto; display: flex; align-items: flex-end; gap: 8px;
    background: var(--surface); border-radius: 28px; padding: 8px 8px 8px 22px;
  }
  textarea {
    flex: 1; border: 0; outline: 0; resize: none; background: transparent; color: var(--text);
    font: inherit; font-size: 1rem; line-height: 1.5; padding: 10px 0; max-height: 160px;
  }
  textarea::placeholder { color: var(--muted); }
  #send {
    flex: none; width: 42px; height: 42px; border: 0; border-radius: 50%; cursor: pointer;
    background: var(--text); color: var(--bg); display: grid; place-items: center;
  }
  #send:disabled { opacity: 0.25; cursor: default; }
  #send svg { width: 22px; height: 22px; fill: currentColor; }
  .note { text-align: center; color: var(--muted); font-size: 0.75rem; margin: 10px 0 0; }
</style>
</head>
<body>
<header>
  <span class="brand">Conteur d'histoires</span>
  <a class="download" href="https://github.com/ArmSal/chatboot-conteur/archive/refs/heads/main.zip" target="_blank" rel="noopener">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg>
    <span>Télécharger<span class="long"> le projet</span></span>
  </a>
</header>

<main id="main">
  <div class="wrap">
    <div id="hello">
      <h1><span>Bonjour !</span></h1>
      <h2>Quelle histoire veux-tu écouter ?</h2>
      <div class="chips">
        <button class="chip" type="button">Un dragon qui a peur du feu</button>
        <button class="chip" type="button">Les 3 petits cochons</button>
        <button class="chip" type="button">Un robot et un petit pirate</button>
        <button class="chip" type="button">Une licorne qui cherche un ami</button>
      </div>
    </div>
    <div id="log"></div>
  </div>
</main>

<footer>
  <form id="f">
    <textarea id="q" rows="1" placeholder="Demande une histoire…" maxlength="${MAX_CHARS}" autocomplete="off"></textarea>
    <button id="send" type="submit" disabled aria-label="Envoyer">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l-1.4 1.4 5.6 5.6H4v2h12.2l-5.6 5.6L12 20l8-8z" transform="rotate(-90 12 12)"/></svg>
    </button>
  </form>
  <p class="note">Le conteur peut se tromper. Les histoires sont faites pour les enfants de 6 à 9 ans.</p>
</footer>

<script>
const log = document.getElementById("log"), q = document.getElementById("q"), send = document.getElementById("send");
const hello = document.getElementById("hello"), main = document.getElementById("main"), form = document.getElementById("f");
const messages = [];
const SPARK = '<svg class="spark" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4285f4"/><stop offset="0.55" stop-color="#9b72cb"/><stop offset="1" stop-color="#d96570"/></linearGradient></defs><path fill="url(#g)" d="M12 1c.6 5.8 5.2 10.4 11 11-5.8.6-10.4 5.2-11 11-.6-5.8-5.2-10.4-11-11 5.8-.6 10.4-5.2 11-11z"/></svg>';

function scrollDown() { main.scrollTop = main.scrollHeight; }
function addUser(text) {
  const row = document.createElement("div");
  row.className = "row user";
  const t = document.createElement("div");
  t.className = "text";
  t.textContent = text;
  row.appendChild(t);
  log.appendChild(row);
  scrollDown();
}
function addBot() {
  const row = document.createElement("div");
  row.className = "row bot";
  row.innerHTML = SPARK;
  const t = document.createElement("div");
  t.className = "text";
  t.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  row.appendChild(t);
  log.appendChild(row);
  scrollDown();
  return t;
}
function resize() {
  q.style.height = "auto";
  q.style.height = q.scrollHeight + "px";
  send.disabled = !q.value.trim();
}
async function ask(text) {
  hello.style.display = "none";
  addUser(text);
  messages.push({ role: "user", content: text });
  const out = addBot();
  send.disabled = true;
  try {
    const r = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Erreur");
    messages.push({ role: "assistant", content: data.reply });
    out.textContent = data.reply;
  } catch (err) {
    messages.pop();
    out.textContent = "Oups : " + err.message;
  }
  scrollDown();
  resize();
  q.focus();
}
form.onsubmit = (e) => {
  e.preventDefault();
  const text = q.value.trim();
  if (!text) return;
  q.value = "";
  resize();
  ask(text);
};
q.addEventListener("input", resize);
q.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => ask(c.textContent)));
</script>
</body>
</html>`;

module.exports = { cleanMessages, createServer, MAX_MESSAGES, MAX_CHARS, FALLBACK_STORY };

if (require.main === module) {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY manquante (voir .env).");
    process.exit(1);
  }
  const port = process.env.PORT || 3000;
  createServer().listen(port, () => console.log(`http://localhost:${port}`));
}
