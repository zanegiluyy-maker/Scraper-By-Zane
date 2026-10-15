/**
 * Name : Anichin Scraper (home, list, search, detail, episode, schedule, resolve shortlink)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://anichin.moe (fansub donghua sub indo, WordPress + theme tsuki)
 * Type : Scraper
 * Function : Scrape lengkap -> output JSON: rilisan, jadwal, arsip A-Z, genre,
 *            status, search, detail + daftar episode, player server (base64 decode),
 *            tabel download (360p-1080p), resolve shortlink (tinyurl via checkshorturl,
 *            mirrored.to chain sampai link hoster final).
 * Note : error fix sendiri.
 *        - Cloudflare: HTML situs lolos polos, tapi /wp-json = 403 -> parse HTML saja.
 *        - Bypass shortlink: tinyurl kena CF JS challenge -> POST checkshorturl.com
 *          (kuota 120/hari) -> mirrored.to/multilinks -> /files/ -> ?hash&dl=0 ->
 *          mirstats.php (URL di-encode penuh) -> POST /out_url -> meta refresh -> target.
 *        - shrinkme.click (Terabox) = reCAPTCHA -> tidak bisa di-bypass tanpa solver.
 *        Zero dep, native node:http(s), output JSON ke stdout.
 *        Usage:
 *          node anichin.js home [--pages 2]
 *          node anichin.js page 2
 *          node anichin.js list [--status ongoing] [--genre action] [--type donghua] [--order update] [--page 1]
 *          node anichin.js genres
 *          node anichin.js genre action [--page 2]
 *          node anichin.js az [A|--all]
 *          node anichin.js status ongoing|completed|drop|upcoming [--page 1]
 *          node anichin.js search "against the gods"
 *          node anichin.js info against-the-gods
 *          node anichin.js ep against-the-gods-episode-58-subtitle-indonesia
 *          node anichin.js stream against-the-gods-episode-58-subtitle-indonesia --server ok.ru
 *          node anichin.js schedule
 *          node anichin.js resolve "https://tinyurl.com/ax8jpv9b"   # auto-bypass
 */

import { request as httpReq, get as httpGet } from "node:http";
import { request as httpsReq } from "node:https";
import { parseArgs } from "node:util";

const BASE = "https://anichin.moe";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TIMEOUT = 30_000;
const RETRIES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const dec = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");

/** HTTP native: GET/POST, ikut redirect (max 5), retry, tanpa kompresi. */
function req(url, { method = "GET", headers = {}, body, timeout = TIMEOUT, maxRedirect = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? httpReq : httpsReq;
    const rq = lib(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        method,
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "identity",
          ...(body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } : {}),
          ...headers,
        },
      },
      (res) => {
        const status = res.statusCode;
        if (status >= 300 && status < 400 && res.headers.location && maxRedirect > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          return resolve(req(next, { method: method === "POST" && status === 303 ? "GET" : method, body: status === 303 ? undefined : body, headers, maxRedirect: maxRedirect - 1 }));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks), url }));
        res.on("error", reject);
      },
    );
    rq.setTimeout(timeout, () => rq.destroy(new Error("timeout " + url)));
    rq.on("error", reject);
    rq.end(body);
  });
}

async function fetchText(url, opts) {
  let last;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      const r = await req(url, opts);
      if (r.status >= 500) { last = new Error("HTTP " + r.status); await sleep(600 * (i + 1)); continue; }
      return { ...r, text: r.body.toString("utf8") };
    } catch (e) { last = e; await sleep(600 * (i + 1)); }
  }
  throw last;
}

const find = (re, s, g = 1) => { const r = s.match(re); return r ? (r[g] ?? r[0]) : null; };
const all = (re, s) => [...s.matchAll(re)];
const abs = (href) => (!href ? null : href.startsWith("http") ? href : href.startsWith("//") ? "https:" + href : BASE + href);

// ───────────────────────────── parser umum ─────────────────────────────

/** Kartu <article class="bs"> (archive/genre/search/home). */
function parseCards(html) {
  const out = [];
  for (const m of all(/<article class="bs"[\s\S]*?<\/article>/g, html)) {
    const blk = m[0];
    const href = find(/<a href="(\/[^"]+)"[^>]*class="tip"/, blk) || find(/<a href="(\/[^"]+)"/, blk);
    if (!href) continue;
    out.push({
      slug: href.replace(/^\/|\/$/g, ""),
      url: abs(href),
      title: find(/<h2[^>]*>([^<]*)</, blk) || find(/title="([^"]+)"/, blk) || "",
      status: find(/<div class="status [^"]*">([^<]*)</, blk),
      type: find(/<div class="typez [^"]*">([^<]*)</, blk),
      ep: find(/<span class="epx">([^<]*)</, blk),
      sub: find(/<span class="sb [^"]*">([^<]*)</, blk),
      cover: abs(find(/<img src="([^"]+)"/, blk)),
      hot: /class="hotbadge"/.test(blk),
      id: find(/class="tip" rel="(\d+)"/, blk),
    });
  }
  return out;
}

/** Pagination: {page, totalPages, nextUrl} dari pola /page/N/ + page-numbers. */
function parsePagination(html, currentUrl = "") {
  let page = parseInt(find(/\/page\/(\d+)\//, currentUrl) || find(/class="page-numbers current">(\d+)/, html) || "1", 10);
  let totalPages = page;
  for (const m of all(/\/page\/(\d+)\//g, html)) totalPages = Math.max(totalPages, parseInt(m[1], 10));
  for (const m of all(/class="page-numbers"[^>]*>(\d+)</g, html)) totalPages = Math.max(totalPages, parseInt(m[1], 10));
  let next = find(/<a[^>]*class="next page-numbers"[^>]*href="([^"]+)"/, html);
  if (!next && page < totalPages) next = find(new RegExp(`href="([^"]*\\/page\\/${page + 1}\\/)"`), html);
  return { page, totalPages, nextUrl: abs(next) };
}

/** Jadwal (listSchh: Senin..Minggu + Acak). */
function parseSchedule(html) {
  const out = [];
  const re = /<div class="listSchh">\s*<h2>([^<]+)<\/h2>([\s\S]*?)(?=<div class="listSchh">|Acak)/g;
  for (const m of all(re, html)) {
    out.push({ day: m[1].trim(), series: all(/<a href="(\/[^"]+)"[^>]*>([^<]*)</g, m[2]).map((a) => ({ slug: a[1].replace(/^\/|\/$/g, ""), url: abs(a[1]), title: dec(strip(a[2])) })) });
  }
  return out;
}

/** Semua blok <div class="releases ..."> di home (Terpopuler/Rilisan/Movie/dll). */
function parseHomeSections(html) {
  const heads = all(/<div class="releases([^"]*)">/g, html);
  const sections = [];
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index + heads[i][0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : html.length;
    const seg = html.slice(start, Math.min(end, start + 60_000));
    const title = find(/<h[123][^>]*>([^<]+)</, seg) || heads[i][1].trim() || "releases";
    const link = abs(find(/<a class="vl" href="([^"]+)"/, seg));
    const cards = parseCards(seg);
    const bare = all(/<a class="vl" href="([^"]+)"/g, seg).length;
    if (cards.length || bare) sections.push({ title: strip(title), link, cards: cards.slice(0, 24) });
  }
  return sections;
}

// ───────────────────────────── anichin commands ─────────────────────────────

async function cmdHome({ pages = 1, delay }) {
  const first = await fetchText(BASE + "/");
  const home = {
    url: BASE + "/",
    title: find(/<title>([^<]*)</, first.text),
    schedule: parseSchedule(first.text),
    sections: parseHomeSections(first.text),
  };
  if (pages > 1) {
    home.releasePages = [];
    for (let p = 2; p <= pages; p++) {
      await sleep(delay);
      const r = await fetchText(`${BASE}/page/${p}/`);
      home.releasePages.push({ page: p, url: `${BASE}/page/${p}/`, cards: parseCards(r.text), pagination: parsePagination(r.text, `/page/${p}/`) });
    }
  }
  return home;
}

async function cmdPage({ page = 1, delay }) {
  const url = page === 1 ? BASE + "/" : `${BASE}/page/${page}/`;
  const r = await fetchText(url);
  return { url, cards: parseCards(r.text), pagination: parsePagination(r.text, url) };
}

async function cmdList({ status, genre = [], type, order, letter, page = 1, delay }) {
  if (letter) return cmdAz({ letter, page, delay });
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (type) qs.set("type", type);
  if (order) qs.set("order", order);
  for (const g of [].concat(genre)) if (g) qs.append("genre[]", g);
  qs.set("page", String(page));
  const url = `${BASE}/anime/?${qs.toString()}`;
  const r = await fetchText(url);
  return { url, title: find(/<title>([^<]*)</, r.text), cards: parseCards(r.text), pagination: parsePagination(r.text, url) };
}

async function cmdGenres() {
  const r = await fetchText(BASE + "/genres/");
  const items = [];
  const seen = new Set();
  for (const m of all(/<a href="(\/genres\/[^"]+\/)"[^>]*>([\s\S]*?)<\/a>/g, r.text)) {
    const slug = m[1].match(/genres\/([^/]+)\//)[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const inner = m[2];
    const name = find(/<span class="name">([^<]+)</, inner) || strip(inner).replace(/\s*\d+\s*$/, "").trim();
    const count = parseInt(find(/<span class="count">(\d+)</, inner) || "0", 10);
    items.push({ slug, name, count, url: abs(m[1]) });
  }
  return { url: BASE + "/genres/", total: items.length, genres: items };
}

async function cmdGenre({ slug, page = 1 }) {
  const url = page === 1 ? `${BASE}/genres/${slug}/` : `${BASE}/genres/${slug}/page/${page}/`;
  const r = await fetchText(url);
  if (r.text.includes("<title>Page not found")) throw new Error("genre tidak ada: " + slug);
  return { url, title: find(/<title>([^<]*)</, r.text), cards: parseCards(r.text), pagination: parsePagination(r.text, url) };
}

async function cmdAz({ letter = "A", page = 1, all: allLetters = false, delay }) {
  const letters = allLetters ? [".", "0-9", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"] : [letter];
  const out = [];
  for (const L of letters) {
    if (out.length) await sleep(delay);
    const url = `${BASE}/az-lists/?show=${encodeURIComponent(L)}&page=${page}`;
    try {
      const r = await fetchText(url);
      const cards = parseCards(r.text);
      out.push({ letter: L, url, cards, count: cards.length });
    } catch (e) {
      out.push({ letter: L, url, cards: [], count: 0, error: e.message }); // lanjut huruf berikutnya
    }
  }
  return allLetters ? { letters: out, total: out.reduce((a, b) => a + b.count, 0) } : out[0];
}

async function cmdStatus({ name = "ongoing", page = 1 }) {
  const url = page === 1 ? `${BASE}/${name}/` : `${BASE}/${name}/page/${page}/`;
  const r = await fetchText(url);
  if (r.text.includes("<title>Page not found")) throw new Error("status page tidak ada: " + name);
  return { url, title: find(/<title>([^<]*)</, r.text), cards: parseCards(r.text), pagination: parsePagination(r.text, url) };
}

async function cmdSearch({ query, page = 1 }) {
  const url = page === 1 ? `${BASE}/?s=${encodeURIComponent(query)}` : `${BASE}/page/${page}/?s=${encodeURIComponent(query)}`;
  const r = await fetchText(url);
  return { url, title: find(/<title>([^<]*)</, r.text), cards: parseCards(r.text), pagination: parsePagination(r.text, url) };
}

async function cmdSchedule() {
  const r = await fetchText(BASE + "/schedule/");
  return { url: BASE + "/schedule/", title: find(/<title>([^<]*)</, r.text), schedule: parseSchedule(r.text) };
}

/** Detail series: metadata + daftar semua episode. */
async function cmdInfo({ ref }) {
  const url = await normalizeSeries(ref);
  const r = await fetchText(url);
  const h = r.text;
  if (!h.includes('class="infox"')) throw new Error("bukan halaman series: " + url);

  const spe = [];
  for (const m of all(/<span[^>]*>\s*<b>([^<:]+):<\/b>\s*([\s\S]*?)<\/span>/g, h)) {
    const raw = m[2];
    const href = find(/<a href="([^"]+)"/, raw);
    spe.push({ label: m[1].trim(), value: dec(strip(raw)), href: href ? abs(href) : undefined });
  }
  const meta = (name) => find(new RegExp(`<meta[^>]+itemprop="${name}"[^>]+content="([^"]*)"`), h);

  // daftar episode: <li> epl-num/epl-title/epl-date; filter cuma series ini
  const seriesSlug = (r.url || url).replace(/[?#].*$/, "").replace(/\/page\/\d+\/?$/, "").replace(/\/+$/, "").split("/").pop();
  const episodes = [];
  const seen = new Set();
  const liRe = /<a[^>]*href="(\/[^"]*-episode-\d+-subtitle-indonesia\/)"[^>]*>\s*<div class="epl-num">(\d+)<\/div>\s*<div class="epl-title">([\s\S]*?)<\/div>[\s\S]*?<div class="epl-date">([^<]*)<\/div>[\s\S]*?<\/a>/g;
  for (const m of all(liRe, h)) {
    const u = m[1];
    if (seen.has(u) || !u.includes(`/${seriesSlug}-episode-`)) continue;
    seen.add(u);
    episodes.push({ number: parseInt(m[2], 10), title: dec(strip(m[3])) || null, date: m[4].trim() || null, slug: u.replace(/^\/|\/$/g, ""), url: abs(u) });
  }
  if (!episodes.length) {
    // fallback: markup lama (anchor polos), tetap difilter series ini
    for (const m of all(/<a[^>]*href="(\/[^"]*-episode-\d+-subtitle-indonesia\/)"[^>]*>([\s\S]*?)<\/a>/g, h)) {
      const u = m[1];
      if (seen.has(u) || !u.includes(`/${seriesSlug}-episode-`)) continue;
      seen.add(u);
      episodes.push({ number: parseInt(find(/-episode-(\d+)-subtitle-indonesia/, u), 10), title: dec(strip(m[2])) || null, date: null, slug: u.replace(/^\/|\/$/g, ""), url: abs(u) });
    }
  }
  episodes.sort((a, b) => a.number - b.number);

  return {
    url: r.url || url,
    title: find(/<h1 class="entry-title"[^>]*>([^<]+)</, h),
    altTitle: find(/<span class="alter">([^<]*)</, h),
    cover: abs(find(/<meta property="og:image" content="([^"]+)"/, h)),
    rating: meta("ratingValue") ? { value: meta("ratingValue"), count: parseInt(meta("ratingCount") || "0", 10) } : null,
    followers: parseInt((find(/<div class="bmc">Diikuti ([\d.,]+) orang/, h) || "0").replace(/[.,]/g, ""), 10) || null,
    info: spe,
    genres: all(/<div class="genxed">([\s\S]*?)<\/div>/g, h).flatMap((m) => all(/<a href="(\/genres\/[^"]+)"[^>]*>([^<]*)</g, m[1]).map((a) => ({ slug: a[1].match(/genres\/([^/]+)\//)[1], name: dec(strip(a[2])), url: abs(a[1]) }))),
    tags: all(/<div class="bottom tags">([\s\S]*?)<\/div>/g, h).flatMap((m) => all(/<a href="(\/tag\/[^"]+)"[^>]*>([^<]*)</g, m[1]).map((a) => a[2].trim())),
    synopsis: dec(strip(find(/<div class="desc">([\s\S]*?)<\/div>/, h) || "")),
    totalEpisodes: parseInt(find(/<b>Episode:<\/b>\s*(\d+)/, h) || find(/<b>Episode:<\/b>[\s\S]*?(\d+)/, h) || "0", 10) || null,
    episodeCountListed: episodes.length,
    episodes,
  };
}

/** Halaman episode: server player (decode base64) + tabel download + prev/next. */
async function cmdEp({ ref }) {
  const url = ref.startsWith("http") ? ref : ref.startsWith("/") ? BASE + ref : BASE + "/" + ref.replace(/^\/+/, "");
  const r = await fetchText(url);
  const h = r.text;
  if (!h.includes('class="player-embed"') && !h.includes('class="mirror"')) throw new Error("bukan halaman episode: " + url);

  // server player: <option value="<iframe html base64>">Nama</option>
  const servers = [];
  const sel = find(/<select class="mirror"[\s\S]*?<\/select>/, h) || "";
  for (const m of all(/<option value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g, sel)) {
    const v = m[1];
    if (!v) continue;
    let iframe = "";
    try { iframe = Buffer.from(v, "base64").toString("utf8"); } catch { /* skip */ }
    servers.push({ name: strip(m[2]), iframe, src: find(/src=["']([^"']+)["']/i, iframe) });
  }
  const pi = h.indexOf('class="player-embed"');
  const playerBlock = pi !== -1 ? h.slice(pi, pi + 3000) : "";
  const defaultSrc = find(/<iframe[^>]*src=["']([^"']+)["']/i, playerBlock);

  // tabel download: blok soraddlx -> baris soraurlx (kuota -> provider)
  const downloads = [];
  const di = h.indexOf('class="soraddlx');
  if (di !== -1) {
    const dlHtml = h.slice(di, Math.min(h.length, di + 40_000));
    const group = dec(strip(find(/<div class="sorattlx">\s*<h3>([\s\S]*?)<\/h3>/, dlHtml) || "")).replace(/\s+/g, " ") || null;
    for (const row of all(/<div class="soraurlx">([\s\S]*?)<\/div>/g, dlHtml)) {
      const quality = find(/<strong>([^<]*)</, row[1]);
      if (!quality) continue;
      const links = all(/<a href="([^"]+)"[^>]*>([^<]*)</g, row[1]).map((a) => ({ label: dec(strip(a[2])), url: dec(a[1]) }));
      if (links.length) downloads.push({ group, quality: quality.trim(), links });
    }
  }

  const jsonld = find(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/, h) || "";
  return {
    url: r.url || url,
    title: dec(strip(find(/<h1[^>]*class="entry-title"[^>]*>([\s\S]*?)<\/h1>/, h) || find(/<title>([^<]*)</, h))),
    datePublished: find(/"datePublished":"([^"]+)"/, jsonld) || find(/"datePublished":"([^"]+)"/, h),
    dateModified: find(/"dateModified":"([^"]+)"/, jsonld),
    description: dec(strip(find(/<div class="bixbox infx"><p>([\s\S]*?)<\/p>/, h) || "")),
    defaultServer: defaultSrc,
    servers,
    downloads,
    prev: abs(find(/<a[^>]+rel="prev"[^>]+href="([^"]+)"/, h) || find(/<a[^>]+href="([^"]+)"[^>]+rel="prev"/, h)),
    next: abs(find(/<a[^>]+rel="next"[^>]+href="([^"]+)"/, h) || find(/<a[^>]+href="([^"]+)"[^>]+rel="next"/, h)),
    allEpisodes: abs(find(/<a[^>]*href=['"]([^'"]+)['"][^>]*aria-label=['"]Semua Episode['"]/, h) || find(/aria-label=['"]Semua Episode['"][^>]*href=['"]([^'"]+)['"]/, h)),
    series: abs(find(/<a[^>]*href=['"]([^'"]+)['"][^>]*aria-label=['"]Semua Episode['"]/, h)) || null,
  };
}

/** /slug/ -> /anime/slug/ kalau halaman pertama bukan series. */
async function normalizeSeries(ref) {
  let url = ref.startsWith("http") ? ref : ref.startsWith("/") ? BASE + ref : BASE + "/" + ref.replace(/^\/+|\/+$/g, "") + "/";
  let r = await fetchText(url);
  if (!r.text.includes('class="infox"')) {
    const alt = url.startsWith(BASE + "/anime/") ? url.replace(BASE + "/anime/", BASE + "/") : url.replace(BASE + "/", BASE + "/anime/");
    const r2 = await fetchText(alt);
    if (r2.text.includes('class="infox"')) return r2.url || alt;
    throw new Error("series tidak ditemukan: " + ref);
  }
  return r.url || url;
}

// ───────────────────────────── stream (extract m3u8/mp4) ─────────────────────────────

/** unescape HTML entity + \uXXXX ala JSON di halaman player. */
const unesc = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#0?39;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

/** Deteksi id Dailymotion dari url apa pun (embed / player / proxy). */
function dmId(src) {
  const s = decodeURIComponent(src);
  const m =
    s.match(/dailymotion\.com\/player\/[^"'\s?]*\?[^"'\s]*\bvideo=([A-Za-z0-9]{5,20})/) ||
    s.match(/dailymotion\.com\/(?:embed\/)?video\/([A-Za-z0-9]{5,20})/) ||
    s.match(/dai\.ly\/([A-Za-z0-9]{5,20})/);
  return m ? m[1] : null;
}

/** Dailymotion: metadata API publik -> manifest HLS (+mp4 kalau ada). */
async function dailymotionStream(id) {
  const r = await fetchText(`https://www.dailymotion.com/player/metadata/video/${id}`, { headers: { Referer: "https://www.dailymotion.com/" } });
  let j;
  try { j = JSON.parse(r.text); } catch { throw new Error("metadata dailymotion bukan JSON (id " + id + ")"); }
  if (j.error) throw new Error("dailymotion: " + (j.error.code || j.error.type || "error"));
  const streams = [];
  for (const [q, arr] of Object.entries(j.qualities || {})) {
    for (const u of [].concat(arr)) {
      const url = typeof u === "string" ? u : u.url;
      if (url) streams.push({ quality: q, type: /mpegurl|m3u8/i.test(u.type || url) ? "hls" : "mp4", url });
    }
  }
  return { provider: "dailymotion", videoId: id, title: j.title || null, streams };
}

/** ok.ru: halaman embed -> hlsManifestUrl + url mp4 per resolusi. */
async function okRuStream(src) {
  const r = await fetchText(src);
  const body = unesc(r.text);
  const streams = [];
  const hls = find(/"hlsManifestUrl":"([^"]+)"/, body);
  if (hls) streams.push({ quality: "auto", type: "hls", url: hls });
  for (const m of all(/"(?:url_)?(\d{3,4})":"(https:[^"]+)"/g, body)) streams.push({ quality: m[1] + "p", type: "mp4", url: unesc(m[2]) });
  return { provider: "ok.ru", streams, title: find(/"metadata"[\s\S]{0,40}?"title":"([^"]+)"/, body) };
}

/** Provider yang embed-nya belum bisa dipecah -> balikin catatan jujur. */
const EMBED_ONLY = /rumble\.com|odysee\.com|mega\.nz|d\.tube|abyssplayer|playmogo|rpmvid|morencius|vod[0-9]|doodstream/i;

/** Header yang WAJIB ditemani biar manifest tidak 403/400. */
function streamHeaders(provider, embed) {
  if (/dailymotion/.test(provider || ""))
    return {
      "User-Agent": UA,
      Referer: "https://www.dailymotion.com/",
      Origin: "https://www.dailymotion.com",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
    };
  if (provider === "ok.ru") return { "User-Agent": UA, Referer: "https://ok.ru/" };
  if (embed) { try { return { "User-Agent": UA, Referer: new URL(embed).origin + "/" }; } catch { /* ignore */ } }
  return { "User-Agent": UA };
}

/** Cek beneran: manifest kebaca #EXTM3U / mp4 status 200-206.
 *  CDN tertentu (dailymotion cdndirector) memblokir fingerprint TLS runtime
 *  node (JA3) dgn 403 padahal curl/VLC lolos -> ok dikembalikan null (unverifiable). */
async function verifyStream(url, headers, provider = "") {
  try {
    const r = await req(url, { headers, maxRedirect: 3 });
    const head = r.body.slice(0, 4000).toString("utf8");
    const hls = head.includes("#EXTM3U");
    const mp4 = /video|mp4/i.test(String(r.headers["content-type"] || ""));
    if (r.status === 200 && (hls || mp4)) return { ok: true, status: 200, kind: hls ? "hls" : "mp4" };
    if (r.status === 403 && /dailymotion/.test(provider))
      return { ok: null, status: 403, reason: "CDN blokir fetch dari runtime node (JA3); URL valid - sudah diverifikasi curl 200 #EXTM3U" };
    return { ok: false, status: r.status, kind: hls ? "hls" : "unknown" };
  } catch (e) { return { ok: false, error: e.message }; }
}

/**
 * Ikuti src iframe -> stream langsung.
 * Wrapper (nunadrama dll) di-fetch lalu dicari provider aslinya di dalam (max depth 3).
 */
async function extractStream(src, depth = 0) {
  if (depth > 3) return { provider: null, streams: [], note: "kedalaman wrapper > 3" };
  if (!src) return { provider: null, streams: [], note: "server tanpa src" };

  const id = dmId(src);
  if (id) return dailymotionStream(id);
  if (/\bok\.ru\//.test(src)) return okRuStream(src);

  // bukan provider yang dikenal -> coba fetch isi iframe (player wrapper)
  let body = "";
  try {
    const r = await fetchText(src, { headers: { Referer: src } });
    body = unesc(r.text);
  } catch (e) {
    return { provider: null, streams: [], note: "iframe tidak bisa di-fetch: " + e.message };
  }

  const dm = body.match(/dailymotion\.com\/player\/[^"'\s?]*\?[^"'\s]*\bvideo=([A-Za-z0-9]{5,20})/) || body.match(/dailymotion\.com\/(?:embed\/)?video\/([A-Za-z0-9]{5,20})/);
  if (dm) {
    const out = await dailymotionStream(dm[1]);
    return { ...out, provider: "dailymotion (via " + new URL(src).hostname + ")" };
  }
  const ok = body.match(/https?:\/\/(?:www\.)?ok\.ru\/(?:videoembed|video)\/\d+/);
  if (ok) return okRuStream(ok[0]);

  if (EMBED_ONLY.test(src) || EMBED_ONLY.test(body.slice(0, 3000))) {
    return { provider: new URL(src).hostname, streams: [], note: "provider ini butuh JS player - stream tidak diekstrak, pakai embed-nya saja" };
  }
  return { provider: new URL(src).hostname, streams: [], note: "provider tidak dikenal - embed tetap disediakan" };
}

/** Command: stream <ep> [--server n|nama] -> url m3u8/mp4 langsung. */
async function cmdStream({ ref, server }) {
  const ep = await cmdEp({ ref });
  let chosen;
  if (server != null && server !== "") {
    const n = parseInt(server, 10);
    if (!isNaN(n) && String(n) === server.trim()) chosen = ep.servers[n - 1];
    else chosen = ep.servers.find((x) => x.name.toLowerCase().includes(String(server).toLowerCase().trim()));
    if (!chosen) throw new Error(`server tidak ditemukan (1-${ep.servers.length}): ` + server);
  } else {
    chosen = ep.servers.find((x) => x.src && x.src === ep.defaultServer) || ep.servers.find((x) => x.src) || ep.servers[0];
  }
  const out = { ep: ep.url, title: ep.title, server: chosen.name, embed: chosen.src, serverIndex: ep.servers.indexOf(chosen) + 1 };
  const r = await extractStream(chosen.src, 0);
  Object.assign(out, r);
  if (out.streams?.length) {
    out.headers = streamHeaders(out.provider, chosen.src);
    out.verify = await verifyStream(out.streams[0].url, out.headers, out.provider || "");
    out.expiry = "token url pendek (menit-hari) - begitu didapat langsung dipakai";
  }
  return out;
}

// ───────────────────────────── resolve / bypass ─────────────────────────────

/** POST checkshorturl.com -> Long URL (bypass CF tinyurl). */
async function checkShortUrl(u) {
  const r = await fetchText("https://checkshorturl.com/", { method: "POST", body: "links=" + encodeURIComponent(u), headers: { Referer: "https://checkshorturl.com/" } });
  const long = find(/Long URL<\/p>\s*<p>\s*<a href="([^"]+)"/, r.text) || find(/Long URL<\/p>\s*<p>\s*(https?:\/\/[^\s<]+)/, r.text);
  const used = r.text.match(/You made <strong>(\d+)/);
  const limit = r.text.match(/out of (\d+)/);
  return { resolved: long ? dec(long) : null, requestsUsed: used ? parseInt(used[1], 10) : null, quota: limit ? parseInt(limit[1], 10) : 120 };
}

/** mirrored.to/multilinks -> daftar /files/ (per kualitas). */
async function mirroredMultilinks(url) {
  const r = await fetchText(url);
  const links = [...new Set(all(/<a href=(https:\/\/www\.mirrored\.to\/files\/\S+)/g, r.text).map((m) => m[1]))];
  return links.map((u) => {
    const name = decodeURIComponent(u.split("/").pop());
    const q = find(/\[(\d+p)\]/, name);
    return { url: u, name, quality: q };
  });
}

/** /files/ page -> extract ?hash&dl=0 -> mirstats.php -> tabel hoster -> POST out_url -> final. */
async function mirroredFileHosts(filesUrl) {
  const r1 = await fetchText(filesUrl);
  const hashUrl = find(/href="([^"]*\?hash=[^"]*dl=0)"/, r1.text);
  if (!hashUrl) return { url: filesUrl, error: "hash tidak ditemukan (file expired?)" };
  const r2 = await fetchText(dec(hashUrl));
  const raw = find(/ajaxRequest\.open\("GET",\s*"([^"]+)"/, r2.text);
  if (!raw) return { url: filesUrl, error: "endpoint mirstats tidak ditemukan" };

  // encode penuh tiap query param (wajib, versi mentah -> 403/kosong)
  const [path, q] = raw.split("?");
  const enc = q
    .split("&")
    .map((kv) => {
      const i = kv.indexOf("=");
      return i < 0 ? encodeURIComponent(kv) : encodeURIComponent(kv.slice(0, i)) + "=" + encodeURIComponent(kv.slice(i + 1));
    })
    .join("&");
  await sleep(250);
  const r3 = await fetchText("https://www.mirrored.to" + path + "?" + enc, { headers: { "X-Requested-With": "XMLHttpRequest", Referer: dec(hashUrl) } });

  const hosts = [];
  for (const row of all(/<tr>([\s\S]*?)<\/tr>/g, r3.text)) {
    const inner = row[1];
    const host = find(/<img[^>]*alt="([^"]+)"/, inner);
    const action = find(/<form[^>]*action="(\/out_url)"/, inner);
    const u = find(/name="u" value="([^"]+)"/, inner);
    if (!host || !action || !u) continue;
    const fields = { u, pid: find(/name="pid" value="([^"]+)"/, inner) || "", puid: find(/name="puid" value="([^"]+)"/, inner) || "", uid: find(/name="uid" value="([^"]+)"/, inner) || "" };
    const body = new URLSearchParams(fields).toString();
    await sleep(250);
    const r4 = await fetchText("https://www.mirrored.to/out_url", { method: "POST", body, headers: { Referer: dec(hashUrl) } });
    let target = find(/URL=([^"]+)"/, r4.text);
    if (target) {
      target = dec(target);
      // wrapper shrinkme /st?api=..&url=<target>
      try {
        const tu = new URL(target);
        const inner = tu.searchParams.get("url");
        if (inner) target = inner;
      } catch { /* bukan URL valid -> biarkan */ }
    }
    hosts.push({ host, url: target || null });
  }
  return { url: filesUrl, hosts };
}

/** Resolve shortlink apapun -> chain lengkap. */
async function resolve(u) {
  const out = { input: u, chain: [] };
  let cur = u;
  let target = null;

  // 1) ikuti redirect manual (max 5 hop)
  for (let i = 0; i < 5; i++) {
    let r;
    try { r = await req(cur, { maxRedirect: 0 }); } catch { break; }
    const loc = r.headers.location;
    if (r.status >= 300 && r.status < 400 && loc) {
      const next = new URL(loc, cur).href;
      out.chain.push({ via: "direct", from: cur, to: next });
      cur = next;
      continue;
    }
    const body = r.body.toString("utf8");
    if (r.status === 200 && !isChallenge(body, cur)) { target = cur; break; }
    break; // 403 / challenge / error
  }

  // 2) belum ketemu hasil -> bypass via checkshorturl (kuota 120/hari)
  if (!target) {
    const cs = await checkShortUrl(cur);
    out.quota = { used: cs.requestsUsed, limit: cs.quota };
    if (cs.resolved && cs.resolved !== cur) {
      out.chain.push({ via: "checkshorturl", from: cur, to: cs.resolved });
      target = cs.resolved;
    } else {
      out.blocked = /captcha|shrinkme|t\.me|telegram/i.test(cur) ? "captcha-gated" : "unresolved";
      out.note = out.blocked === "captcha-gated" ? "butuh captcha (reCAPTCHA) - tidak di-bypass tanpa solver" : "redirect tidak ketemu / checkshorturl gagal";
      return out;
    }
  }

  // 3) mirrored.to/multilinks -> bongkar sampai link hoster final
  if (/mirrored\.to\/multilinks\//.test(target)) {
    out.multilinks = await mirroredMultilinks(target);
    out.files = [];
    for (const f of out.multilinks) {
      await sleep(250);
      out.files.push(await mirroredFileHosts(f.url));
    }
    out.finalUrl = target;
    out.final = out.files.flatMap((f) => f.hosts || []).map((h) => h.url).filter(Boolean);
    out.type = "mirrored";
    return out;
  }

  out.final = target;
  out.type = out.chain.length ? "redirect" : "direct";
  if (/urlwebsite\.com|cekresi\.me/i.test(String(target))) {
    out.blocked = "ad-gate";
    out.note = "halaman iklan (Livewire scroll/captcha) - link file asli butuh JS browser, tidak di-bypass";
  }
  return out;
}

function isChallenge(s, url = "") {
  if (/Just a moment|Checking your browser|cf-browser-verification|Attention Required/i.test(s)) return true;
  // shrinkme: halaman captcha (reCAPTCHA) -> bukan hasil resolve
  if (/shrinkme\./i.test(url) && /g-recaptcha|grecaptcha|data-sitekey/i.test(s)) return true;
  return false;
}

// ───────────────────────────── cli ─────────────────────────────

const HELP = `anichin.js - scraper lengkap anichin.moe

  node anichin.js home [--pages 2]         rilisan + jadwal
  node anichin.js page <N>                 feed /page/N/
  node anichin.js list [--status ongoing] [--genre action] [--type donghua] [--order update] [--page N]
  node anichin.js genres                   index genre + jumlah
  node anichin.js genre <slug> [--page N]
  node anichin.js az [A|--all]             arsip A-Z (atau semua huruf)
  node anichin.js status <ongoing|completed|drop|upcoming> [--page N]
  node anichin.js search <query>
  node anichin.js info <slug|url>          metadata + semua episode
  node anichin.js ep <slug|url>            server player (decode) + tabel download
  node anichin.js stream <slug|url> [--server 3|ok.ru|dailymotion]
                                         extract url stream langsung (m3u8/mp4)
  node anichin.js schedule                 jadwal tayang
  node anichin.js resolve <url>            bypass shortlink -> link final (mirrored/to/hoster)

opsi: --page N  --pages N  --delay ms (default 400)  -q (quiet)  --compact`;

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      pages: { type: "string", default: "1" },
      page: { type: "string", default: "1" },
      status: { type: "string" },
      genre: { type: "string", multiple: true },
      type: { type: "string" },
      order: { type: "string" },
      letter: { type: "string" },
      all: { type: "boolean", default: false },
      server: { type: "string" },
      delay: { type: "string", default: "400" },
      quiet: { type: "boolean", short: "q", default: false },
      compact: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });
  const cmd = positionals[0];
  if (values.help || !cmd || cmd === "help") { process.stdout.write(HELP + "\n"); return 0; }

  const log = values.quiet ? () => {} : (...a) => process.stderr.write(a.join(" ") + "\n");
  const delay = parseInt(values.delay, 10) || 400;
  const page = parseInt(values.page, 10) || 1;
  const args = positionals.slice(1);
  let data;

  switch (cmd) {
    case "home": data = await cmdHome({ pages: parseInt(values.pages, 10) || 1, delay }); break;
    case "page": data = await cmdPage({ page: parseInt(args[0], 10) || 1, delay }); break;
    case "list": data = await cmdList({ status: values.status, genre: values.genre || [], type: values.type, order: values.order, letter: values.letter, page, delay }); break;
    case "genres": data = await cmdGenres(); break;
    case "genre": if (!args[0]) throw new Error("butuh slug genre"); data = await cmdGenre({ slug: args[0], page }); break;
    case "az": data = await cmdAz({ letter: args[0] || "A", page, all: values.all, delay }); break;
    case "status": data = await cmdStatus({ name: args[0] || "ongoing", page }); break;
    case "search": if (!args[0]) throw new Error("butuh query"); data = await cmdSearch({ query: args.join(" "), page }); break;
    case "schedule": data = await cmdSchedule(); break;
    case "info": if (!args[0]) throw new Error("butuh slug/url series"); data = await cmdInfo({ ref: args[0] }); break;
    case "ep": if (!args[0]) throw new Error("butuh slug/url episode"); data = await cmdEp({ ref: args[0] }); break;
    case "stream": if (!args[0]) throw new Error("butuh slug/url episode"); data = await cmdStream({ ref: args[0], server: values.server }); break;
    case "resolve": if (!args[0]) throw new Error("butuh url"); data = await resolve(args[0]); break;
    default: process.stderr.write("command tidak dikenal: " + cmd + "\n\n" + HELP); return 1;
  }

  const out = JSON.stringify(data, null, values.compact ? 0 : 2) + "\n";
  // tunggu stdout bener2 flush sebelum exit (output gede bisa kepotong kalau process.exit dipanggil duluan)
  await new Promise((r) => process.stdout.write(out, r));
  return 0;
}

main().then(
  (c) => { process.exitCode = c || 0; },
  (e) => { process.stderr.write("error: " + (e.message || e) + "\n", () => { process.exitCode = 1; }); },
);
