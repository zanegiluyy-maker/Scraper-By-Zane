/**
 * Name : YouTube Music Scraper (music.youtube.com)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://music.youtube.com
 * Type : Scraper
 * Function : search (songs/albums/artists/playlists), song/stream (audio langsung),
 *            album (+track), artist (+popular).
 * Note : error fix sendiri.
 */

import { spawnSync } from "node:child_process";

const BASE = "https://music.youtube.com";
const KEY = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";
const WEB_VER = "1.20261115.14.00";
const DOH = "https://cloudflare-dns.com/dns-query";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
// client VISIONOS — satu-satunya yang masih ngasih url audio langsung tanpa PO token
const VISIONOS_BASE = {
  clientName: "VISIONOS",
  clientVersion: "1.02",
  deviceMake: "Apple",
  deviceModel: "RealityDevice17,1",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  osName: "visionOS",
  osVersion: "26.5.23O471",
  hl: "en",
  gl: "US",
};
const FILTER_SONGS = "EgWKAQIIAWoKEAoQAxAEEAkQBQ%3D%3D";

// visitorData wajib utk player — tanpa ini sebagian video kena
// "Sign in to confirm you're not a bot" (LOGIN_REQUIRED)
let _visitor = null;
function getVisitor() {
  if (_visitor) return _visitor;
  const r = curl(`${BASE}/`, { timeout: 15 });
  const m = r.body.match(/"visitorData":"([^"]+)"/) || r.body.match(/"VISITOR_DATA":"([^"]+)"/);
  _visitor = m ? m[1] : null;
  return _visitor;
}
function visionosClient() {
  const v = getVisitor();
  return v ? { ...VISIONOS_BASE, visitorData: v } : { ...VISIONOS_BASE };
}

function die(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}
function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}
function dec(s) {
  if (s == null) return s;
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function curl(url, { timeout = 20, referer, range, method = "GET", body, headers = {} } = {}) {
  const run = (useDoh) => {
    const args = ["-s", "-m", String(timeout), "--http1.1", "--compressed", "-L", "--max-redirs", "4",
      "-A", UA, "-w", "\n__CURL_CODE__%{http_code}"];
    if (useDoh) args.push("--doh-url", DOH);
    if (referer) args.push("-H", `Referer: ${referer}`);
    if (range) args.push("-r", range);
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    if (method !== "GET") args.push("-X", method);
    if (body != null) {
      args.push("-H", "Content-Type: application/json");
      args.push("--data", body);
    }
    args.push(url);
    const r = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 40 * 1024 * 1024 });
    const raw = r.stdout || "";
    const m = raw.match(/\n__CURL_CODE__(\d{3})$/);
    return { code: m ? Number(m[1]) : 0, body: m ? raw.slice(0, m.index) : raw, status: r.status ?? 0 };
  };
  let r = run(false);
  if (r.code === 0 || r.status !== 0) r = run(true);
  return r;
}

function innertube(api, payload, { client = null, origin = BASE } = {}) {
  const ctxClient = client || { clientName: "WEB_REMIX", clientVersion: WEB_VER, hl: "en", gl: "US" };
  const body = JSON.stringify({ context: { client: ctxClient }, ...payload });
  const r = curl(`${origin}/youtubei/v1/${api}?key=${KEY}`, {
    method: "POST", body,
    headers: { Origin: origin, Referer: `${origin}/` },
  });
  if (r.code !== 200) die(`${api} HTTP ${r.code}`);
  try { return JSON.parse(r.body); } catch { die(`${api}: respons bukan JSON`); }
}

function walk(o, pred, out = []) {
  if (!o || typeof o !== "object") return out;
  if (pred(o)) out.push(o);
  for (const v of Object.values(o)) walk(v, pred, out);
  return out;
}
const runsText = (r) => (r?.runs || []).map((x) => x.text).join("");

function classifyItem(r) {
  const s = JSON.stringify(r);
  const vid = walk(r, (o) => o.watchEndpoint?.videoId).map((o) => o.watchEndpoint.videoId)[0];
  const bids = [...s.matchAll(/"browseId":"([^"]+)"/g)].map((m) => m[1]);
  if (vid) return { kind: "song", videoId: vid };
  if (bids.some((b) => b.startsWith("MPRE"))) return { kind: "album", browseId: bids.find((b) => b.startsWith("MPRE")) };
  if (bids.some((b) => b.startsWith("VL"))) return { kind: "playlist", browseId: bids.find((b) => b.startsWith("VL")) };
  if (bids.some((b) => b.startsWith("UC"))) return { kind: "artist", browseId: bids.find((b) => b.startsWith("UC")) };
  if (bids.length) return { kind: "other", browseId: bids[0] };
  return { kind: "other" };
}

function parseSearchItem(it) {
  const r = it.musicResponsiveListItemRenderer;
  if (!r) return null;
  const cols = (r.flexColumns || []).map((c) => {
    const runs = c.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    return runs.map((x) => ({
      text: x.text,
      videoId: x.navigationEndpoint?.watchEndpoint?.videoId || null,
      browseId: x.navigationEndpoint?.browseEndpoint?.browseId || null,
    }));
  });
  const cls = classifyItem(r);
  const title = runsText(cols[0]?.length ? { runs: cols[0] } : null) || null;
  const flat = cols.flat();
  // duration album ada di fixedColumns, bukan flexColumns
  const fixedRuns = (r.fixedColumns || [])
    .map((f) => f.musicResponsiveListItemFixedColumnRenderer?.text?.runs || [])
    .flat();
  const allTexts = [...flat, ...fixedRuns.map((x) => ({ text: x.text, videoId: null, browseId: null }))];
  // album/duration bisa di kolom mana saja (playlist: album di kolom terpisah)
  const artists = flat.filter((x) => x.browseId?.startsWith("UC")).map((x) => x.text);
  const albumRun = flat.find((x) => x.browseId?.startsWith("MPRE"));
  const duration = allTexts.find((x) => /^\d+:\d{2}(:\d{2})?$/.test(x.text))?.text || null;
  const plays = allTexts.find((x) => /plays$/i.test(x.text))?.text || null;
  const thumb = walk(r, (o) => o.musicThumbnailRenderer?.thumbnail?.thumbnails)?.[0]
    ?.musicThumbnailRenderer?.thumbnail?.thumbnails;
  return {
    kind: cls.kind,
    title,
    videoId: cls.videoId || null,
    browseId: cls.browseId || null,
    artists: artists.length ? artists : null,
    album: albumRun ? albumRun.text : null,
    albumId: albumRun?.browseId || null,
    duration,
    plays,
    thumbnail: thumb ? thumb[thumb.length - 1].url : null,
    url: cls.kind === "song" && cls.videoId ? `${BASE}/watch?v=${cls.videoId}`
      : cls.browseId ? `${BASE}/browse/${cls.browseId}` : null,
  };
}

/* ---------- search ---------- */
function cmdSearch(pos, flags) {
  const q = pos.join(" ").trim();
  if (!q) die("usage: node ytmusic.js search <query> [--type songs|albums|artists|playlists|all]");
  const type = String(flags.type || "all").toLowerCase();
  const payload = { query: q };
  if (type === "songs") payload.params = FILTER_SONGS;
  else if (!["all", "videos"].includes(type)) {
    // type lain: search all lalu post-filter (params resmi YT Music sering berubah)
  }
  const j = innertube("search", payload);
  let items = walk(j, (o) => o.musicResponsiveListItemRenderer).map(parseSearchItem).filter(Boolean);
  // dedupe by identity
  const seen = new Set();
  items = items.filter((x) => {
    const id = x.videoId || x.browseId || x.title;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (type !== "all" && type !== "songs") {
    const map = { albums: "album", artists: "artist", playlists: "playlist", videos: "song" };
    const want = map[type];
    if (want) items = items.filter((x) => x.kind === want);
  }
  out({ ok: 1, credit: "Zane", query: q, type, total: items.length, items });
}

/* ---------- song / stream ---------- */
function probeAudio(url) {
  const run = (extra) => {
    const args = ["-s", "-m", "15", "--http1.1", "-L", "-A", VISIONOS_BASE.userAgent,
      "-r", "0-63", "-w", "\n__CURL_CODE__%{http_code}",
      "-H", `Referer: ${BASE}/`, ...extra, url];
    const r = spawnSync("curl", args, { encoding: "buffer", maxBuffer: 4096 });
    const raw = r.stdout || Buffer.alloc(0);
    const marker = Buffer.from("\n__CURL_CODE__");
    const idx = raw.lastIndexOf(marker);
    const code = idx >= 0 ? Number(raw.slice(idx + marker.length).toString().trim()) : 0;
    const body = idx >= 0 ? raw.slice(0, idx) : raw;
    return { code, body, status: r.status ?? 0 };
  };
  let r = run(["-H", "sec-fetch-dest: video", "-H", "sec-fetch-mode: no-cors", "-H", "sec-fetch-site: cross-site"]);
  if (!(r.status === 0 && (r.code === 200 || r.code === 206))) r = run([]);
  const alive = r.status === 0 && (r.code === 200 || r.code === 206);
  const b = r.body;
  const isMp4 = b.length >= 8 && b.slice(4, 8).toString() === "ftyp";
  const isWebm = b.length >= 4 && b.slice(0, 4).toString("hex") === "1a45dfa3";
  return { alive, magic: alive && (isMp4 || isWebm) };
}

function parseWatchUrl(x) {
  x = String(x || "").trim();
  if (!x) die("usage: node ytmusic.js song <url|videoId>");
  if (/^https?:\/\//.test(x) || x.includes("v=")) {
    try {
      const u = new URL(x.startsWith("http") ? x : `${BASE}/${x}`);
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/watch\?(?:[^&]*&)*v=([A-Za-z0-9_-]+)/);
      if (m) return m[1];
    } catch { /* fallthrough */ }
    const m = x.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
    if (m) return m[1];
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(x)) return x;
  die(`bukan videoId/URL YouTube valid: "${x}"`);
}

function cmdSong(pos, flags) {
  const videoId = parseWatchUrl(pos.join(" "));
  const j = innertube("player", {
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: { contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" } },
  }, { client: visionosClient(), origin: BASE });

  const status = j.playabilityStatus?.status;
  if (status !== "OK") die(`player ${status}: ${j.playabilityStatus?.reason || "unknown"}`);
  const v = j.videoDetails || {};
  const s = j.streamingData || {};
  const audio = (s.adaptiveFormats || []).filter((f) => f.mimeType?.startsWith("audio/"));
  if (!audio.length) die("tidak ada format audio di respons player");

  const files = audio
    .sort((a, b) => (b.averageBitrate || 0) - (a.averageBitrate || 0))
    .map((f) => ({
      itag: f.itag,
      mime: (f.mimeType || "").split(";")[0],
      bitrate: f.averageBitrate || f.bitrate || null,
      size: f.contentLength ? Number(f.contentLength) : null,
      audioQuality: f.audioQuality || null,
      url: f.url || null,
      alive: null,
      magic: null,
    }))
    .filter((f) => f.url);

  if (!files.length) die("format audio tanpa url (klien mungkin berubah — cek Note di header)");
  for (const f of files) {
    const p = probeAudio(f.url);
    f.alive = p.alive;
    f.magic = p.magic;
  }
  const aliveN = files.filter((f) => f.alive).length;
  const notes = [];
  if (aliveN) notes.push(`${aliveN}/${files.length} audio live (Range GET 206 + magic mp4/webm); client=VISIONOS (url langsung, tanpa PO token)`);
  else notes.push("SEMUA url audio tidak bisa diakses — kemungkinan expired, scrape ulang");
  if (s.expiresInSeconds) notes.push(`url kedaluwarsa ~${Math.round(Number(s.expiresInSeconds) / 3600)} jam lagi`);

  const thumbs = v.thumbnail?.thumbnails || [];
  out({
    ok: 1, credit: "Zane",
    videoId,
    url: `${BASE}/watch?v=${videoId}`,
    title: v.title || null,
    author: v.author || null,
    channelId: v.channelId || null,
    duration: v.lengthSeconds ? Number(v.lengthSeconds) : null,
    views: v.viewCount ? Number(v.viewCount) : null,
    description: v.shortDescription || null,
    keywords: v.keywords || null,
    thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : null,
    expiresInSeconds: s.expiresInSeconds ? Number(s.expiresInSeconds) : null,
    totalFiles: files.length,
    files,
    notes,
  });
}

/* ---------- album ---------- */
function parseBrowseRef(x) {
  x = String(x || "").trim();
  if (!x) die("id kosong");
  if (/^https?:\/\//.test(x) || x.includes("/")) {
    const u = /^https?:\/\//.test(x) ? x : `${BASE}/${x.replace(/^\/+/, "")}`;
    try {
      const url = new URL(u);
      const list = url.searchParams.get("list");
      if (list) return { browseId: list.startsWith("VL") ? list : `VL${list}`, type: "playlist" };
      const m = url.pathname.match(/\/browse\/([A-Za-z0-9_-]+)/)
        || url.pathname.match(/\/channel\/([A-Za-z0-9_-]+)/);
      if (m) {
        const id = m[1];
        if (id.startsWith("MPRE")) return { browseId: id, type: "album" };
        if (id.startsWith("UC")) return { browseId: id, type: "artist" };
        if (id.startsWith("VL")) return { browseId: id, type: "playlist" };
        if (id.startsWith("OLAK") || id.startsWith("RD")) return { browseId: `VL${id}`, type: "playlist" };
        return { browseId: id, type: "browse" };
      }
    } catch { /* fallthrough */ }
  }
  if (/^MPRE[A-Za-z0-9_-]+$/.test(x)) return { browseId: x, type: "album" };
  if (/^UC[A-Za-z0-9_-]+$/.test(x)) return { browseId: x, type: "artist" };
  if (/^(VL)?OLAK5uy_/.test(x) || /^VL[A-Za-z0-9_-]{10,}$/.test(x)) {
    return { browseId: x.startsWith("VL") ? x : `VL${x}`, type: "playlist" };
  }
  die(`browseId tidak dikenal: "${x}" (MPRE*=album, UC*=artist, OLAK/VL*=playlist)`);
}

function cmdAlbum(pos) {
  const { browseId, type } = parseBrowseRef(pos.join(" "));
  const j = innertube("browse", { browseId });
  const micro = j.microformat?.microformatDataRenderer || {};
  // album MPRE pakai musicShelfRenderer; playlist album (VL...) pakai musicPlaylistShelfRenderer
  const shelf = [
    ...walk(j, (o) => o.musicShelfRenderer).map((x) => x.musicShelfRenderer),
    ...walk(j, (o) => o.musicPlaylistShelfRenderer).map((x) => x.musicPlaylistShelfRenderer),
  ];
  const tracks = [];
  for (const sh of shelf) {
    for (const c of sh.contents || []) {
      const item = parseSearchItem(c);
      if (item && item.videoId) tracks.push({
        n: tracks.length + 1,
        title: item.title,
        videoId: item.videoId,
        duration: item.duration,
        artists: item.artists,
        album: item.album,
        url: `${BASE}/watch?v=${item.videoId}`,
      });
    }
  }
  const related = walk(j, (o) => o.musicTwoRowItemRenderer)
    .map((x) => x.musicTwoRowItemRenderer)
    .map((x) => ({
      title: runsText(x.title) || x.title?.content || null,
      browseId: walk(x, (o) => o.browseEndpoint?.browseId)[0]?.browseEndpoint?.browseId || null,
      subtitle: runsText(x.subtitle) || null,
    }))
    .filter((x) => x.title)
    .slice(0, 12);
  // playlist browse kadang tanpa microformat -> judul fallback dari album track
  const title = micro.title || (tracks.length ? tracks.find((t) => t.album)?.album : null) || null;
  if (!title && !tracks.length) die("album/playlist tidak ditemukan / respons kosong");
  out({
    ok: 1, credit: "Zane",
    browseId,
    type,
    url: micro.urlCanonical || (type === "playlist" ? `${BASE}/browse/${browseId}` : `${BASE}/browse/${browseId}`),
    title,
    description: micro.description || null,
    thumbnail: micro.thumbnail?.thumbnails?.slice(-1)[0]?.url || null,
    totalTracks: tracks.length,
    tracks,
    related,
  });
}

/* ---------- artist ---------- */
function cmdArtist(pos) {
  const { browseId } = parseBrowseRef(pos.join(" "));
  const j = innertube("browse", { browseId });
  const hdr = j.header?.musicImmersiveHeaderRenderer || {};
  const title = hdr.title?.content || runsText(hdr.title) || null;
  const subtitle = hdr.subtitle?.content || runsText(hdr.subtitle) || null;
  const thumb = walk(hdr, (o) => o.musicThumbnailRenderer?.thumbnail?.thumbnails)?.[0]
    ?.musicThumbnailRenderer?.thumbnail?.thumbnails;
  const songs = [];
  const seen = new Set();
  for (const it of walk(j, (o) => o.musicResponsiveListItemRenderer)) {
    const item = parseSearchItem(it);
    if (!item?.videoId || seen.has(item.videoId)) continue;
    seen.add(item.videoId);
    songs.push({
      title: item.title,
      videoId: item.videoId,
      duration: item.duration,
      plays: item.plays,
      url: `${BASE}/watch?v=${item.videoId}`,
    });
  }
  const sections = walk(j, (o) => o.musicCarouselShelfRenderer)
    .map((x) => x.musicCarouselShelfRenderer)
    .map((x) => runsText(x.header?.carouselHeaderRenderer?.title) || null)
    .filter(Boolean);
  if (!title && !songs.length) die("artist tidak ditemukan / respons kosong");
  out({
    ok: 1, credit: "Zane",
    browseId,
    url: `${BASE}/browse/${browseId}`,
    title,
    subtitle,
    thumbnail: thumb ? thumb[thumb.length - 1].url : null,
    sections,
    totalSongs: songs.length,
    songs,
  });
}

/* ---------- main ---------- */
function help() {
  out({
    ok: 1, credit: "Zane",
    usage: [
      "node ytmusic.js search <query> [--type songs|albums|artists|playlists|all]",
      "node ytmusic.js song <url|videoId>",
      "node ytmusic.js stream <url|videoId>",
      "node ytmusic.js album <url|MPRE...>",
      "node ytmusic.js artist <url|UC...>",
      "node ytmusic.js --help",
    ],
    notes: [
      "search: InnerTube WEB_REMIX; --type songs pakai filter resmi, type lain post-filter kind.",
      "song/stream: client VISIONOS + visitorData -> url audio mp4/webm LANGSUNG (bypass PO token + bot check), diuji Range 206+magic.",
      "album: MPRE=microformat+shelf; playlist VL/OLAK=shelf tanpa header (judul fallback). duration di fixedColumns.",
      "artist: header + daftar lagu populer. URL /channel/UC... juga diterima.",
      "url audio basi ~6 jam / kena 403 -> jalankan ulang song/stream.",
    ],
  });
}

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith("--")) {
    const k = a.slice(2), n = rest[i + 1];
    if (n !== undefined && !n.startsWith("--")) { flags[k] = n; i++; }
    else flags[k] = true;
  } else pos.push(a);
}
switch (cmd) {
  case "search": cmdSearch(pos, flags); break;
  case "song": case "stream": case "play": cmdSong(pos, flags); break;
  case "album": cmdAlbum(pos); break;
  case "artist": cmdArtist(pos); break;
  case "--help": case "help": case undefined: help(); break;
  default: die(`perintah tidak dikenal: ${cmd} (pakai --help)`);
}
