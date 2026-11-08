// LetraLab — servidor local.
// Sirve la interfaz, trae letras de LRCLIB, pide explicaciones a la IA
// (Gemini primero, Claude Haiku si Gemini falla o llega al límite) y guarda
// el vocabulario. Todo queda en la carpeta data/.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, "data");
const PUBLIC = path.join(ROOT, "public");

// ---------- configuración (.env) ----------
function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) {
      process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 8888);
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
// En el plan gratuito de Gemini solo están los modelos Flash-Lite.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "";

const claude = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

// ---------- almacenamiento en JSON ----------
for (const d of ["lyrics", "explanations", "words"]) {
  fs.mkdirSync(path.join(DATA, d), { recursive: true });
}
const keyOf = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJSON(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
const VOCAB_FILE = path.join(DATA, "vocab.json");
const STATS_FILE = path.join(DATA, "stats.json");

// ---------- IA ----------
class ProviderError extends Error {}

async function askGemini(system, prompt, schema) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        ...(schema ? { responseSchema: schema } : {}),
        maxOutputTokens: 32768,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new ProviderError(`Gemini ${res.status}${res.status === 429 ? " (límite alcanzado)" : ""}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text || "").join("") || "";
  try {
    return parseJSON(text, "Gemini");
  } catch (error) {
    console.warn(`[IA] Gemini terminó con ${candidate?.finishReason}; final de la respuesta: …${text.slice(-200)}`);
    throw error;
  }
}

// Gemini a veces devuelve un JSON roto: se reintenta una vez antes de pasar a Claude.
async function askGeminiWithRetry(system, prompt, schema) {
  try {
    return await askGemini(system, prompt, schema);
  } catch (error) {
    if (!(error instanceof ProviderError) || !/JSON/.test(error.message)) throw error;
    return askGemini(system, prompt, schema);
  }
}

// Esquemas de respuesta (formato OpenAPI que usa Gemini).
const EXPLAIN_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    lines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          i: { type: "INTEGER" },
          translation: { type: "STRING" },
          note: { type: "STRING" },
          key: { type: "STRING" },
        },
        required: ["i", "translation", "note", "key"],
      },
    },
  },
  required: ["summary", "lines"],
};
const DEFINE_SCHEMA = {
  type: "OBJECT",
  properties: {
    term: { type: "STRING" },
    meaning: { type: "STRING" },
    explanation: { type: "STRING" },
    pronunciation: { type: "STRING" },
  },
  required: ["term", "meaning", "explanation", "pronunciation"],
};

async function askClaude(system, prompt) {
  try {
    const response = await claude.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: prompt }],
    });
    if (response.stop_reason === "refusal") throw new ProviderError("Claude rechazó la solicitud");
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return parseJSON(text, "Claude");
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Anthropic.RateLimitError) throw new ProviderError("Claude: límite alcanzado");
    if (error instanceof Anthropic.AuthenticationError) throw new ProviderError("Claude: clave inválida");
    if (error instanceof Anthropic.APIError) throw new ProviderError(`Claude ${error.status}: ${error.message}`);
    throw new ProviderError(`Claude: ${error.message}`);
  }
}

function parseJSON(text, who) {
  const clean = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    throw new ProviderError(`${who} devolvió un JSON inválido`);
  }
}

// Gemini primero; si no hay clave, falla o llega al límite, Claude.
async function ask(system, prompt, schema) {
  const providers = [];
  if (GEMINI_KEY) providers.push(["gemini", (s, p) => askGeminiWithRetry(s, p, schema)]);
  if (claude) providers.push(["claude", askClaude]);
  if (!providers.length) throw new ProviderError("No hay ninguna clave de IA en el archivo .env");
  const errors = [];
  for (const [name, fn] of providers) {
    try {
      return { provider: name, result: await fn(system, prompt) };
    } catch (error) {
      console.warn(`[IA] ${error.message}`);
      errors.push(error.message);
    }
  }
  throw new ProviderError(errors.join(" | "));
}

const EXPLAIN_SYSTEM = `Eres un profesor de inglés para un hispanohablante de Colombia (nivel básico-intermedio) que aprende con las canciones que escucha.
Recibes la letra de una canción, una línea por índice. Para cada línea devuelve:
- "translation": traducción natural al español de Colombia (que suene como lo diría alguien de verdad, no palabra por palabra).
- "note": explicación corta (1-2 frases) SOLO si la línea tiene slang, una frase hecha, una metáfora, un doble sentido, una contracción informal (gonna, ain't, 'cause...) o gramática que valga la pena aprender. Si no, cadena vacía.
- "key": la palabra de la línea (copiada tal cual aparece, una sola palabra) más útil para que la aprenda: prioriza verbos, sustantivos y adjetivos frecuentes en inglés real o que formen parte de una expresión; nunca artículos, pronombres ni preposiciones sueltas. Cadena vacía si la línea no tiene ninguna útil (p. ej. "oh oh oh").
Además "summary": de qué trata la canción en 2-3 frases.
Responde únicamente con JSON con esta forma exacta:
{"summary": "...", "lines": [{"i": 0, "translation": "...", "note": "...", "key": "..."}]}
Incluye todas las líneas, en el mismo orden y con el mismo índice. Las líneas vacías devuélvelas con traducción vacía.`;

const DEFINE_SYSTEM = `Eres un profesor de inglés para un hispanohablante de Colombia. Te dan una palabra o expresión en inglés y la línea de canción donde aparece.
Responde únicamente con JSON: {"term": "la palabra o expresión en su forma base", "meaning": "significado en español en esa línea", "explanation": "1-2 frases: uso, registro (formal/informal/slang) y un ejemplo corto en inglés con su traducción", "pronunciation": "pronunciación aproximada escrita para un hispanohablante"}`;

// ---------- letras (LRCLIB) ----------
const LRCLIB_HEADERS = { "user-agent": "LetraLab/0.1 (app personal)" };

async function getLyrics({ track, artist, album, duration }) {
  const file = path.join(DATA, "lyrics", keyOf(`${artist}|${track}`.toLowerCase()) + ".json");
  const cached = readJSON(file, null);
  if (cached) return cached;

  let found = null;
  const params = new URLSearchParams({ track_name: track, artist_name: artist });
  if (album) params.set("album_name", album);
  if (duration) params.set("duration", String(Math.round(duration)));
  let res = await fetch(`https://lrclib.net/api/get?${params}`, { headers: LRCLIB_HEADERS });
  if (res.ok) found = await res.json();

  if (!found) {
    // Búsqueda más flexible si la exacta falla.
    const q = new URLSearchParams({ track_name: track, artist_name: artist });
    res = await fetch(`https://lrclib.net/api/search?${q}`, { headers: LRCLIB_HEADERS });
    if (res.ok) {
      const list = await res.json();
      found = list.find((x) => x.syncedLyrics) || list[0] || null;
    }
  }

  const result = found
    ? { found: true, synced: parseLRC(found.syncedLyrics), plain: found.plainLyrics || "", instrumental: !!found.instrumental }
    : { found: false };
  if (found) writeJSON(file, result);
  return result;
}

function parseLRC(lrc) {
  if (!lrc) return null;
  const out = [];
  for (const line of lrc.split(/\r?\n/)) {
    const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
    if (m) out.push({ time: Number(m[1]) * 60 + Number(m[2]), text: m[3].trim() });
  }
  return out.length ? out : null;
}

// ---------- servidor HTTP ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/api/config") {
      return send(res, 200, {
        spotifyClientId: SPOTIFY_CLIENT_ID,
        ai: { gemini: !!GEMINI_KEY, claude: !!claude, geminiModel: GEMINI_MODEL, claudeModel: CLAUDE_MODEL },
      });
    }

    if (url.pathname === "/api/lyrics") {
      const q = Object.fromEntries(url.searchParams);
      if (!q.track || !q.artist) return send(res, 400, { error: "Falta track o artist" });
      return send(res, 200, await getLyrics(q));
    }

    if (url.pathname === "/api/explain" && req.method === "POST") {
      const { track, artist, lines } = await readBody(req);
      const file = path.join(DATA, "explanations", keyOf(`${artist}|${track}`.toLowerCase()) + ".json");
      const cached = readJSON(file, null);
      if (cached) return send(res, 200, { ...cached, cached: true });
      const numbered = lines.map((t, i) => `${i}: ${t}`).join("\n");
      const { provider, result } = await ask(EXPLAIN_SYSTEM, `Canción: "${track}" de ${artist}\n\nLetra:\n${numbered}`, EXPLAIN_SCHEMA);
      const saved = { provider, summary: result.summary || "", lines: result.lines || [] };
      writeJSON(file, saved);
      return send(res, 200, saved);
    }

    if (url.pathname === "/api/define" && req.method === "POST") {
      const { word, line } = await readBody(req);
      const file = path.join(DATA, "words", keyOf(`${word}|${line}`.toLowerCase()) + ".json");
      const cached = readJSON(file, null);
      if (cached) return send(res, 200, cached);
      const { provider, result } = await ask(DEFINE_SYSTEM, `Palabra o expresión: "${word}"\nLínea: "${line}"`, DEFINE_SCHEMA);
      const saved = { provider, ...result };
      writeJSON(file, saved);
      return send(res, 200, saved);
    }

    if (url.pathname === "/api/vocab") {
      const vocab = readJSON(VOCAB_FILE, []);
      if (req.method === "GET") return send(res, 200, vocab);
      if (req.method === "POST") {
        const item = await readBody(req);
        const entry = { id: crypto.randomUUID(), added: new Date().toISOString(), box: 0, due: new Date().toISOString(), ...item };
        vocab.unshift(entry);
        writeJSON(VOCAB_FILE, vocab);
        return send(res, 200, entry);
      }
    }

    const vocabItem = url.pathname.match(/^\/api\/vocab\/([\w-]+)$/);
    if (vocabItem) {
      let vocab = readJSON(VOCAB_FILE, []);
      if (req.method === "DELETE") {
        vocab = vocab.filter((v) => v.id !== vocabItem[1]);
        writeJSON(VOCAB_FILE, vocab);
        return send(res, 200, { ok: true });
      }
      if (req.method === "PATCH") {
        const patch = await readBody(req);
        vocab = vocab.map((v) => (v.id === vocabItem[1] ? { ...v, ...patch } : v));
        writeJSON(VOCAB_FILE, vocab);
        return send(res, 200, { ok: true });
      }
    }

    // Actividad diaria para la racha: { "2026-11-07": { reviews, added, songs, cloze } }
    if (url.pathname === "/api/stats") {
      const stats = readJSON(STATS_FILE, {});
      if (req.method === "GET") return send(res, 200, stats);
      if (req.method === "POST") {
        const { type, day } = await readBody(req);
        if (!["reviews", "added", "songs", "cloze"].includes(type) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          return send(res, 400, { error: "Datos inválidos" });
        }
        stats[day] ??= {};
        stats[day][type] = (stats[day][type] || 0) + 1;
        writeJSON(STATS_FILE, stats);
        return send(res, 200, stats);
      }
    }

    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "No existe" });

    // Archivos estáticos (y /callback, a donde vuelve Spotify tras iniciar sesión).
    let file = url.pathname === "/" || url.pathname === "/callback" ? "/index.html" : url.pathname;
    file = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end("No encontrado");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    console.error(error);
    send(res, error instanceof ProviderError ? 502 : 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`LetraLab en http://127.0.0.1:${PORT}`);
  console.log(`IA: Gemini ${GEMINI_KEY ? "✔" : "✘"} · Claude ${claude ? "✔" : "✘"} · Spotify ${SPOTIFY_CLIENT_ID ? "✔" : "✘"}`);
});
