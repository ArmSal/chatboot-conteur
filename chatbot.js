const fs = require("fs");
const readline = require("readline");

const API_KEY = process.env.GEMINI_API_KEY;
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
const MODELS = (process.env.MODELS || "gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-3-flash-preview,gemini-3.1-flash-lite").split(",");
const PROMPT_FILE = process.env.PROMPT_FILE || "system_prompt.txt";
const apiUrl = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

if (!API_KEY) {
  console.error("GEMINI_API_KEY manquante (voir .env.example).");
  process.exit(1);
}

const systemPrompt = fs.readFileSync(PROMPT_FILE, "utf8");
const contents = [];

async function ask(userText) {
  contents.push({ role: "user", parts: [{ text: userText }] });
  let data;
  const errors = [];
  for (const model of MODELS) {
    const res = await fetch(apiUrl(model), {
      method: "POST",
      signal: AbortSignal.timeout(25000),
      headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.8 },
      }),
    });
    if (res.ok) {
      data = await res.json();
      break;
    }
    errors.push(`${model}: ${res.status}`);
    console.error(`(${model} indisponible: ${res.status}, essai du suivant...)`);
  }
  let reply;
  if (data) {
    reply = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  } else if (CLAUDE_KEY) {
    // Dernier recours : Claude (payant)
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        messages: contents.map((c) => ({ role: c.role === "model" ? "assistant" : "user", content: c.parts[0].text })),
      }),
    });
    if (!res.ok) {
      contents.pop();
      throw new Error(`Gemini: ${errors.join(", ")} ; Claude: ${res.status} ${await res.text()}`);
    }
    reply = (await res.json()).content.map((b) => b.text ?? "").join("");
  } else {
    contents.pop();
    throw new Error(`Tous les modèles ont échoué. ${errors.join(", ")}`);
  }
  contents.push({ role: "model", parts: [{ text: reply }] });
  return reply;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log("Conteur d'histoires (Ctrl+C pour quitter). Demande une histoire !");
rl.setPrompt("> ");
rl.prompt();
rl.on("line", async (line) => {
  try {
    console.log("\n" + (await ask(line)) + "\n");
  } catch (e) {
    console.error("Erreur:", e.message);
  }
  rl.prompt();
});
