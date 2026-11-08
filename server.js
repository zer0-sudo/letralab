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
// Si el modelo principal está saturado (503) o al límite (429), se prueban estos, que también
// son gratis. Comprobado el 2026-11-08: los 2.5 ya no están para cuentas nuevas.
const GEMINI_FALLBACKS = (process.env.GEMINI_FALLBACKS || "gemini-3.5-flash-lite,gemini-3.1-flash-lite")
  .split(",").map((m) => m.trim()).filter(Boolean);
const GEMINI_MODELS = [...new Set([GEMINI_MODEL, ...GEMINI_FALLBACKS])];
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
const PLAYS_FILE = path.join(DATA, "plays.json"); // historial propio: { played_at: canción }
const LANG_FILE = path.join(DATA, "lang.json");   // idioma ya calculado por canción

// ---------- IA ----------
class ProviderError extends Error {
  constructor(message, { transient = false } = {}) {
    super(message);
    this.transient = transient; // saturado o al límite: vale la pena otro modelo o esperar
  }
}

async function askGemini(model, system, prompt, schema) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(90000),
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
  } catch (error) {
    throw new ProviderError(`Gemini (${model}) no respondió: ${error.message}`, { transient: true });
  }
  if (!res.ok) {
    const body = await res.text();
    const transient = [429, 500, 502, 503, 504].includes(res.status);
    throw new ProviderError(`Gemini ${model} ${res.status}${res.status === 429 ? " (límite alcanzado)" : ""}: ${body.slice(0, 200)}`, { transient });
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

// Prueba los modelos de Gemini en orden. Un JSON roto se reintenta una vez con el mismo
// modelo; si está saturado o al límite, pasa al siguiente. Si todos lo están, espera unos
// segundos y da una segunda vuelta (los picos de demanda suelen durar poco).
async function askGeminiWithRetry(system, prompt, schema) {
  let last;
  for (let round = 0; round < 2; round++) {
    if (round) await new Promise((r) => setTimeout(r, 4000));
    for (const model of GEMINI_MODELS) {
      try {
        try {
          return await askGemini(model, system, prompt, schema);
        } catch (error) {
          if (!/JSON/.test(error.message)) throw error;
          return await askGemini(model, system, prompt, schema);
        }
      } catch (error) {
        last = error;
        console.warn(`[IA] ${error.message.slice(0, 160)}`);
        if (!error.transient && !/JSON/.test(error.message)) throw error;
      }
    }
  }
  if (last?.transient) {
    throw new ProviderError("Gemini está saturado en este momento (pasa a ratos). Espera un minuto y toca «Reintentar».", { transient: true });
  }
  throw last;
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

// LRCLIB a veces falla o limita si se le piden muchas letras seguidas: reintentar con pausa.
async function lrclib(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: LRCLIB_HEADERS, signal: AbortSignal.timeout(15000) });
      if (res.ok || res.status === 404 || attempt >= 2) return res;
    } catch (e) {
      if (attempt >= 2) throw e;
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
}

async function getLyrics({ track, artist, album, duration }) {
  const file = path.join(DATA, "lyrics", keyOf(`${artist}|${track}`.toLowerCase()) + ".json");
  const cached = readJSON(file, null);
  if (cached) return cached;

  let found = null;
  const params = new URLSearchParams({ track_name: track, artist_name: artist });
  if (album) params.set("album_name", album);
  if (duration) params.set("duration", String(Math.round(duration)));
  let res = await lrclib(`https://lrclib.net/api/get?${params}`);
  if (res.ok) found = await res.json();
  else if (res.status !== 404) throw new Error(`LRCLIB respondió ${res.status}`);

  if (!found) {
    // Búsqueda más flexible si la exacta falla.
    const q = new URLSearchParams({ track_name: track, artist_name: artist });
    res = await lrclib(`https://lrclib.net/api/search?${q}`);
    if (!res.ok) throw new Error(`LRCLIB respondió ${res.status}`);
    const list = await res.json();
    found = list.find((x) => x.syncedLyrics) || list[0] || null;
  }

  const result = found
    ? { found: true, synced: parseLRC(found.syncedLyrics), plain: found.plainLyrics || "", instrumental: !!found.instrumental }
    : { found: false };
  if (found) writeJSON(file, result);
  return result;
}

// ---------- idioma de una letra ----------
// Cuenta, línea por línea, palabras muy frecuentes que solo existen en inglés o solo en
// español. Sin IA: es instantáneo y gratis, y con letras completas acierta de sobra.
const EN_WORDS = new Set(("the you i i'm i'll i've i'd you're your yours it's is are was were be been am " +
  "and but or if what when where who why how this that these those my mine me we us our they them their " +
  "he she his her him it with without for from of to in on at by up down out over just like know want " +
  "don't can't won't ain't gonna wanna gotta can will would should could do does did have has had get got " +
  "go going love feel never ever always all not no yeah oh baby girl boy night day time life one more " +
  "now then there here again only still way make made say said see tell think need let back away too " +
  "every some something nothing anything everything around through into").split(" "));
const ES_WORDS = new Set(("el la los las un una unos unas que de del y en por para con sin es eres soy " +
  "estoy está estás están son era fue ser estar yo tú tu tus mi mis te nos se lo le les su sus ella él " +
  "ellos nosotros usted pero porque cuando donde como qué quién cómo muy más menos ya también siempre " +
  "nunca todo toda todos nada algo aquí allá ahora hoy noche día vida amor quiero quieres tengo tienes " +
  "hay voy vas va vamos hacer hago sé sabes puedo puede mucho poco bien mal así esta este eso esto ese " +
  "esa contigo conmigo mami papi bebé corazón otra otro vez hasta desde sobre entre").split(" "));

function englishRatio(lines) {
  let en = 0, es = 0;
  for (const raw of lines) {
    const line = raw.toLowerCase();
    let e = 0, s = /[ñáéíóú¿¡]/.test(line) ? 2 : 0;
    for (const w of line.match(/[a-záéíóúñü']+/g) || []) {
      if (EN_WORDS.has(w)) e++;
      if (ES_WORDS.has(w)) s++;
    }
    if (e > s) en++;
    else if (s > e) es++;
  }
  return en + es ? en / (en + es) : null;
}

// "en" si al menos el 60 % de las líneas son en inglés: así una canción en español con un
// coro o unas frases en inglés cuenta como español.
async function songLanguage(song) {
  const key = `${song.artist}|${song.track}`.toLowerCase();
  const cache = readJSON(LANG_FILE, {});
  const hit = cache[key];
  // Las que no tenían letra se vuelven a buscar al día siguiente.
  if (hit && (hit.lang !== "unknown" || Date.now() - hit.at < 864e5)) return hit;

  const lyr = await getLyrics(song);
  let result;
  if (lyr.instrumental) result = { lang: "instrumental" };
  else if (lyr.found) {
    const lines = lyr.synced ? lyr.synced.map((l) => l.text) : lyr.plain.split(/\r?\n/);
    const ratio = englishRatio(lines.filter((l) => l.trim()));
    result = ratio === null ? { lang: "unknown" } : { lang: ratio >= 0.6 ? "en" : "es", en: Math.round(ratio * 100) };
  } else {
    // Sin letra: al menos mirar el título.
    const ratio = englishRatio([song.track]);
    result = { lang: ratio === 0 ? "es" : "unknown" };
  }
  result.at = Date.now();
  const fresh = readJSON(LANG_FILE, {});
  fresh[key] = result;
  writeJSON(LANG_FILE, fresh);
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
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

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

    // Idioma de varias canciones: { songs: [{ id, track, artist, album, duration }] } → { id: { lang, en } }
    if (url.pathname === "/api/lang" && req.method === "POST") {
      const { songs = [] } = await readBody(req);
      const out = {};
      const queue = songs.slice(0, 50);
      // De a 2 a la vez, para no saturar LRCLIB. Si una falla, no se guarda: se reintenta luego.
      await Promise.all(Array.from({ length: 2 }, async () => {
        for (let s = queue.shift(); s; s = queue.shift()) {
          try { out[s.id] = await songLanguage(s); } catch { out[s.id] = { lang: "unknown" }; }
        }
      }));
      // Sin letra: si las demás canciones del artista que ya conocemos son en español, esta
      // también lo es casi seguro.
      const known = Object.entries(readJSON(LANG_FILE, {}));
      for (const s of songs) {
        if (out[s.id]?.lang !== "unknown") continue;
        const artist = s.artist.toLowerCase() + "|";
        const langs = known.filter(([k, v]) => k.startsWith(artist) && ["en", "es"].includes(v.lang)).map(([, v]) => v.lang);
        const es = langs.filter((l) => l === "es").length;
        if (langs.length && es / langs.length >= 0.7) out[s.id] = { lang: "es", guess: true };
      }
      return send(res, 200, out);
    }

    // Historial de reproducciones. Spotify solo devuelve las últimas 50, así que se van
    // guardando aquí para poder armar "Última semana" aunque escuches mucho.
    if (url.pathname === "/api/plays" && req.method === "POST") {
      const { plays = [], days = 7 } = await readBody(req);
      const all = readJSON(PLAYS_FILE, {});
      for (const p of plays) if (p.played_at && p.song?.id) all[p.played_at] = p.song;
      const keepFrom = Date.now() - 90 * 864e5; // se guardan 90 días
      for (const k of Object.keys(all)) if (Date.parse(k) < keepFrom) delete all[k];
      writeJSON(PLAYS_FILE, all);
      const from = Date.now() - days * 864e5;
      const recent = Object.entries(all)
        .filter(([k]) => Date.parse(k) >= from)
        .map(([played_at, song]) => ({ played_at, song }));
      return send(res, 200, recent);
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
