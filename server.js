// LetraLab — servidor local.
// Sirve la interfaz, trae letras de LRCLIB, pide explicaciones a la IA
// (Gemini primero, Claude Haiku si Gemini falla o llega al límite) y guarda
// el vocabulario. Todo queda en la carpeta data/.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { createApi, geminiProvider, parseJSON, ProviderError, HttpError, DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_FALLBACKS } from "./public/core.js";

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
const GEMINI_MODEL = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
// Si el modelo principal está saturado (503) o al límite (429), se prueban estos.
const GEMINI_FALLBACKS = (process.env.GEMINI_FALLBACKS || DEFAULT_GEMINI_FALLBACKS.join(","))
  .split(",").map((m) => m.trim()).filter(Boolean);
const GEMINI_MODELS = [...new Set([GEMINI_MODEL, ...GEMINI_FALLBACKS])];
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "";

const claude = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

// ---------- almacenamiento en JSON (carpeta data/) ----------
// "vocab" → data/vocab.json; "lyrics/abc" → data/lyrics/abc.json
for (const d of ["lyrics", "explanations", "words"]) {
  fs.mkdirSync(path.join(DATA, d), { recursive: true });
}
const fileOf = (key) => path.join(DATA, ...key.split("/")) + ".json";
const storage = {
  get(key) {
    try { return JSON.parse(fs.readFileSync(fileOf(key), "utf8")); } catch { return null; }
  },
  set(key, value) {
    fs.writeFileSync(fileOf(key), JSON.stringify(value, null, 2));
  },
  all() {
    const out = {};
    for (const name of ["vocab", "stats", "plays", "lang"]) out[name] = storage.get(name);
    for (const dir of ["lyrics", "explanations", "words"]) {
      for (const f of fs.readdirSync(path.join(DATA, dir))) {
        if (f.endsWith(".json")) out[`${dir}/${f.slice(0, -5)}`] = storage.get(`${dir}/${f.slice(0, -5)}`);
      }
    }
    return out;
  },
};

// ---------- IA ----------
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

// Gemini primero; si no hay clave, falla o llega al límite, Claude.
const providers = [];
if (GEMINI_KEY) providers.push(["gemini", geminiProvider(GEMINI_KEY, GEMINI_MODELS)]);
if (claude) providers.push(["claude", askClaude]);

const api = createApi({
  storage,
  providers,
  lrclibHeaders: { "user-agent": "LetraLab/0.1 (app personal)" },
  noAiMessage: "No hay ninguna clave de IA en el archivo .env",
});

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
    if (url.pathname.startsWith("/api/")) {
      const body = req.method === "POST" || req.method === "PATCH" ? await readBody(req) : undefined;
      return send(res, 200, await api(req.method, url.pathname + url.search, body));
    }

    // Archivos estáticos (y /callback, a donde vuelve Spotify tras iniciar sesión).
    let file = url.pathname === "/" || url.pathname === "/callback" ? "/index.html" : url.pathname;
    file = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end("No encontrado");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    if (!(error instanceof HttpError)) console.error(error);
    send(res, error.status || 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`LetraLab en http://127.0.0.1:${PORT}`);
  console.log(`IA: Gemini ${GEMINI_KEY ? "✔" : "✘"} · Claude ${claude ? "✔" : "✘"} · Spotify ${SPOTIFY_CLIENT_ID ? "✔" : "✘"}`);
});
