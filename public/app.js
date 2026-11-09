// LetraLab — interfaz.
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOUCH = matchMedia("(pointer: coarse)").matches; // tablet o celular
// Carpeta donde vive la app: "/" en el PC, "/letralab/" en GitHub Pages.
const BASE_PATH = location.pathname === "/callback" ? "/" : new URL(".", location.href).pathname;
// En el PC Spotify vuelve a /callback; la versión sin servidor vuelve a la propia página
// (GitHub Pages no tiene la ruta /callback). Se fija al cargar la configuración.
let REDIRECT_URI = `${location.origin}/callback`;
// Versión sin servidor: módulo que atiende la API dentro del navegador.
let local = null;
const SCOPES = [
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-top-read",
  "user-read-recently-played",
].join(" ");

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const state = {
  config: null,
  playing: null,      // canción que suena en Spotify
  isPlaying: false,
  progressMs: 0,
  progressAt: 0,      // performance.now() cuando se midió progressMs
  lastPlayingId: null,
  song: null,         // canción cuya letra se muestra
  lines: [],          // [{ time, text, translation, note, key }]
  activeIndex: -1,
  mode: store.get("mode") || "understand",
  revealed: new Set(),// líneas destapadas en modo practicar / oído
  cloze: {},          // { índice: "ok" | "shown" }
  loop: null,         // índice de la línea que se repite
  seekingUntil: 0,
  vocab: [],
  stats: {},
  countedSongs: new Set(),
};

// ---------------- Spotify: inicio de sesión (PKCE) ----------------
function randomString(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");
}
async function sha256base64url(text) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function login() {
  const verifier = randomString(64);
  store.set("pkce_verifier", verifier);
  const params = new URLSearchParams({
    client_id: state.config.spotifyClientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: await sha256base64url(verifier),
  });
  location.href = `https://accounts.spotify.com/authorize?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: state.config.spotifyClientId, ...body }),
  });
  if (!res.ok) throw new Error(`Spotify token ${res.status}: ${await res.text()}`);
  const t = await res.json();
  const prev = store.get("spotify_token") || {};
  const token = {
    access: t.access_token,
    refresh: t.refresh_token || prev.refresh,
    expires: Date.now() + (t.expires_in - 60) * 1000,
  };
  store.set("spotify_token", token);
  return token;
}

async function handleCallback() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  history.replaceState(null, "", BASE_PATH);
  if (params.get("error")) throw new Error(`Spotify: ${params.get("error")}`);
  if (!code) return;
  await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: store.get("pkce_verifier"),
  });
  store.del("pkce_verifier");
}

async function accessToken() {
  let token = store.get("spotify_token");
  if (!token) return null;
  if (Date.now() > token.expires) {
    try {
      token = await tokenRequest({ grant_type: "refresh_token", refresh_token: token.refresh });
    } catch {
      store.del("spotify_token");
      return null;
    }
  }
  return token.access;
}

async function spotify(pathname, options = {}) {
  const token = await accessToken();
  if (!token) { showSetup(); throw new Error("Sesión de Spotify vencida"); }
  const res = await fetch(`https://api.spotify.com/v1${pathname}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers || {}) },
  });
  if (res.status === 204 || res.status === 202) return null;
  if (res.status === 401) { store.del("spotify_token"); showSetup(); throw new Error("Sesión de Spotify vencida"); }
  if (!res.ok) {
    const err = new Error(`Spotify ${res.status}`);
    err.status = res.status;
    throw err;
  }
  // Algunas acciones (play, pausa, seek, transferir) a veces responden 200 con un id en
  // texto plano en vez de JSON: eso es éxito, no un error.
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

const toSong = (t) => ({
  id: t.id,
  name: t.name,
  artist: t.artists.map((a) => a.name).join(", "),
  mainArtist: t.artists[0]?.name || "",
  album: t.album?.name || "",
  duration: t.duration_ms / 1000,
  cover: t.album?.images?.at(-2)?.url || t.album?.images?.[0]?.url || "",
  uri: t.uri,
});

// Spotify solo acepta "play" en un dispositivo activo. Si la app está abierta pero
// en pausa no cuenta como activa: primero le pasamos la reproducción y luego
// mandamos las canciones. Si no arranca, se reintenta una vez.
async function playOnSpotify(body) {
  const { devices = [] } = (await spotify("/me/player/devices")) || {};
  const usable = devices.filter((d) => !d.is_restricted);
  // En la tablet o el celular, preferir el Spotify de ese mismo aparato; en el PC, el del PC.
  const preferred = TOUCH ? ["Tablet", "Smartphone"] : ["Computer"];
  const device = usable.find((d) => d.is_active) || usable.find((d) => preferred.includes(d.type)) || usable[0];
  if (!device) {
    throw new Error(TOUCH
      ? "No encontré ningún Spotify abierto. Abre la app de Spotify en esta tablet (pon cualquier canción un segundo) y vuelve a intentarlo."
      : "No encontré ningún Spotify abierto. Abre la app de Spotify en tu PC o celular y vuelve a intentarlo.");
  }

  if (!device.is_active) {
    await spotify("/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [device.id], play: false }) });
    await sleep(900);
  }
  const play = () => spotify(`/me/player/play?device_id=${encodeURIComponent(device.id)}`, {
    method: "PUT", ...(body ? { body: JSON.stringify(body) } : {}),
  });
  await play();
  for (let attempt = 0; attempt < 2; attempt++) {
    await sleep(1500);
    const now = await spotify("/me/player");
    if (now?.is_playing && now.item) return true;
    if (attempt === 0) await play();
  }
  // Plan B: a veces la app de escritorio acepta la orden pero no la ejecuta.
  // Abrimos la canción directamente en la app de Spotify.
  const uri = body?.uris?.[body.offset?.position || 0];
  if (uri) location.href = uri;
  return false;
}

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 9000);
}

// ---------------- API local ----------------
async function api(pathname, body, method) {
  if (local) return local.localApi(method || (body ? "POST" : "GET"), pathname, body);
  const res = await fetch(pathname, body
    ? { method: method || "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : { method: method || "GET" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// ---------------- Voz (pronunciación) ----------------
function say(text, rate = 0.9) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  u.voice = voices.find((v) => v.lang === "en-US" && /natural|online|google/i.test(v.name))
    || voices.find((v) => v.lang === "en-US") || voices.find((v) => v.lang.startsWith("en")) || null;
  u.lang = "en-US";
  u.rate = rate;
  speechSynthesis.speak(u);
}

// ---------------- Racha y actividad ----------------
const today = () => new Date().toLocaleDateString("en-CA");

async function stat(type) {
  try { state.stats = await api("/api/stats", { type, day: today() }); renderStreak(); } catch (e) { console.warn(e); }
}

function streakDays() {
  const active = (d) => Object.values(state.stats[d] || {}).some((n) => n > 0);
  const day = new Date();
  if (!active(day.toLocaleDateString("en-CA"))) day.setDate(day.getDate() - 1);
  let n = 0;
  while (active(day.toLocaleDateString("en-CA"))) { n++; day.setDate(day.getDate() - 1); }
  return n;
}

function renderStreak() {
  const t = state.stats[today()] || {};
  const done = (t.reviews || 0) + (t.cloze || 0) + (t.added || 0);
  const n = streakDays();
  $("#streak").hidden = false;
  $("#streak").textContent = `🔥 ${n} ${n === 1 ? "día" : "días"} · hoy ${done}/${DAILY_GOAL}`;
  $("#streak").title = `Meta diaria: ${DAILY_GOAL} acciones (repasos, huecos y palabras nuevas)`;
}
const DAILY_GOAL = 30;

// ---------------- Vistas ----------------
function showView(name) {
  $("#word-pop").hidden = true;
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `view-${name}`;
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("active", b.dataset.view === name);
  if (name === "top") loadTop();
  if (name === "vocab") renderVocab();
  if (name === "review") renderReview();
}

function showSetup() {
  $("#tabs").hidden = true;
  showView("setup");
  if (state.config.standalone) {
    // Sin servidor no hay .env: la clave de Gemini se escribe en Ajustes.
    $("#setup-missing").hidden = state.config.ai.gemini;
    $("#setup-missing").innerHTML = state.config.ai.gemini ? "" :
      `Para traducir y explicar las letras falta tu clave gratis de Gemini. <button class="link" data-open-settings>Ponerla en ⚙ Ajustes</button>`;
  } else {
    const missing = [];
    if (!state.config.spotifyClientId) missing.push("<code>SPOTIFY_CLIENT_ID</code>");
    if (!state.config.ai.gemini && !state.config.ai.claude) missing.push("<code>GEMINI_API_KEY</code> (o <code>ANTHROPIC_API_KEY</code>)");
    $("#setup-missing").hidden = !missing.length;
    $("#setup-missing").innerHTML = missing.length
      ? `Falta configurar en el archivo <code>.env</code>: ${missing.join(", ")}. Luego reinicia el servidor.`
      : "";
  }
  $("#login").disabled = !state.config.spotifyClientId;
}

function setScale(delta) {
  const scale = Math.min(1.6, Math.max(0.8, (store.get("scale") || 1) + delta));
  store.set("scale", scale);
  document.documentElement.style.setProperty("--scale", scale);
}

// ---------------- Modos de estudio ----------------
const MODE_HELP = {
  understand: "Escucha y lee. Toca cualquier palabra para ver qué significa y guardarla. 🔁 repite una línea; 🔊 la pronuncia.",
  practice: "Intenta entender cada línea sin ayuda y luego toca la traducción borrosa para comprobar.",
  cloze: "Escribe la palabra que falta y pulsa Enter. Si no la sabes, toca ? para verla. Usa 🔁 para oír la línea otra vez.",
  ear: "No mires: escucha. Cada línea aparece cuando termina de cantarse. Si no la entendiste, tócala para verla antes.",
};

function setMode(mode) {
  state.mode = mode;
  store.set("mode", mode);
  for (const b of document.querySelectorAll("#modes button")) b.classList.toggle("active", b.dataset.mode === mode);
  const ol = $("#lyrics");
  ol.classList.remove("mode-understand", "mode-practice", "mode-cloze", "mode-ear");
  ol.classList.add(`mode-${mode}`);
  $("#mode-help").textContent = MODE_HELP[mode];
  renderClozeScore();
}

// ---------------- Sonando ahora ----------------
async function poll() {
  try {
    const data = await spotify("/me/player/currently-playing");
    if (!data || !data.item || data.currently_playing_type !== "track") {
      state.isPlaying = false;
      renderPlayer();
      return;
    }
    state.playing = toSong(data.item);
    // Justo después de pausar o reanudar desde aquí, Spotify puede tardar en enterarse:
    // se respeta lo que pidió el usuario en vez de lo que diga la consulta.
    if (performance.now() > (state.toggledUntil || 0)) state.isPlaying = data.is_playing;
    if (performance.now() > state.seekingUntil) {
      state.progressMs = data.progress_ms;
      state.progressAt = performance.now();
    }
    renderPlayer();
    if (state.playing.id !== state.lastPlayingId) {
      state.lastPlayingId = state.playing.id;
      loadSong(state.playing);
    }
  } catch (e) {
    console.warn(e);
  }
}

function renderPlayer() {
  const s = state.playing;
  const viewing = state.song && state.song.id !== s?.id ? state.song : null;
  if (viewing) {
    $("#track-name").textContent = viewing.name;
    $("#track-artist").textContent = `${viewing.artist} · no está sonando`;
  } else {
    $("#track-name").textContent = s ? s.name : "Nada sonando";
    $("#track-artist").textContent = s ? s.artist : "Pon una canción en Spotify";
  }
  const cover = (viewing || s)?.cover || "";
  $("#cover").src = cover;
  $("#cover").style.visibility = cover ? "visible" : "hidden";
}

function currentSeconds() {
  if (!state.playing) return 0;
  const ms = state.progressMs + (state.isPlaying ? performance.now() - state.progressAt : 0);
  return ms / 1000;
}

const isSyncedPlaying = () =>
  state.song && state.playing && state.song.id === state.playing.id && state.lines.length && state.lines[0].time != null;

function lineEnd(i) {
  for (let j = i + 1; j < state.lines.length; j++) if (state.lines[j].time > state.lines[i].time) return state.lines[j].time;
  return state.lines[i].time + 6;
}

async function seekTo(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  state.progressMs = ms;
  state.progressAt = performance.now();
  state.seekingUntil = performance.now() + 1500;
  try { await spotify(`/me/player/seek?position_ms=${ms}`, { method: "PUT" }); } catch (e) { console.warn(e); }
}

function tick() {
  if (state.playing) {
    const t = currentSeconds();
    $("#progress-bar").style.width = `${Math.min(100, (t / state.playing.duration) * 100)}%`;
    $("#lyrics").classList.toggle("live", !!isSyncedPlaying());
    renderPauseState();
    if (isSyncedPlaying()) {
      // Repetir línea: al terminar, vuelve a su inicio.
      if (state.loop != null && state.isPlaying && performance.now() > state.seekingUntil) {
        const start = state.lines[state.loop].time;
        if (t >= lineEnd(state.loop) - 0.1 || t < start - 1) seekTo(start - 0.25);
      }
      let idx = -1;
      for (let i = 0; i < state.lines.length; i++) if (state.lines[i].time <= t + 0.3) idx = i;
      if (idx !== state.activeIndex) setActive(idx);
    }
  }
  requestAnimationFrame(tick);
}

function setActive(idx) {
  const items = $("#lyrics").children;
  items[state.activeIndex]?.classList.remove("active");
  state.activeIndex = idx;
  for (let i = 0; i < items.length; i++) items[i].classList.toggle("sung", i < idx);
  const el = items[idx];
  if (el) {
    el.classList.add("active");
    if (!document.hidden && !$("#view-now").hidden && document.activeElement?.tagName !== "INPUT") {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
}

async function loadSong(song) {
  state.song = song;
  state.lines = [];
  state.activeIndex = -1;
  state.revealed = new Set();
  state.cloze = {};
  state.loop = null;
  $("#lyrics").innerHTML = "";
  $("#summary").hidden = true;
  $("#lyrics-status").textContent = "Buscando la letra…";
  renderPlayer();
  renderClozeScore();

  let lyr;
  try {
    lyr = await api(`/api/lyrics?${new URLSearchParams({ track: song.name, artist: song.mainArtist, album: song.album, duration: song.duration })}`);
  } catch (e) {
    $("#lyrics-status").innerHTML = `<span class="error">No se pudo buscar la letra: ${escapeHtml(e.message)}</span>`;
    return;
  }
  if (state.song !== song) return;
  if (!lyr.found) { $("#lyrics-status").textContent = "No encontré la letra de esta canción en LRCLIB."; return; }
  if (lyr.instrumental) { $("#lyrics-status").textContent = "Esta canción es instrumental 🎵"; return; }

  state.lines = lyr.synced
    ? lyr.synced.map((l) => ({ time: l.time, text: l.text }))
    : lyr.plain.split(/\r?\n/).map((text) => ({ time: null, text: text.trim() }));
  for (const l of state.lines) l.key = guessKey(l.text);
  renderLyrics();
  $("#lyrics-status").textContent = lyr.synced ? "Explicando la letra…" : "Letra sin tiempos (no se sincroniza). Explicando…";

  try {
    const exp = await api("/api/explain", { track: song.name, artist: song.mainArtist, lines: state.lines.map((l) => l.text) });
    if (state.song !== song) return;
    for (const item of exp.lines) {
      const line = state.lines[item.i];
      if (!line) continue;
      line.translation = item.translation;
      line.note = item.note;
      if (item.key && findWord(line.text, item.key) >= 0) line.key = item.key;
    }
    renderLyrics();
    if (exp.summary) { $("#summary").hidden = false; $("#summary").textContent = exp.summary; }
    $("#lyrics-status").textContent = `Explicado por ${exp.provider === "gemini" ? "Gemini" : "Claude"}${exp.cached ? " (guardado)" : ""}`;
    if (!state.countedSongs.has(song.id)) { state.countedSongs.add(song.id); stat("songs"); }
  } catch (e) {
    if (state.song !== song) return;
    // La letra ya se ve (sin traducción); el botón vuelve a pedir la explicación.
    // Sin clave (o con una mala) en la versión sin servidor: botón directo para ponerla.
    const needsKey = state.config.standalone && /clave de Gemini/i.test(e.message);
    $("#lyrics-status").innerHTML = needsKey
      ? `<span class="error">Para traducir y explicar la letra falta tu clave de Gemini (gratis).</span>
      <button class="retry" data-open-settings>🔑 Poner mi clave</button>`
      : `<span class="error">No se pudo explicar la letra: ${escapeHtml(e.message)}</span>
      <button class="retry" id="retry-explain">Reintentar</button>`;
    if (!needsKey) $("#retry-explain").onclick = () => loadSong(song);
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => s.toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9']/g, "");

const STOP = new Set("the a an and or but so to of in on at for with from by is are was were be been am i you he she it we they me my your his her our their this that these those there here what when where who why how not no yes oh ooh yeah uh hey la na da just like all its it's i'm you're don't can't won't im dont cant".split(" "));

// Palabra para el hueco si la IA todavía no la eligió: la más larga que no sea de relleno.
function guessKey(text) {
  const words = text.split(/\s+/).map(norm).filter((w) => w.length >= 4 && !STOP.has(w));
  return words.sort((a, b) => b.length - a.length)[0] || "";
}
function findWord(text, key) {
  const k = norm(key);
  return text.split(/\s+/).findIndex((w) => norm(w) === k);
}

function renderLyrics() {
  const ol = $("#lyrics");
  ol.classList.toggle("unsynced", !state.lines.length || state.lines[0].time == null);
  const known = new Set(state.vocab.map((v) => norm(v.word || v.term)));
  const synced = state.lines.length && state.lines[0].time != null;
  ol.innerHTML = state.lines.map((l, i) => {
    if (!l.text) return `<li class="gap"></li>`;
    const keyIdx = l.key ? findWord(l.text, l.key) : -1;
    let wi = -1;
    const words = l.text.split(/(\s+)/).map((part) => {
      if (!/\S/.test(part)) return part;
      wi++;
      const cls = ["w"];
      if (known.has(norm(part))) cls.push("known");
      let html = `<span class="${cls.join(" ")}${wi === keyIdx ? " key" : ""}" data-line="${i}">${escapeHtml(part)}</span>`;
      if (wi === keyIdx) {
        const st = state.cloze[i];
        const answer = norm(part);
        html += `<span class="cloze${st ? " ok" : ""}" data-line="${i}">` +
          `<input data-line="${i}" data-answer="${escapeHtml(answer)}" style="--len:${answer.length}" ` +
          `${st ? `value="${escapeHtml(part)}" readonly` : ""} autocomplete="off" spellcheck="false" aria-label="Palabra que falta">` +
          `${st ? "" : `<button class="hint-btn" data-line="${i}" title="Ver la palabra">?</button>`}</span>`;
      }
      return html;
    }).join("");
    const cls = [l.note ? "has-note" : "", state.revealed.has(i) ? "revealed" : "", state.loop === i ? "looping" : "", i < state.activeIndex ? "sung" : ""].join(" ");
    return `<li data-i="${i}" class="${cls}">
      <div class="en">${words}</div>
      ${l.translation ? `<div class="es">${escapeHtml(l.translation)}</div>` : ""}
      ${l.note ? `<div class="note">${escapeHtml(l.note)}</div>` : ""}
      <div class="line-tools">
        <button data-act="say" data-i="${i}" title="Pronunciar la línea">🔊</button>
        ${synced ? `<button data-act="loop" class="loop-btn" data-i="${i}" title="Repetir esta línea en Spotify">🔁</button>
        <button data-act="seek" data-i="${i}" title="Ir a esta línea en Spotify">▶</button>` : ""}
      </div>
    </li>`;
  }).join("");
  if (state.activeIndex >= 0) ol.children[state.activeIndex]?.classList.add("active");
  setMode(state.mode);
}

function renderClozeScore() {
  const total = state.lines.filter((l) => l.text && l.key).length;
  const ok = Object.values(state.cloze).filter((v) => v === "ok").length;
  const el = $("#cloze-score");
  el.hidden = state.mode !== "cloze" || !total;
  el.textContent = `Huecos acertados: ${ok} de ${total}`;
}

function checkCloze(input) {
  const i = Number(input.dataset.line);
  if (input.readOnly || !input.value.trim()) return;
  const wrap = input.parentElement;
  if (norm(input.value) === input.dataset.answer) {
    state.cloze[i] = "ok";
    input.readOnly = true;
    wrap.classList.add("ok");
    wrap.querySelector(".hint-btn")?.remove();
    stat("cloze");
    renderClozeScore();
    const inputs = [...document.querySelectorAll(".cloze input:not([readonly])")];
    inputs.find((x) => Number(x.dataset.line) > i)?.focus({ preventScroll: true });
  } else {
    wrap.classList.remove("bad");
    void wrap.offsetWidth;
    wrap.classList.add("bad");
  }
}

function showClozeAnswer(i) {
  const input = document.querySelector(`.cloze input[data-line="${i}"]`);
  if (!input) return;
  state.cloze[i] = "shown";
  input.value = state.lines[i].text.split(/\s+/)[findWord(state.lines[i].text, state.lines[i].key)];
  input.readOnly = true;
  input.parentElement.querySelector(".hint-btn")?.remove();
  say(state.lines[i].key, 0.8);
}

function onLyricsClick(ev) {
  const tool = ev.target.closest(".line-tools button");
  if (tool) {
    const i = Number(tool.dataset.i);
    if (tool.dataset.act === "say") say(state.lines[i].text, 0.85);
    if (tool.dataset.act === "seek") onSeekLine(i);
    if (tool.dataset.act === "loop") onLoopLine(i);
    return;
  }
  const hint = ev.target.closest(".hint-btn");
  if (hint) return showClozeAnswer(Number(hint.dataset.line));
  if (ev.target.closest(".cloze")) return;

  const li = ev.target.closest("li[data-i]");
  if (!li) return;
  const i = Number(li.dataset.i);
  // En practicar se destapa la traducción; en oído, la línea.
  if (state.mode === "practice" && ev.target.closest(".es, .note")) { state.revealed.add(i); li.classList.add("revealed"); return; }
  if (state.mode === "ear" && !li.classList.contains("sung") && !li.classList.contains("revealed")) {
    state.revealed.add(i); li.classList.add("revealed"); return;
  }
  const w = ev.target.closest(".w");
  if (w) openWord(w.textContent, Number(w.dataset.line));
}

function notPlayingAlert() {
  alert("Esta canción no está sonando. Dale ▶ en Más escuchadas o ponla en Spotify para usar esta función.");
}
function onSeekLine(i) {
  if (!isSyncedPlaying()) return notPlayingAlert();
  seekTo(state.lines[i].time - 0.25);
}
function onLoopLine(i) {
  if (!isSyncedPlaying()) return notPlayingAlert();
  state.loop = state.loop === i ? null : i;
  for (const li of $("#lyrics").children) li.classList.toggle("looping", Number(li.dataset.i) === state.loop);
  if (state.loop != null) seekTo(state.lines[i].time - 0.25);
}

// ---------------- Reproducción y atajos de teclado ----------------
// Pausar congela la letra al instante (no espera a Spotify), para alcanzar a leer.
async function togglePlay() {
  const now = performance.now();
  state.toggledUntil = now + 2500;
  if (state.isPlaying) {
    state.progressMs = currentSeconds() * 1000;
    state.progressAt = now;
    state.isPlaying = false;
    renderPauseState();
    try { await spotify("/me/player/pause", { method: "PUT" }); } catch (e) { console.warn(e); }
    return;
  }
  state.progressAt = now;
  state.isPlaying = true;
  renderPauseState();
  try {
    await spotify("/me/player/play", { method: "PUT" });
  } catch {
    // Sin dispositivo activo: el camino largo (transferir y reintentar).
    try { await playOnSpotify(); } catch (e) { state.isPlaying = false; renderPauseState(); toast(e.message); }
  }
  setTimeout(poll, 600);
}

function renderPauseState() {
  const paused = !!isSyncedPlaying() && !state.isPlaying;
  $("#lyrics").classList.toggle("paused", paused);
  $("#paused-badge").hidden = !paused;
}

// Índices de las líneas con texto (las vacías no cuentan al navegar).
const textLines = () => state.lines.map((l, i) => (l.text ? i : -1)).filter((i) => i >= 0);

function goLine(delta) {
  if (!isSyncedPlaying()) return toast("Esta canción no está sonando en Spotify.");
  const list = textLines();
  const cur = list.indexOf(state.activeIndex);
  let target;
  if (cur === -1) target = delta > 0 ? list.find((i) => i > state.activeIndex) ?? list[0] : list.findLast((i) => i < state.activeIndex) ?? list[0];
  else target = list[Math.min(list.length - 1, Math.max(0, cur + delta))];
  if (target == null) return;
  if (state.loop != null) onLoopLine(state.loop); // navegar quita el "repetir línea"
  seekTo(state.lines[target].time - 0.15);
  setActive(target);
}

function restartLine() {
  if (!isSyncedPlaying() || state.activeIndex < 0) return;
  seekTo(state.lines[state.activeIndex].time - 0.25);
}

function jump(seconds) {
  if (!state.playing) return;
  seekTo(Math.min(state.playing.duration - 1, Math.max(0, currentSeconds() + seconds)));
}

function revealActive() {
  const i = state.activeIndex;
  const li = $("#lyrics").children[i];
  if (!li) return;
  state.revealed.add(i);
  li.classList.add("revealed");
}

const SHORTCUTS = [
  ["Espacio", "Pausar / seguir (la letra se congela para que alcances a leer)"],
  ["← / →", "Línea anterior / siguiente"],
  ["↑", "Volver al inicio de la línea actual"],
  ["Shift + ← / →", "Retroceder / adelantar 5 segundos"],
  ["R", "Repetir la línea actual en bucle (otra vez R para quitarlo)"],
  ["T", "Destapar la línea actual (en Practicar y Oído)"],
  ["P", "Pronunciar la línea actual"],
  ["1 · 2 · 3 · 4", "Cambiar de modo"],
  ["N / B", "Canción siguiente / anterior"],
  ["?", "Ver u ocultar esta ayuda"],
  ["Esc", "Cerrar ventanas o salir de un hueco"],
];

function toggleShortcuts(force) {
  const el = $("#shortcuts");
  el.hidden = force != null ? !force : !el.hidden;
}

function onKey(ev) {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const typing = ev.target.closest?.("input, textarea, select, [contenteditable]");
  if (ev.key === "Escape") {
    if (typing) ev.target.blur();
    $("#word-pop").hidden = true;
    toggleShortcuts(false);
    return;
  }
  if (typing) return;
  if (ev.key === "?") { ev.preventDefault(); return toggleShortcuts(); }
  // El resto solo en "Sonando".
  if ($("#view-now").hidden) return;
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  const actions = {
    " ": togglePlay,
    k: togglePlay,
    ArrowLeft: () => (ev.shiftKey ? jump(-5) : goLine(-1)),
    ArrowRight: () => (ev.shiftKey ? jump(5) : goLine(1)),
    ArrowUp: restartLine,
    r: () => state.activeIndex >= 0 && onLoopLine(state.activeIndex),
    t: revealActive,
    p: () => state.lines[state.activeIndex]?.text && say(state.lines[state.activeIndex].text, 0.85),
    1: () => setMode("understand"),
    2: () => setMode("practice"),
    3: () => setMode("cloze"),
    4: () => setMode("ear"),
    n: () => $("#btn-next").click(),
    b: () => $("#btn-prev").click(),
  };
  const fn = actions[k];
  if (!fn) return;
  ev.preventDefault(); // que el espacio no haga scroll ni pulse botones
  fn();
}

// ---------------- Palabras ----------------
async function openWord(word, lineIndex) {
  const line = state.lines[lineIndex];
  const clean = word.replace(/^[^\w']+|[^\w']+$/g, "");
  if (!clean) return;
  $("#word-pop").hidden = false;
  $("#word-body").innerHTML = `<div class="term">${escapeHtml(clean)}</div><div class="status">Buscando significado…</div>`;
  say(clean);
  try {
    const d = await api("/api/define", { word: clean, line: line.text });
    const term = d.term || clean;
    const already = state.vocab.some((v) => v.term?.toLowerCase() === term.toLowerCase());
    $("#word-body").innerHTML = `
      <div class="term">${escapeHtml(term)} <button class="say" id="say-word" title="Escuchar">🔊</button></div>
      ${d.pronunciation ? `<div class="pron">Se pronuncia: ${escapeHtml(d.pronunciation)}</div>` : ""}
      <div class="meaning">${escapeHtml(d.meaning || "")}</div>
      <div class="expl">${escapeHtml(d.explanation || "")}</div>
      <button class="primary" id="save-word" ${already ? "disabled" : ""}>${already ? "Ya está en tu vocabulario" : "Guardar para repasar"}</button>`;
    $("#say-word").onclick = () => say(term, 0.8);
    $("#save-word").onclick = async () => {
      const entry = await api("/api/vocab", {
        term, meaning: d.meaning, explanation: d.explanation, pronunciation: d.pronunciation,
        line: line.text, lineTranslation: line.translation || "", word: clean,
        track: state.song.name, artist: state.song.artist,
        ease: 2.5, interval: 0, reps: 0,
      });
      state.vocab.unshift(entry);
      updateCounts();
      stat("added");
      $("#save-word").disabled = true;
      $("#save-word").textContent = "Guardada ✔ — la repasarás en Repasar";
      for (const w of document.querySelectorAll(".en .w")) if (norm(w.textContent) === norm(clean)) w.classList.add("known");
    };
  } catch (e) {
    $("#word-body").innerHTML = `<div class="term">${escapeHtml(clean)}</div><div class="error">${escapeHtml(e.message)}</div>`;
  }
}

// ---------------- Más escuchadas ----------------
// Guarda en el PC las últimas reproducciones de Spotify (la API solo da 50) y devuelve las
// de los últimos `days` días.
async function syncPlays(days = 7) {
  const data = await spotify("/me/player/recently-played?limit=50");
  const plays = (data?.items || []).filter((p) => p.track?.id).map((p) => ({ played_at: p.played_at, song: toSong(p.track) }));
  return api("/api/plays", { plays, days });
}

async function weekTop() {
  const plays = await syncPlays(7);
  const byId = new Map();
  for (const { played_at, song } of plays) {
    const e = byId.get(song.id) || { song, count: 0, last: "" };
    e.count++;
    if (played_at > e.last) e.last = played_at;
    byId.set(song.id, e);
  }
  return [...byId.values()]
    .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last))
    .map((e) => ({ ...e.song, plays: e.count }));
}

const top = { songs: [], lang: {}, checking: false };

async function loadTop() {
  const range = $("#top-range").value;
  store.set("top_range", range);
  $("#top-list").innerHTML = `<li class="status">Cargando…</li>`;
  try {
    top.songs = range === "week"
      ? await weekTop()
      : (await spotify(`/me/top/tracks?limit=50&time_range=${range}`)).items.map(toSong);
    renderTop();
    // Idioma: de a 10 canciones, para que la lista se vaya filtrando mientras revisa.
    const pending = top.songs.filter((s) => !top.lang[s.id]);
    top.checking = pending.length > 0;
    renderTop();
    for (let i = 0; i < pending.length; i += 10) {
      const chunk = pending.slice(i, i + 10);
      const res = await api("/api/lang", {
        songs: chunk.map((s) => ({ id: s.id, track: s.name, artist: s.mainArtist, album: s.album, duration: s.duration })),
      });
      Object.assign(top.lang, res);
      if ($("#top-range").value !== range) return; // cambió de rango mientras tanto
      renderTop();
    }
    // Las que quedaron sin letra se preguntan otra vez al final: ahora el servidor ya conoce
    // las demás canciones de esos artistas y puede deducir el idioma.
    const unknown = top.songs.filter((s) => top.lang[s.id]?.lang === "unknown");
    if (unknown.length) {
      Object.assign(top.lang, await api("/api/lang", {
        songs: unknown.map((s) => ({ id: s.id, track: s.name, artist: s.mainArtist, album: s.album, duration: s.duration })),
      }));
    }
    top.checking = false;
    renderTop();
  } catch (e) {
    $("#top-list").innerHTML = `<li class="error">${escapeHtml(e.message)}</li>`;
  }
}

const LANG_TAG = { es: "Español", instrumental: "Instrumental", unknown: "Sin letra" };

function renderTop() {
  const onlyEn = $("#only-en").checked;
  // Con el filtro se quitan las que están en español (o casi todo en español) y las instrumentales.
  const hide = (s) => onlyEn && ["es", "instrumental"].includes(top.lang[s.id]?.lang);
  const songs = top.songs.filter((s) => !hide(s));
  const hidden = top.songs.length - songs.length;
  const week = $("#top-range").value === "week";
  $("#top-filter-info").textContent = [
    top.checking ? "Revisando el idioma de las letras…" : "",
    hidden ? `${hidden} ocultas por estar en español o sin voz.` : "",
  ].filter(Boolean).join(" ");

  if (!songs.length) {
    $("#top-list").innerHTML = `<li class="status">${week
      ? "Aún no hay reproducciones de esta semana. Escucha algo en Spotify y vuelve."
      : "No hay canciones para mostrar."}</li>`;
    return;
  }
  $("#top-list").innerHTML = songs.map((s, i) => {
    const l = top.lang[s.id]?.lang;
    const tag = LANG_TAG[l] ? `<span class="lang-tag lang-${l}">${LANG_TAG[l]}</span>` : "";
    const plays = s.plays ? ` · ${s.plays} ${s.plays === 1 ? "vez" : "veces"}` : "";
    return `
      <li>
        <span class="n">${i + 1}</span>
        <img src="${s.cover}" alt="">
        <div><div class="track">${escapeHtml(s.name)} ${tag}</div><div class="artist">${escapeHtml(s.artist)}${plays}</div></div>
        <div class="actions">
          <button data-act="lyrics" data-i="${i}">Ver letra</button>
          <button data-act="play" data-i="${i}" title="Reproducir en Spotify y ver la letra">▶ Escuchar</button>
        </div>
      </li>`;
  }).join("");
  $("#top-list").onclick = async (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      const i = Number(btn.dataset.i);
      const song = songs[i];
      if (btn.dataset.act === "lyrics") { showView("now"); loadSong(song); }
      if (btn.dataset.act === "play") {
        btn.disabled = true;
        btn.textContent = "Abriendo…";
        try {
          // La lista visible como cola: al terminar sigue con la siguiente (ya filtrada).
          const ok = await playOnSpotify({ uris: songs.map((s) => s.uri), offset: { position: i } });
          showView("now");
          loadSong(song);
          if (!ok) toast("Abrí la canción en tu app de Spotify. Si no empieza sola, dale play allá y aquí la letra se sincroniza.");
          poll();
        } catch (e) {
          alert(e.message);
        } finally {
          btn.disabled = false;
          btn.textContent = "▶ Escuchar";
        }
      }
  };
}

// ---------------- Vocabulario y repaso (repetición espaciada tipo SM-2) ----------------
const DAY = 86400000;
const isDue = (v) => new Date(v.due) <= new Date();
const isMastered = (v) => (v.interval || 0) >= 21;

function schedule(v, grade) {
  let ease = v.ease || 2.5;
  let interval = v.interval || 0;
  let reps = v.reps || 0;
  if (grade === 0) { reps = 0; interval = 0; ease = Math.max(1.3, ease - 0.2); }
  else if (grade === 1) { interval = Math.max(1, Math.round(interval * 1.2)); ease = Math.max(1.3, ease - 0.15); reps++; }
  else if (grade === 2) { interval = reps === 0 ? 1 : reps === 1 ? 3 : Math.round(Math.max(interval, 1) * ease); reps++; }
  else { interval = reps === 0 ? 4 : Math.round(Math.max(interval, 1) * ease * 1.3); ease += 0.15; reps++; }
  const due = new Date(Date.now() + (interval ? interval * DAY : 10 * 60000)).toISOString();
  return { ease, interval, reps, due };
}
const intervalLabel = (v, g) => { const d = schedule(v, g).interval; return d === 0 ? "10 min" : d === 1 ? "1 día" : `${d} días`; };

function updateCounts() {
  $("#vocab-count").textContent = state.vocab.length;
  $("#due-count").textContent = state.vocab.filter(isDue).length;
}

function renderVocab() {
  const mastered = state.vocab.filter(isMastered).length;
  $("#vocab-stats").innerHTML = `
    <div><b>${state.vocab.length}</b>palabras guardadas</div>
    <div><b>${state.vocab.filter(isDue).length}</b>por repasar hoy</div>
    <div><b>${mastered}</b>dominadas (21+ días)</div>`;
  $("#vocab-list").innerHTML = state.vocab.length
    ? state.vocab.map((v) => `
      <li>
        <button class="del" data-id="${v.id}" title="Borrar">✕</button>
        <button class="say" data-say="${escapeHtml(v.term)}" title="Escuchar">🔊</button>
        <div class="term">${escapeHtml(v.term)}</div>
        <div class="meaning">${escapeHtml(v.meaning || "")}</div>
        <div class="ctx">"${escapeHtml(v.line || "")}" — ${escapeHtml(v.track || "")}</div>
        <div class="level">${isMastered(v) ? "⭐ Dominada" : v.reps ? `Próximo repaso: ${new Date(v.due).toLocaleDateString("es-CO")}` : "Nueva"}</div>
      </li>`).join("")
    : `<li class="status">Todavía no has guardado palabras.</li>`;
  $("#vocab-list").onclick = async (ev) => {
    const s = ev.target.closest(".say");
    if (s) return say(s.dataset.say, 0.8);
    const id = ev.target.closest(".del")?.dataset.id;
    if (!id) return;
    await api(`/api/vocab/${id}`, null, "DELETE");
    state.vocab = state.vocab.filter((v) => v.id !== id);
    updateCounts();
    renderVocab();
  };
}

// Tres tipos de tarjeta que se alternan según el nivel de la palabra:
// reconocer (inglés → español), completar la letra y producir (español → inglés).
function cardKind(v) {
  const reps = v.reps || 0;
  if (reps === 0) return "recognize";
  return reps % 2 === 1 ? "cloze" : "produce";
}

function renderReview() {
  const due = state.vocab.filter(isDue);
  const card = $("#review-card");
  const t = state.stats[today()] || {};
  const goal = `<div class="goal">Hoy: ${t.reviews || 0} repasos · ${t.cloze || 0} huecos · ${t.added || 0} palabras nuevas</div>`;
  if (!due.length) {
    card.innerHTML = (state.vocab.length
      ? `<p>🎉 No tienes nada pendiente por hoy. Sigue escuchando y guarda palabras nuevas, o practica con el modo Huecos.</p>`
      : `<p>Guarda palabras desde las letras para empezar a repasar.</p>`) + goal;
    return;
  }
  const v = due[0];
  const kind = cardKind(v);
  const word = v.word || v.term;
  const wordRe = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const head = `<div class="kind">${due.length} por repasar · ${escapeHtml(v.track || "")}</div>`;

  if (kind === "recognize") {
    card.innerHTML = `${head}
      <div class="kind">¿Qué significa?</div>
      <div class="q"><span class="term-big">${escapeHtml(v.term)}</span> <button class="say" id="r-say">🔊</button></div>
      <div class="hint">"${escapeHtml(v.line || "")}"</div>
      <div class="btns"><button id="reveal">Mostrar respuesta</button></div>${goal}`;
    say(v.term, 0.85);
    $("#r-say").onclick = () => say(v.term, 0.8);
  } else {
    const prompt = kind === "cloze"
      ? `<div class="kind">Completa la letra</div>
         <div class="q">"${escapeHtml(v.line || "").replace(wordRe, `<span class="blank">?</span>`)}"</div>
         <div class="hint">Pista: ${escapeHtml(v.meaning || "")}</div>`
      : `<div class="kind">¿Cómo se dice en inglés?</div>
         <div class="q">${escapeHtml(v.meaning || "")}</div>
         <div class="hint">Contexto: "${escapeHtml(v.lineTranslation || "")}"</div>`;
    card.innerHTML = `${head}${prompt}
      <p><input class="answer" id="answer" placeholder="Escribe en inglés y pulsa Enter" autocomplete="off" spellcheck="false"></p>
      <div class="btns"><button id="reveal">Comprobar</button></div>${goal}`;
    $("#answer").focus();
    $("#answer").onkeydown = (e) => { if (e.key === "Enter") $("#reveal").click(); };
  }

  $("#reveal").onclick = () => {
    const typed = $("#answer")?.value || "";
    const target = kind === "cloze" ? word : v.term;
    const correct = typed && norm(typed) === norm(target);
    const verdict = kind === "recognize" ? "" : typed
      ? `<div class="${correct ? "cloze-score" : "error"}">${correct ? "✔ ¡Correcto!" : `✘ Escribiste "${escapeHtml(typed)}"`}</div>` : "";
    card.innerHTML = `${head}${verdict}
      <div class="q"><span class="term-big">${escapeHtml(v.term)}</span> <button class="say" id="r-say">🔊</button></div>
      <div class="meaning" style="color:var(--accent);font-size:1.2rem">${escapeHtml(v.meaning || "")}</div>
      ${v.pronunciation ? `<div class="hint">Se pronuncia: ${escapeHtml(v.pronunciation)}</div>` : ""}
      <div class="a">${escapeHtml(v.explanation || "")}</div>
      <div class="hint">"${escapeHtml(v.line || "")}"<br>${escapeHtml(v.lineTranslation || "")}</div>
      <div class="btns">
        <button data-g="0">😵 Otra vez<small>${intervalLabel(v, 0)}</small></button>
        <button data-g="1">😕 Difícil<small>${intervalLabel(v, 1)}</small></button>
        <button data-g="2">🙂 Bien<small>${intervalLabel(v, 2)}</small></button>
        <button data-g="3">😎 Fácil<small>${intervalLabel(v, 3)}</small></button>
      </div>${goal}`;
    say(v.term, 0.85);
    $("#r-say").onclick = () => say(v.term, 0.8);
    card.querySelector(".btns").onclick = async (ev) => {
      const g = ev.target.closest("button")?.dataset.g;
      if (g == null) return;
      const patch = schedule(v, Number(g));
      Object.assign(v, patch);
      await api(`/api/vocab/${v.id}`, patch, "PATCH");
      stat("reviews");
      updateCounts();
      renderReview();
    };
  };
}

// ---------------- Configuración y modo ----------------
// Si hay servidor (PC), él responde /api/config. Si no (GitHub Pages en la tablet), la app
// carga la versión que corre entera en el navegador.
async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    if (res.ok && res.headers.get("content-type")?.includes("json")) return await res.json();
  } catch {}
  local = await import("./local-api.js");
  return local.localConfig();
}

// ---------------- Ajustes y respaldo ----------------
function toggleSettings(open) {
  $("#settings").hidden = !open;
  if (!open) return;
  const standalone = !!state.config.standalone;
  $("#settings-key").hidden = !standalone;
  $("#settings-mode").textContent = standalone
    ? "Versión sin servidor: todo se guarda en este navegador. Para pasar tu vocabulario entre el PC y la tablet, exporta en uno e importa en el otro."
    : "Versión del PC: los datos se guardan en la carpeta data/ del PC.";
  if (standalone) {
    $("#gemini-key").value = "";
    $("#gemini-key").placeholder = local.getGeminiKey() ? "•••••••• (guardada; escribe otra para cambiarla)" : "AIza…";
  }
}

async function reloadData() {
  [state.vocab, state.stats] = await Promise.all([api("/api/vocab"), api("/api/stats")]);
  updateCounts();
  renderStreak();
}

function setupSettings() {
  $("#settings-open").onclick = () => toggleSettings(true);
  $("#settings-close").onclick = () => toggleSettings(false);
  $("#settings").onclick = (ev) => { if (ev.target.id === "settings") toggleSettings(false); };
  document.addEventListener("click", (ev) => { if (ev.target.closest("[data-open-settings]")) toggleSettings(true); });

  $("#gemini-save").onclick = () => {
    const key = $("#gemini-key").value.trim();
    if (!key) return;
    local.setGeminiKey(key);
    state.config = local.localConfig();
    $("#gemini-key").value = "";
    toast("Clave de Gemini guardada en este dispositivo.");
    toggleSettings(false);
    if (!$("#view-setup").hidden) showSetup();
    else if (state.song) loadSong(state.song); // explicar ya la canción que se está viendo
  };

  $("#export-data").onclick = async () => {
    try {
      const data = await api("/api/export");
      const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `letralab-respaldo-${today()}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(`Respaldo listo: ${data.vocab.length} palabras y ${Object.keys(data.cache).length} letras o explicaciones.`);
    } catch (e) { toast(`No se pudo exportar: ${e.message}`); }
  };

  $("#import-file").onchange = async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const r = await api("/api/import", data);
      await reloadData().catch(() => {});
      toast(`Importado: ${r.vocab} palabras nuevas y ${r.cache} letras o explicaciones.`);
    } catch (e) { toast(`No se pudo importar: ${e.message}`); }
  };
}

// ---------------- Arranque ----------------
async function main() {
  document.documentElement.style.setProperty("--scale", store.get("scale") || 1);
  state.config = await loadConfig();
  if (state.config.standalone) REDIRECT_URI = location.origin + BASE_PATH;
  setupSettings();

  $("#login").onclick = login;
  $("#tabs").onclick = (ev) => { const b = ev.target.closest("button"); if (b) showView(b.dataset.view); };
  $("#modes").onclick = (ev) => { const b = ev.target.closest("button"); if (b) setMode(b.dataset.mode); };
  const savedRange = store.get("top_range");
  if (savedRange && $(`#top-range option[value="${savedRange}"]`)) $("#top-range").value = savedRange;
  $("#top-range").onchange = loadTop;
  $("#only-en").checked = store.get("only_en") ?? true;
  $("#only-en").onchange = () => { store.set("only_en", $("#only-en").checked); renderTop(); };
  $("#font-up").onclick = () => setScale(0.1);
  $("#font-down").onclick = () => setScale(-0.1);
  $("#word-close").onclick = () => { $("#word-pop").hidden = true; };
  $("#lyrics").onclick = onLyricsClick;
  $("#lyrics").onkeydown = (ev) => { if (ev.target.matches(".cloze input") && ev.key === "Enter") checkCloze(ev.target); };
  setMode(state.mode);
  if ("speechSynthesis" in window) speechSynthesis.getVoices();

  const control = (method, path) => async () => {
    try { await spotify(path, { method }); setTimeout(poll, 400); } catch (e) { console.warn(e); }
  };
  $("#btn-prev").onclick = control("POST", "/me/player/previous");
  $("#btn-next").onclick = control("POST", "/me/player/next");
  $("#btn-play").onclick = togglePlay;
  document.addEventListener("keydown", onKey);
  $("#shortcuts-list").innerHTML = SHORTCUTS.map(([k, d]) => `<dt>${k.split(" ").map((p) => (/^[·/+]$/.test(p) ? p : `<kbd>${p}</kbd>`)).join(" ")}</dt><dd>${d}</dd>`).join("");
  $("#shortcuts-open").onclick = () => toggleShortcuts(true);
  $("#shortcuts-close").onclick = () => toggleShortcuts(false);
  $("#shortcuts").onclick = (ev) => { if (ev.target.id === "shortcuts") toggleShortcuts(false); };

  const back = new URLSearchParams(location.search);
  if (location.pathname === "/callback" || back.has("code") || back.has("error")) {
    try { await handleCallback(); } catch (e) { alert(e.message); }
  }

  if (!state.config.spotifyClientId || !(await accessToken())) return showSetup();

  await reloadData();
  $("#tabs").hidden = false;
  showView("now");
  poll();
  setInterval(poll, 3000);
  // Ir guardando el historial para "Última semana" (Spotify solo recuerda las últimas 50).
  const keepHistory = () => syncPlays().catch((e) => console.warn("historial", e));
  keepHistory();
  setInterval(keepHistory, 30 * 60 * 1000);
  requestAnimationFrame(tick);
}

main();

// Para poder instalar LetraLab como app (ventana propia, ícono en la barra de tareas).
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
