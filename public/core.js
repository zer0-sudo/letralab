// LetraLab — núcleo compartido.
// La misma lógica corre en dos sitios:
//  - en el servidor del PC (server.js), guardando en la carpeta data/;
//  - en el navegador de la tablet (versión sin servidor), guardando en IndexedDB.
// Solo cambia el almacenamiento, que se pasa como { get(key), set(key, value), all() }.
// Claves: "vocab", "stats", "plays", "lang" y "lyrics/<id>", "explanations/<id>", "words/<id>".

// ---------- utilidades ----------
export async function keyOf(s) {
  const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export class ProviderError extends Error {
  constructor(message, { transient = false, status = 502 } = {}) {
    super(message);
    this.transient = transient; // saturado o al límite: vale la pena otro modelo o esperar
    this.status = status;
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function parseJSON(text, who) {
  const clean = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    throw new ProviderError(`${who} devolvió un JSON inválido`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- IA: Gemini ----------
// En el plan gratuito de Gemini solo están los modelos Flash-Lite. Si el principal está
// saturado (503) o al límite (429), se prueban los de respaldo, que también son gratis.
// Comprobado el 2026-11-08: los 2.5 ya no están para cuentas nuevas.
export const DEFAULT_GEMINI_MODEL = "gemini-flash-lite-latest";
export const DEFAULT_GEMINI_FALLBACKS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

async function askGemini(key, model, system, prompt, schema) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(90000),
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
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
    if (res.status === 400 && /API_KEY_INVALID|API key not valid/i.test(body)) {
      throw new ProviderError("La clave de Gemini no es válida. Revísala en ⚙ Ajustes.");
    }
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
export function geminiProvider(key, models) {
  return async function askGeminiWithRetry(system, prompt, schema) {
    let last;
    for (let round = 0; round < 2; round++) {
      if (round) await sleep(4000);
      for (const model of models) {
        try {
          try {
            return await askGemini(key, model, system, prompt, schema);
          } catch (error) {
            if (!/JSON/.test(error.message)) throw error;
            return await askGemini(key, model, system, prompt, schema);
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
  };
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
export function parseLRC(lrc) {
  if (!lrc) return null;
  const out = [];
  for (const line of lrc.split(/\r?\n/)) {
    const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
    if (m) out.push({ time: Number(m[1]) * 60 + Number(m[2]), text: m[3].trim() });
  }
  return out.length ? out : null;
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

export function englishRatio(lines) {
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

// ---------- la "API" de LetraLab ----------
// storage: { get(key) → valor | null, set(key, valor), all() → { clave: valor } }
// providers: [[nombre, async (system, prompt, schema) => objeto]] en orden de preferencia.
// lrclibHeaders: el navegador no deja cambiar el user-agent, así que solo lo pone el servidor.
export function createApi({ storage, providers = [], lrclibHeaders = {}, noAiMessage = "No hay ninguna clave de IA configurada" }) {
  const get = async (k, fallback) => (await storage.get(k)) ?? fallback;

  // Gemini primero; si no hay clave, falla o llega al límite, el siguiente (Claude en el PC).
  async function ask(system, prompt, schema) {
    const list = typeof providers === "function" ? providers() : providers;
    if (!list.length) throw new ProviderError(noAiMessage, { status: 400 });
    const errors = [];
    for (const [name, fn] of list) {
      try {
        return { provider: name, result: await fn(system, prompt, schema) };
      } catch (error) {
        console.warn(`[IA] ${error.message}`);
        errors.push(error.message);
      }
    }
    throw new ProviderError(errors.join(" | "));
  }

  // LRCLIB a veces falla o limita si se le piden muchas letras seguidas: reintentar con pausa.
  async function lrclib(url) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { headers: lrclibHeaders, signal: AbortSignal.timeout(15000) });
        if (res.ok || res.status === 404 || attempt >= 2) return res;
      } catch (e) {
        if (attempt >= 2) throw e;
      }
      await sleep(1500 * (attempt + 1));
    }
  }

  async function getLyrics({ track, artist, album, duration }) {
    const key = "lyrics/" + await keyOf(`${artist}|${track}`.toLowerCase());
    const cached = await storage.get(key);
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
    if (found) await storage.set(key, result);
    return result;
  }

  // "en" si al menos el 60 % de las líneas son en inglés: así una canción en español con un
  // coro o unas frases en inglés cuenta como español.
  // Guardar el idioma, de a una escritura a la vez (si dos se cruzan, una borraría la otra).
  let langLock = Promise.resolve();
  const saveLang = (key, result) => (langLock = langLock.then(async () => {
    const fresh = await get("lang", {});
    fresh[key] = result;
    await storage.set("lang", fresh);
  }).catch((e) => console.warn("[idioma]", e)));

  async function songLanguage(song) {
    const key = `${song.artist}|${song.track}`.toLowerCase();
    const hit = (await get("lang", {}))[key];
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
    await saveLang(key, result);
    return result;
  }

  // Une los datos de un respaldo con los actuales sin perder nada de ninguno de los dos.
  async function importData(data) {
    if (!data || typeof data !== "object" || !data.letralab) throw new HttpError(400, "Ese archivo no es un respaldo de LetraLab");
    const counts = { vocab: 0, cache: 0 };
    const vocab = await get("vocab", []);
    const byId = new Map(vocab.map((v) => [v.id, v]));
    for (const v of data.vocab || []) {
      const mine = byId.get(v.id);
      // Si la palabra está en los dos, gana la que se repasó más recientemente.
      if (!mine) { byId.set(v.id, v); counts.vocab++; }
      else if ((v.last || "") > (mine.last || "")) byId.set(v.id, v);
    }
    await storage.set("vocab", [...byId.values()].sort((a, b) => (b.added || "").localeCompare(a.added || "")));

    const stats = await get("stats", {});
    for (const [day, d] of Object.entries(data.stats || {})) {
      stats[day] ??= {};
      for (const [t, n] of Object.entries(d)) stats[day][t] = Math.max(stats[day][t] || 0, n);
    }
    await storage.set("stats", stats);
    await storage.set("plays", { ...(data.plays || {}), ...(await get("plays", {})) });
    await storage.set("lang", { ...(data.lang || {}), ...(await get("lang", {})) });
    for (const [k, v] of Object.entries(data.cache || {})) {
      if (!/^(lyrics|explanations|words)\/[0-9a-f]{16}$/.test(k)) continue;
      if (!(await storage.get(k))) { await storage.set(k, v); counts.cache++; }
    }
    return { ok: true, ...counts };
  }

  async function exportData() {
    const all = await storage.all();
    const cache = Object.fromEntries(Object.entries(all).filter(([k]) => k.includes("/")));
    return {
      letralab: 1,
      exported: new Date().toISOString(),
      vocab: all.vocab || [],
      stats: all.stats || {},
      plays: all.plays || {},
      lang: all.lang || {},
      cache,
    };
  }

  // Atiende una petición igual que lo haría el servidor: devuelve el objeto de respuesta o
  // lanza HttpError / ProviderError (que traen .status).
  return async function handle(method, pathname, body = {}) {
    const url = new URL(pathname, "http://letralab");
    const p = url.pathname;

    if (p === "/api/lyrics") {
      const q = Object.fromEntries(url.searchParams);
      if (!q.track || !q.artist) throw new HttpError(400, "Falta track o artist");
      return getLyrics(q);
    }

    if (p === "/api/explain" && method === "POST") {
      const { track, artist, lines } = body;
      const key = "explanations/" + await keyOf(`${artist}|${track}`.toLowerCase());
      const cached = await storage.get(key);
      if (cached) return { ...cached, cached: true };
      const numbered = lines.map((t, i) => `${i}: ${t}`).join("\n");
      const { provider, result } = await ask(EXPLAIN_SYSTEM, `Canción: "${track}" de ${artist}\n\nLetra:\n${numbered}`, EXPLAIN_SCHEMA);
      const saved = { provider, summary: result.summary || "", lines: result.lines || [] };
      await storage.set(key, saved);
      return saved;
    }

    if (p === "/api/define" && method === "POST") {
      const { word, line } = body;
      const key = "words/" + await keyOf(`${word}|${line}`.toLowerCase());
      const cached = await storage.get(key);
      if (cached) return cached;
      const { provider, result } = await ask(DEFINE_SYSTEM, `Palabra o expresión: "${word}"\nLínea: "${line}"`, DEFINE_SCHEMA);
      const saved = { provider, ...result };
      await storage.set(key, saved);
      return saved;
    }

    if (p === "/api/vocab") {
      const vocab = await get("vocab", []);
      if (method === "GET") return vocab;
      if (method === "POST") {
        const entry = { id: crypto.randomUUID(), added: new Date().toISOString(), box: 0, due: new Date().toISOString(), ...body };
        vocab.unshift(entry);
        await storage.set("vocab", vocab);
        return entry;
      }
    }

    const vocabItem = p.match(/^\/api\/vocab\/([\w-]+)$/);
    if (vocabItem) {
      let vocab = await get("vocab", []);
      if (method === "DELETE") {
        vocab = vocab.filter((v) => v.id !== vocabItem[1]);
        await storage.set("vocab", vocab);
        return { ok: true };
      }
      if (method === "PATCH") {
        vocab = vocab.map((v) => (v.id === vocabItem[1] ? { ...v, ...body } : v));
        await storage.set("vocab", vocab);
        return { ok: true };
      }
    }

    // Actividad diaria para la racha: { "2026-11-07": { reviews, added, songs, cloze } }
    if (p === "/api/stats") {
      const stats = await get("stats", {});
      if (method === "GET") return stats;
      if (method === "POST") {
        const { type, day } = body;
        if (!["reviews", "added", "songs", "cloze"].includes(type) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          throw new HttpError(400, "Datos inválidos");
        }
        stats[day] ??= {};
        stats[day][type] = (stats[day][type] || 0) + 1;
        await storage.set("stats", stats);
        return stats;
      }
    }

    // Idioma de varias canciones: { songs: [{ id, track, artist, album, duration }] } → { id: { lang, en } }
    if (p === "/api/lang" && method === "POST") {
      const { songs = [] } = body;
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
      const known = Object.entries(await get("lang", {}));
      for (const s of songs) {
        if (out[s.id]?.lang !== "unknown") continue;
        const artist = s.artist.toLowerCase() + "|";
        const langs = known.filter(([k, v]) => k.startsWith(artist) && ["en", "es"].includes(v.lang)).map(([, v]) => v.lang);
        const es = langs.filter((l) => l === "es").length;
        if (langs.length && es / langs.length >= 0.7) out[s.id] = { lang: "es", guess: true };
      }
      return out;
    }

    // Historial de reproducciones. Spotify solo devuelve las últimas 50, así que se van
    // guardando aquí para poder armar "Última semana" aunque escuches mucho.
    if (p === "/api/plays" && method === "POST") {
      const { plays = [], days = 7 } = body;
      const all = await get("plays", {});
      for (const pl of plays) if (pl.played_at && pl.song?.id) all[pl.played_at] = pl.song;
      const keepFrom = Date.now() - 90 * 864e5; // se guardan 90 días
      for (const k of Object.keys(all)) if (Date.parse(k) < keepFrom) delete all[k];
      await storage.set("plays", all);
      const from = Date.now() - days * 864e5;
      return Object.entries(all)
        .filter(([k]) => Date.parse(k) >= from)
        .map(([played_at, song]) => ({ played_at, song }));
    }

    // Respaldo: todo lo guardado en un solo JSON, para pasarlo entre el PC y la tablet.
    if (p === "/api/export" && method === "GET") return exportData();
    if (p === "/api/import" && method === "POST") return importData(body);

    throw new HttpError(404, "No existe");
  };
}
