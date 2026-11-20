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
<meta name="description" content="Un conteur d'histoires pour les enfants de 6 à 9 ans.">
<meta name="color-scheme" content="light dark">
<title>Conteur d'histoires</title>
<link rel="icon" href="/coda.webp" type="image/webp">
<style>
  :root {
    --bg: #f6f6fa; --surface: #ffffff; --border: #e2e0ec; --text: #1a1030; --muted: #5b5675;
    --primary: #1a1030; --on-primary: #ffffff; --ring: #1a1030; --hover: #eeedf5;
    --shadow: 0 1px 2px rgba(26, 16, 48, 0.06), 0 4px 16px rgba(26, 16, 48, 0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e0a19; --surface: #181226; --border: #2e2745; --text: #f1eff8; --muted: #a8a1c0;
      --primary: #d8f548; --on-primary: #1a1030; --ring: #d8f548; --hover: #221a38;
      --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html { height: 100%; }
  body {
    margin: 0; height: 100%; display: flex; flex-direction: column; background: var(--bg); color: var(--text);
    font-family: Inter, "Segoe UI", system-ui, -apple-system, Roboto, sans-serif; font-size: 16px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  :focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  button, a { cursor: pointer; }

  /* En-tête avec le logo dans le coin */
  header {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 10px 20px; background: var(--surface); border-bottom: 1px solid var(--border);
  }
  .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .brand img { width: 40px; height: 40px; border-radius: 50%; flex: none; display: block; box-shadow: 0 0 0 1px var(--border); }
  .brand strong { display: block; font-size: 1rem; font-weight: 600; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .brand small { display: block; font-size: 0.78rem; color: var(--muted); line-height: 1.2; }
  .actions { display: flex; gap: 8px; flex: none; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; min-width: 44px; padding: 0 14px;
    border-radius: 10px; border: 1px solid var(--border); background: var(--surface); color: var(--text);
    font: inherit; font-size: 0.9rem; font-weight: 500; text-decoration: none; transition: background 0.15s ease, border-color 0.15s ease;
  }
  .btn:hover { background: var(--hover); border-color: var(--muted); }
  .btn.primary { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
  .btn.primary:hover { opacity: 0.9; }
  .btn svg, .chip svg { width: 20px; height: 20px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

  main { flex: 1; overflow-y: auto; }
  .wrap { max-width: 780px; margin: 0 auto; padding: 0 20px 28px; }

  /* Accueil */
  #hello { padding-top: clamp(28px, 9vh, 80px); }
  #hello h1 { margin: 0 0 8px; font-size: clamp(1.7rem, 5vw, 2.4rem); font-weight: 650; line-height: 1.15; letter-spacing: -0.02em; }
  #hello p { margin: 0 0 28px; color: var(--muted); font-size: 1.05rem; max-width: 52ch; }
  .chips { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .chip {
    display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 14px 16px; text-align: left;
    background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 14px;
    font: inherit; font-size: 0.95rem; font-weight: 500; box-shadow: var(--shadow);
    transition: border-color 0.15s ease, transform 0.15s ease;
  }
  .chip:hover { border-color: var(--primary); transform: translateY(-1px); }
  .chip .ico { flex: none; width: 36px; height: 36px; border-radius: 10px; background: var(--hover); display: grid; place-items: center; }

  /* Conversation */
  .row { display: flex; gap: 12px; margin: 20px 0; }
  .row.user { justify-content: flex-end; }
  .row.user .text { background: var(--primary); color: var(--on-primary); padding: 11px 16px; border-radius: 18px 18px 4px 18px; max-width: 82%; }
  .avatar { flex: none; width: 32px; height: 32px; border-radius: 50%; background: var(--primary); color: var(--on-primary); display: grid; place-items: center; margin-top: 2px; }
  .avatar svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .row.bot .text {
    background: var(--surface); border: 1px solid var(--border); border-radius: 4px 18px 18px 18px; padding: 16px 20px;
    font-family: Charter, "Iowan Old Style", Georgia, "Times New Roman", serif; font-size: 1.1rem; line-height: 1.75; box-shadow: var(--shadow);
    max-width: calc(100% - 44px);
  }
  .row.error .text { border-color: #c0392b; }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .typing { display: inline-flex; gap: 5px; padding: 6px 0; }
  .typing i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); animation: blink 1.2s infinite; }
  .typing i:nth-child(2) { animation-delay: 0.2s; }
  .typing i:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }

  /* Saisie */
  footer { padding: 8px 20px 14px; background: linear-gradient(to top, var(--bg) 70%, transparent); }
  form {
    max-width: 780px; margin: 0 auto; display: flex; align-items: flex-end; gap: 8px; padding: 8px 8px 8px 18px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow);
  }
  form:focus-within { border-color: var(--ring); }
  textarea {
    flex: 1; border: 0; outline: 0; resize: none; background: transparent; color: var(--text);
    font: inherit; line-height: 1.5; padding: 10px 0; max-height: 160px; min-height: 44px;
  }
  textarea::placeholder { color: var(--muted); }
  #send {
    flex: none; width: 44px; height: 44px; border: 0; border-radius: 12px; background: var(--primary); color: var(--on-primary);
    display: grid; place-items: center; transition: opacity 0.15s ease;
  }
  #send:disabled { opacity: 0.3; cursor: default; }
  #send svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .note { max-width: 780px; margin: 8px auto 0; display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 0.78rem; }

  @media (max-width: 560px) {
    header { padding: 8px 12px; }
    .btn .lbl { display: none; }
    .btn { padding: 0; width: 44px; }
    .brand small { display: none; }
    .wrap { padding: 0 14px 20px; }
    footer { padding: 6px 12px 10px; }
    .row.user .text { max-width: 90%; }
    .row.bot .text { padding: 14px 16px; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
<header>
  <div class="brand">
    <img src="/coda.webp" alt="Logo Coda" width="40" height="40">
    <div>
      <strong>Conteur d'histoires</strong>
      <small>Pour les enfants de 6 à 9 ans</small>
    </div>
  </div>
  <div class="actions">
    <button class="btn" id="reset" type="button" aria-label="Nouvelle histoire" hidden>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span class="lbl">Nouvelle histoire</span>
    </button>
    <a class="btn primary" href="https://github.com/ArmSal/chatboot-conteur/archive/refs/heads/main.zip" target="_blank" rel="noopener" aria-label="Télécharger le projet">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg><span class="lbl">Télécharger le projet</span>
    </a>
  </div>
</header>

<main id="main">
  <div class="wrap">
    <section id="hello">
      <h1>Quelle histoire veux-tu écouter&nbsp;?</h1>
      <p>Choisis une idée ci-dessous ou décris ce que tu veux. Chaque histoire est courte, douce et pensée pour les enfants.</p>
      <div class="chips">
        <button class="chip" type="button"><span class="ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg></span>Un dragon qui a peur du feu</button>
        <button class="chip" type="button"><span class="ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V6a2 2 0 012-2h13v14H6a2 2 0 00-2 2zM6 18h13"/></svg></span>Les 3 petits cochons</button>
        <button class="chip" type="button"><span class="ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/></svg></span>Un robot et un petit pirate</button>
        <button class="chip" type="button"><span class="ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg></span>Une licorne qui cherche un ami</button>
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
  <div class="note"><span>Le conteur peut se tromper.</span><span id="count" aria-hidden="true"></span></div>
</footer>

<script>
const log = document.getElementById("log"), q = document.getElementById("q"), send = document.getElementById("send");
const hello = document.getElementById("hello"), main = document.getElementById("main"), form = document.getElementById("f");
const reset = document.getElementById("reset"), count = document.getElementById("count");
const MAX = q.maxLength;
let messages = [];
let busy = false;
const BOOK = '<span class="avatar"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V6a2 2 0 012-2h13v14H6a2 2 0 00-2 2zM6 18h13"/></svg></span>';

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
  row.innerHTML = BOOK;
  const t = document.createElement("div");
  t.className = "text";
  t.innerHTML = '<span class="typing" aria-label="Le conteur écrit"><i></i><i></i><i></i></span>';
  row.appendChild(t);
  log.appendChild(row);
  scrollDown();
  return row;
}
function resize() {
  q.style.height = "auto";
  q.style.height = q.scrollHeight + "px";
  send.disabled = busy || !q.value.trim();
  count.textContent = q.value.length > MAX * 0.8 ? q.value.length + " / " + MAX : "";
}
async function ask(text) {
  if (busy) return;
  busy = true;
  hello.hidden = true;
  reset.hidden = false;
  addUser(text);
  messages.push({ role: "user", content: text });
  const row = addBot();
  const out = row.querySelector(".text");
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
reset.onclick = () => {
  messages = [];
  log.textContent = "";
  hello.hidden = false;
  reset.hidden = true;
  q.focus();
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
