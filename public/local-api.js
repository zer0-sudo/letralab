// LetraLab sin servidor (tablet o celular): la misma API que el servidor del PC, pero
// corriendo en el navegador. Los datos se guardan en IndexedDB de este dispositivo y la
// clave de Gemini, en localStorage (solo en este navegador; nunca se sube a ningún lado).
import { createApi, geminiProvider, HttpError, DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_FALLBACKS } from "./core.js";

// El Client ID de Spotify no es secreto: con PKCE va a la vista en la URL de inicio de sesión.
export const SPOTIFY_CLIENT_ID = "6af17de494154087bfc68337abf42036";
const GEMINI_KEY_STORAGE = "gemini_key";

export function getGeminiKey() {
  try { return localStorage.getItem(GEMINI_KEY_STORAGE) || ""; } catch { return ""; }
}
export function setGeminiKey(key) {
  try {
    if (key) localStorage.setItem(GEMINI_KEY_STORAGE, key.trim());
    else localStorage.removeItem(GEMINI_KEY_STORAGE);
  } catch {}
}

// ---------- IndexedDB: un almacén clave → valor ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("letralab", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
let dbPromise;
function tx(mode, fn) {
  dbPromise ??= openDb();
  return dbPromise.then((db) => new Promise((resolve, reject) => {
    const t = db.transaction("kv", mode);
    const result = fn(t.objectStore("kv"));
    t.oncomplete = () => resolve(result.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("IndexedDB: transacción cancelada"));
  }));
}

const storage = {
  async get(key) { return (await tx("readonly", (s) => s.get(key))) ?? null; },
  async set(key, value) { await tx("readwrite", (s) => s.put(value, key)); },
  async all() {
    dbPromise ??= openDb();
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const out = {};
      const req = db.transaction("kv").objectStore("kv").openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        out[c.key] = c.value;
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  },
};

// Pide al navegador que no borre estos datos si el dispositivo se queda sin espacio.
navigator.storage?.persist?.().catch(() => {});

const handle = createApi({
  storage,
  // Se lee la clave en cada pregunta, por si se cambia en Ajustes.
  providers: () => {
    const key = getGeminiKey();
    return key ? [["gemini", geminiProvider(key, [DEFAULT_GEMINI_MODEL, ...DEFAULT_GEMINI_FALLBACKS])]] : [];
  },
  noAiMessage: "Falta tu clave de Gemini: ponla en ⚙ Ajustes.",
});

export function localConfig() {
  const gemini = !!getGeminiKey();
  return { standalone: true, spotifyClientId: SPOTIFY_CLIENT_ID, ai: { gemini, claude: false, geminiModel: DEFAULT_GEMINI_MODEL } };
}

export async function localApi(method, pathname, body) {
  if (pathname === "/api/config") return localConfig();
  try {
    return await handle(method, pathname, body);
  } catch (error) {
    if (error instanceof HttpError) throw new Error(error.message);
    throw error;
  }
}
