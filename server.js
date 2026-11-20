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
        signal: AbortSignal.timeout(30000),
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
    // Panne dès le 1er essai : vraie indisponibilité. Panne après une réponse refusée : histoire de secours.
    if (r === null) return i === 0 ? null : FALLBACK_STORY;
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
<meta name="description" content="Un conteur d'histoires pour les enfants de 6 à 9 ans.">
<meta name="color-scheme" content="light dark">
<title>Conteur d'histoires</title>
<link rel="icon" href="/coda.webp" type="image/webp">
<style>
  :root {
    --bg: #f7f4ff; --surface: #ffffff; --border: #e6e0f7; --text: #2d2a42; --muted: #6b6786;
    --primary: #6c5ce7; --on-primary: #ffffff; --hover: #efeaff; --sun: #ffd166;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14111f; --surface: #1e1a2e; --border: #332d4d; --text: #f0edfa; --muted: #aaa4c4;
      --primary: #a99bff; --on-primary: #14111f; --hover: #2a2442;
    }
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { height: 100%; }
  body {
    margin: 0; display: flex; flex-direction: column; background: var(--bg); color: var(--text);
    font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif; font-size: 16px; line-height: 1.5;
  }
  :focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  button, a { cursor: pointer; }

  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 20px; }
  .brand { display: flex; align-items: center; gap: 12px; font-weight: 600; font-size: 1.05rem; min-width: 0; }
  .brand img { width: 40px; height: 40px; border-radius: 50%; display: block; flex: none; box-shadow: 0 0 0 1px var(--border); }
  .brand span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .download {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 0 16px; flex: none;
    border-radius: 999px; border: 1.5px solid var(--primary); color: var(--primary); text-decoration: none; font-weight: 600; font-size: 0.9rem;
    transition: background 0.15s ease;
  }
  .download:hover { background: var(--hover); }
  .download svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

  main { flex: 1; overflow-y: auto; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 0 20px 24px; }

  #hello { text-align: center; padding-top: clamp(32px, 12vh, 110px); }
  #hello h1 { margin: 0 0 24px; font-size: clamp(1.8rem, 6vw, 2.6rem); line-height: 1.2; font-weight: 700; }
  #hello h1 mark { color: inherit; background: linear-gradient(transparent 62%, var(--sun) 62%); padding: 0 4px; }
  .chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
  .chip {
    min-height: 44px; padding: 0 18px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface);
    color: var(--text); font: inherit; font-size: 0.95rem; transition: background 0.15s ease, border-color 0.15s ease;
  }
  .chip:hover { background: var(--hover); border-color: var(--primary); }

  .row { display: flex; margin: 18px 0; }
  .row.user { justify-content: flex-end; }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .row.user .text { background: var(--primary); color: var(--on-primary); padding: 10px 18px; border-radius: 20px 20px 4px 20px; max-width: 85%; }
  .row.bot .text {
    background: var(--surface); border: 1px solid var(--border); border-radius: 20px 20px 20px 4px; padding: 18px 22px;
    font-family: Georgia, "Times New Roman", serif; font-size: 1.12rem; line-height: 1.75;
  }
  .row.error .text { border-color: #d64545; }
  .typing { display: inline-flex; gap: 5px; padding: 6px 0; }
  .typing i { width: 8px; height: 8px; border-radius: 50%; background: var(--primary); animation: blink 1.2s infinite; }
  .typing i:nth-child(2) { animation-delay: 0.2s; }
  .typing i:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }

  footer { padding: 8px 20px 16px; }
  form {
    max-width: 720px; margin: 0 auto; display: flex; align-items: flex-end; gap: 8px; padding: 6px 6px 6px 20px;
    background: var(--surface); border: 1.5px solid var(--border); border-radius: 28px;
  }
  form:focus-within { border-color: var(--primary); }
  textarea {
    flex: 1; border: 0; outline: 0; resize: none; background: transparent; color: var(--text);
    font: inherit; line-height: 1.5; padding: 10px 0; max-height: 150px; min-height: 44px;
  }
  textarea::placeholder { color: var(--muted); }
  #send {
    flex: none; width: 44px; height: 44px; border: 0; border-radius: 50%; background: var(--primary); color: var(--on-primary);
    display: grid; place-items: center; transition: opacity 0.15s ease;
  }
  #send:disabled { opacity: 0.35; cursor: default; }
  #send svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  .note { max-width: 720px; margin: 8px auto 0; text-align: center; color: var(--muted); font-size: 0.78rem; }

  @media (max-width: 520px) {
    header { padding: 10px 14px; }
    .download .lbl { display: none; }
    .download { width: 44px; padding: 0; }
    .wrap { padding: 0 14px 20px; }
    footer { padding: 6px 12px 12px; }
    .row.bot .text { padding: 14px 16px; }
  }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
<header>
  <div class="brand">
    <img src="/coda.webp" alt="Logo Coda" width="40" height="40">
    <span>Conteur d'histoires</span>
  </div>
  <a class="download" href="https://github.com/ArmSal/chatboot-conteur/archive/refs/heads/main.zip" target="_blank" rel="noopener" aria-label="Télécharger le projet">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg><span class="lbl">Télécharger le projet</span>
  </a>
</header>

<main id="main">
  <div class="wrap">
    <section id="hello">
      <h1>Quelle <mark>histoire</mark> veux-tu écouter&nbsp;?</h1>
      <div class="chips">
        <button class="chip" type="button">Un dragon qui a peur du feu</button>
        <button class="chip" type="button">Les 3 petits cochons</button>
        <button class="chip" type="button">Un robot et un petit pirate</button>
        <button class="chip" type="button">Une licorne qui cherche un ami</button>
      </div>
    </section>
    <div id="log" role="log" aria-live="polite" aria-label="Conversation"></div>
  </div>
</main>

<footer>
  <form id="f">
    <textarea id="q" rows="1" aria-label="Ta demande d'histoire" placeholder="Décris l'histoire que tu veux…" maxlength="${MAX_CHARS}" autocomplete="off"></textarea>
    <button id="send" type="submit" disabled aria-label="Envoyer">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
    </button>
  </form>
  <p class="note">Le conteur peut se tromper.</p>
</footer>

<script>
const log = document.getElementById("log"), q = document.getElementById("q"), send = document.getElementById("send");
const hello = document.getElementById("hello"), main = document.getElementById("main"), form = document.getElementById("f");
const messages = [];
let busy = false;

function scrollDown() { main.scrollTop = main.scrollHeight; }
function addRow(cls, content) {
  const row = document.createElement("div");
  row.className = "row " + cls;
  const t = document.createElement("div");
  t.className = "text";
  if (content) t.textContent = content;
  row.appendChild(t);
  log.appendChild(row);
  scrollDown();
  return row;
}
function resize() {
  q.style.height = "auto";
  q.style.height = q.scrollHeight + "px";
  send.disabled = busy || !q.value.trim();
}
async function ask(text) {
  if (busy) return;
  busy = true;
  hello.hidden = true;
  addRow("user", text);
  messages.push({ role: "user", content: text });
  const row = addRow("bot");
  const out = row.firstChild;
  out.innerHTML = '<span class="typing" aria-label="Le conteur écrit"><i></i><i></i><i></i></span>';
  resize();
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
    row.classList.add("error");
    out.textContent = "Oups : " + err.message;
  }
  busy = false;
  scrollDown();
  resize();
  q.focus();
}
form.onsubmit = (e) => {
  e.preventDefault();
  const text = q.value.trim();
  if (!text) return;
  q.value = "";
  ask(text);
};
q.addEventListener("input", resize);
q.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => ask(c.textContent.trim())));
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
