// LetraLab — interfaz.
const $ = (s) => document.querySelector(s);
const REDIRECT_URI = `${location.origin}/callback`;
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
  playing: null,      // { id, name, artist, album, duration, cover, uri }
  isPlaying: false,
  progressMs: 0,
  progressAt: 0,      // performance.now() cuando se midió progressMs
  lastPlayingId: null,
  song: null,         // canción cuya letra se muestra
  lines: [],          // [{ time, text, translation, note }]
  activeIndex: -1,
  vocab: [],
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
  history.replaceState(null, "", "/");
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
  if (res.status === 204) return null;
  if (res.status === 401) { store.del("spotify_token"); showSetup(); throw new Error("Sesión de Spotify vencida"); }
  if (!res.ok) {
    const err = new Error(`Spotify ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
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

// ---------------- API local ----------------
async function api(pathname, body, method) {
  const res = await fetch(pathname, body
    ? { method: method || "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : { method: method || "GET" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

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
  const missing = [];
  if (!state.config.spotifyClientId) missing.push("<code>SPOTIFY_CLIENT_ID</code>");
  if (!state.config.ai.gemini && !state.config.ai.claude) missing.push("<code>GEMINI_API_KEY</code> (o <code>ANTHROPIC_API_KEY</code>)");
  $("#setup-missing").hidden = !missing.length;
  $("#setup-missing").innerHTML = missing.length
    ? `Falta configurar en el archivo <code>.env</code>: ${missing.join(", ")}. Luego reinicia el servidor.`
    : "";
  $("#login").disabled = !state.config.spotifyClientId;
}

function renderAiStatus() {
  const { gemini, claude } = state.config.ai;
  const parts = [];
  if (gemini) parts.push("Gemini");
  if (claude) parts.push(gemini ? "Claude (respaldo)" : "Claude");
  $("#ai-status").textContent = parts.length ? `IA: ${parts.join(" → ")}` : "IA: sin configurar";
}

// ---------------- Sonando ahora ----------------
async function poll() {
  try {
    const data = await spotify("/me/player/currently-playing");
    if (!data || !data.item || data.currently_playing_type !== "track") {
      state.isPlaying = false;
      if (!state.playing) renderPlayer();
      return;
    }
    state.playing = toSong(data.item);
    state.isPlaying = data.is_playing;
    state.progressMs = data.progress_ms;
    state.progressAt = performance.now();
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
    // Viendo la letra de una canción que no está sonando.
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

function tick() {
  if (state.playing) {
    const t = currentSeconds();
    $("#progress-bar").style.width = `${Math.min(100, (t / state.playing.duration) * 100)}%`;
    const synced = state.song && state.song.id === state.playing.id && state.lines.length && state.lines[0].time != null;
    if (synced) {
      let idx = -1;
      // Adelanta 0.3 s para que la línea se marque justo cuando empieza.
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
  const el = items[idx];
  if (el) {
    el.classList.add("active");
    if (!document.hidden && !$("#view-now").hidden) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

async function loadSong(song) {
  state.song = song;
  state.lines = [];
  state.activeIndex = -1;
  $("#lyrics").innerHTML = "";
  $("#summary").hidden = true;
  $("#lyrics-status").textContent = "Buscando la letra…";
  renderPlayer();

  let lyr;
  try {
    lyr = await api(`/api/lyrics?${new URLSearchParams({ track: song.name, artist: song.mainArtist, album: song.album, duration: song.duration })}`);
  } catch (e) {
    $("#lyrics-status").innerHTML = `<span class="error">No se pudo buscar la letra: ${e.message}</span>`;
    return;
  }
  if (state.song !== song) return; // cambió la canción mientras tanto
  if (!lyr.found) { $("#lyrics-status").textContent = "No encontré la letra de esta canción en LRCLIB."; return; }
  if (lyr.instrumental) { $("#lyrics-status").textContent = "Esta canción es instrumental 🎵"; return; }

  state.lines = lyr.synced
    ? lyr.synced.map((l) => ({ time: l.time, text: l.text }))
    : lyr.plain.split(/\r?\n/).map((text) => ({ time: null, text: text.trim() }));
  renderLyrics();
  $("#lyrics-status").textContent = lyr.synced ? "Explicando la letra…" : "Letra sin tiempos (no se sincroniza). Explicando…";

  try {
    const exp = await api("/api/explain", { track: song.name, artist: song.mainArtist, lines: state.lines.map((l) => l.text) });
    if (state.song !== song) return;
    for (const item of exp.lines) {
      const line = state.lines[item.i];
      if (line) { line.translation = item.translation; line.note = item.note; }
    }
    renderLyrics();
    if (exp.summary) { $("#summary").hidden = false; $("#summary").textContent = exp.summary; }
    $("#lyrics-status").textContent = `Explicado por ${exp.provider === "gemini" ? "Gemini" : "Claude"}${exp.cached ? " (guardado)" : ""}`;
  } catch (e) {
    if (state.song !== song) return;
    $("#lyrics-status").innerHTML = `<span class="error">No se pudo explicar la letra: ${e.message}</span>`;
  }
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderLyrics() {
  const ol = $("#lyrics");
  ol.classList.toggle("unsynced", !state.lines.length || state.lines[0].time == null);
  ol.innerHTML = state.lines.map((l, i) => {
    if (!l.text) return `<li class="gap"></li>`;
    const words = l.text.split(/(\s+)/).map((part) =>
      /\S/.test(part) ? `<span class="w" data-line="${i}">${escapeHtml(part)}</span>` : part).join("");
    return `<li data-i="${i}">
      <div class="en">${words}</div>
      ${l.translation ? `<div class="es">${escapeHtml(l.translation)}</div>` : ""}
      ${l.note ? `<div class="note">${escapeHtml(l.note)}</div>` : ""}
    </li>`;
  }).join("");
  if (state.activeIndex >= 0) ol.children[state.activeIndex]?.classList.add("active");
}

// ---------------- Palabras ----------------
async function openWord(word, lineIndex) {
  const line = state.lines[lineIndex];
  const clean = word.replace(/^[^\w']+|[^\w']+$/g, "");
  if (!clean) return;
  const pop = $("#word-pop");
  pop.hidden = false;
  $("#word-body").innerHTML = `<div class="term">${escapeHtml(clean)}</div><div class="status">Buscando significado…</div>`;
  try {
    const d = await api("/api/define", { word: clean, line: line.text });
    const already = state.vocab.some((v) => v.term?.toLowerCase() === (d.term || clean).toLowerCase());
    $("#word-body").innerHTML = `
      <div class="term">${escapeHtml(d.term || clean)}</div>
      ${d.pronunciation ? `<div class="pron">🔊 ${escapeHtml(d.pronunciation)}</div>` : ""}
      <div class="meaning">${escapeHtml(d.meaning || "")}</div>
      <div class="expl">${escapeHtml(d.explanation || "")}</div>
      <button class="primary" id="save-word" ${already ? "disabled" : ""}>${already ? "Ya está en tu vocabulario" : "Guardar en vocabulario"}</button>`;
    $("#save-word").onclick = async () => {
      const entry = await api("/api/vocab", {
        term: d.term || clean, meaning: d.meaning, explanation: d.explanation, pronunciation: d.pronunciation,
        line: line.text, lineTranslation: line.translation || "", word: clean,
        track: state.song.name, artist: state.song.artist,
      });
      state.vocab.unshift(entry);
      updateCounts();
      $("#save-word").disabled = true;
      $("#save-word").textContent = "Guardada ✔";
    };
  } catch (e) {
    $("#word-body").innerHTML = `<div class="term">${escapeHtml(clean)}</div><div class="error">${escapeHtml(e.message)}</div>`;
  }
}

// ---------------- Más escuchadas ----------------
async function loadTop() {
  const range = $("#top-range").value;
  $("#top-list").innerHTML = `<li class="status">Cargando…</li>`;
  try {
    const data = await spotify(`/me/top/tracks?limit=50&time_range=${range}`);
    const songs = data.items.map(toSong);
    $("#top-list").innerHTML = songs.map((s, i) => `
      <li>
        <span class="n">${i + 1}</span>
        <img src="${s.cover}" alt="">
        <div><div class="track">${escapeHtml(s.name)}</div><div class="artist">${escapeHtml(s.artist)}</div></div>
        <div>
          <button data-act="lyrics" data-i="${i}">Ver letra</button>
          <button data-act="play" data-i="${i}">▶</button>
        </div>
      </li>`).join("");
    $("#top-list").onclick = async (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      const song = songs[btn.dataset.i];
      if (btn.dataset.act === "lyrics") { showView("now"); loadSong(song); }
      if (btn.dataset.act === "play") {
        try {
          await playOnSpotify({ uris: [song.uri] });
          showView("now");
          setTimeout(poll, 800);
        } catch (e) {
          alert(e.message);
        }
      }
    };
  } catch (e) {
    $("#top-list").innerHTML = `<li class="error">${escapeHtml(e.message)}</li>`;
  }
}

// Spotify solo acepta "play" si hay un dispositivo activo. Si la app está
// abierta pero en pausa no cuenta como activa, así que elegimos uno nosotros.
async function playOnSpotify(body) {
  const { devices = [] } = (await spotify("/me/player/devices")) || {};
  const usable = devices.filter((d) => !d.is_restricted);
  const device = usable.find((d) => d.is_active) || usable.find((d) => d.type === "Computer") || usable[0];
  if (!device) {
    throw new Error("No encontré ningún Spotify abierto. Abre la app de Spotify en tu PC o celular y vuelve a intentarlo.");
  }
  const query = device.is_active ? "" : `?device_id=${encodeURIComponent(device.id)}`;
  await spotify(`/me/player/play${query}`, { method: "PUT", ...(body ? { body: JSON.stringify(body) } : {}) });
}

// ---------------- Vocabulario y repaso ----------------
const INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60];
const isDue = (v) => new Date(v.due) <= new Date();

function updateCounts() {
  $("#vocab-count").textContent = state.vocab.length;
  $("#due-count").textContent = state.vocab.filter(isDue).length;
}

function renderVocab() {
  $("#vocab-list").innerHTML = state.vocab.length
    ? state.vocab.map((v) => `
      <li>
        <button class="del" data-id="${v.id}" title="Borrar">✕</button>
        <div class="term">${escapeHtml(v.term)}</div>
        <div class="meaning">${escapeHtml(v.meaning || "")}</div>
        <div class="ctx">"${escapeHtml(v.line || "")}" — ${escapeHtml(v.track || "")}</div>
      </li>`).join("")
    : `<li class="status">Todavía no has guardado palabras.</li>`;
  $("#vocab-list").onclick = async (ev) => {
    const id = ev.target.closest(".del")?.dataset.id;
    if (!id) return;
    await api(`/api/vocab/${id}`, null, "DELETE");
    state.vocab = state.vocab.filter((v) => v.id !== id);
    updateCounts();
    renderVocab();
  };
}

function renderReview() {
  const due = state.vocab.filter(isDue);
  const card = $("#review-card");
  if (!due.length) {
    card.innerHTML = state.vocab.length
      ? `<p>🎉 No tienes nada pendiente por hoy.</p>`
      : `<p>Guarda palabras desde las letras para empezar a repasar.</p>`;
    return;
  }
  const v = due[0];
  const word = v.word || v.term;
  const blanked = escapeHtml(v.line || "").replace(
    new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), `<span class="blank">?</span>`);
  card.innerHTML = `
    <div class="hint">${due.length} por repasar · ${escapeHtml(v.track || "")}</div>
    <div class="q">"${blanked}"</div>
    <div class="hint">Pista: ${escapeHtml(v.meaning || "")}</div>
    <div class="btns"><button id="reveal">Mostrar respuesta</button></div>`;
  $("#reveal").onclick = () => {
    card.innerHTML = `
      <div class="q">${escapeHtml(v.term)}</div>
      ${v.pronunciation ? `<div class="hint">🔊 ${escapeHtml(v.pronunciation)}</div>` : ""}
      <div class="a">${escapeHtml(v.explanation || "")}</div>
      <div class="hint">"${escapeHtml(v.line || "")}"<br>${escapeHtml(v.lineTranslation || "")}</div>
      <div class="btns" style="margin-top:1rem">
        <button data-r="0">😕 No me acordé</button>
        <button data-r="1">🙂 Me acordé</button>
      </div>`;
    card.querySelector(".btns").onclick = async (ev) => {
      const r = ev.target.closest("button")?.dataset.r;
      if (r == null) return;
      const box = r === "1" ? Math.min((v.box || 0) + 1, INTERVAL_DAYS.length - 1) : 0;
      const due = new Date(Date.now() + (box ? INTERVAL_DAYS[box] * 86400000 : 10 * 60000)).toISOString();
      Object.assign(v, { box, due });
      await api(`/api/vocab/${v.id}`, { box, due }, "PATCH");
      updateCounts();
      renderReview();
    };
  };
}

// ---------------- Arranque ----------------
async function main() {
  state.config = await api("/api/config");
  renderAiStatus();

  $("#login").onclick = login;
  $("#tabs").onclick = (ev) => { const b = ev.target.closest("button"); if (b) showView(b.dataset.view); };
  $("#top-range").onchange = loadTop;
  $("#word-close").onclick = () => { $("#word-pop").hidden = true; };
  $("#lyrics").onclick = (ev) => { const w = ev.target.closest(".w"); if (w) openWord(w.textContent, Number(w.dataset.line)); };
  $("#show-translation").onchange = (ev) => {
    document.body.classList.toggle("hide-translation", !ev.target.checked);
    store.set("show_translation", ev.target.checked);
  };
  if (store.get("show_translation") === false) {
    $("#show-translation").checked = false;
    document.body.classList.add("hide-translation");
  }
  const control = (method, path) => async () => {
    try { await spotify(path, { method }); setTimeout(poll, 400); } catch (e) { console.warn(e); }
  };
  $("#btn-prev").onclick = control("POST", "/me/player/previous");
  $("#btn-next").onclick = control("POST", "/me/player/next");
  $("#btn-play").onclick = async () => {
    if (state.isPlaying) return control("PUT", "/me/player/pause")();
    try { await playOnSpotify(); setTimeout(poll, 600); } catch (e) { alert(e.message); }
  };

  if (location.pathname === "/callback") {
    try { await handleCallback(); } catch (e) { alert(e.message); }
  }

  if (!state.config.spotifyClientId || !(await accessToken())) return showSetup();

  state.vocab = await api("/api/vocab");
  updateCounts();
  $("#tabs").hidden = false;
  showView("now");
  poll();
  setInterval(poll, 3000);
  requestAnimationFrame(tick);
}

main();
