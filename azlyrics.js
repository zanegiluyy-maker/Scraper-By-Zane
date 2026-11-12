/**
 * Name : AZLyrics Scraper (www.azlyrics.com)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://www.azlyrics.com
 * Type : Scraper
 * Function : cari lagu + ambil lirik (find, lyrics, artist, index, artist-search)
 * Note : error fix sendiri.
 *        Zero dependency npm — Node built-in + curl.
 *        Auto proxy rotation (azlyrics_proxies.txt + cache) kalau IP diblokir.
 *        Output: JSON ke stdout saja.
 *        credit: Zane.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const PROXY_FILE = path.join(__dirname, "azlyrics_proxies.txt");
const PROXY_CACHE = path.join(__dirname, ".cache", "azlyrics_proxy.txt");

const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const BASE = "https://www.azlyrics.com";

function out(j) { process.stdout.write(JSON.stringify(j, null, 2) + "\n", () => process.exit(0)); }
function die(msg) { process.stderr.write(`azlyrics.js: ${msg}\n`); process.exit(1); }

function http(url, opts = {}) {
  const { timeout = 30, headers = [], proxy = null } = opts;
  const argv = ["-s", "-m", String(timeout), "-L", "--max-redirs", "5"];
  if (proxy) argv.push("-x", proxy);
  argv.push("-A", UA, "-H", "Accept: text/html,application/json,*/*;q=0.8", "-H", "Accept-Language: id-ID,id;q=0.9,en;q=0.8");
  for (const h of headers) argv.push("-H", h);
  argv.push(url);
  let raw;
  try { raw = execFileSync("curl", argv, { maxBuffer: 20 * 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { return { code: 0, text: "", err: String((e.stderr || e.message || e) || "").slice(0, 120) }; }
  return { code: 200, text: raw, err: null };
}
function loadProxies() {
  try { return fs.readFileSync(PROXY_FILE, "utf8").trim().split(/\r?\n/).filter(Boolean); } catch { return []; }
}
function loadCachedProxy() {
  try { return fs.readFileSync(PROXY_CACHE, "utf8").trim() || null; } catch { return null; }
}
function saveCachedProxy(p) {
  try { fs.mkdirSync(path.join(__dirname, ".cache"), { recursive: true }); fs.writeFileSync(PROXY_CACHE, p); } catch { }
}
function isBlocked(text) {
  return /Access denied/i.test(text) || /b\.azlyrics\.com/i.test(text) || /request for access/i.test(text);
}
let WORKING_PROXY = loadCachedProxy();
function fetchSmart(url, opts = {}) {
  const forced = opts.proxy || GLOBAL_PROXY || null;
  let proxies;
  if (forced) proxies = [forced];
  else if (WORKING_PROXY) proxies = [WORKING_PROXY, null, ...loadProxies().filter((p) => p !== WORKING_PROXY)].slice(0, 6);
  else proxies = [null, ...loadProxies()].slice(0, 6);
  const tried = [];
  for (const proxy of proxies) {
    const r = http(url, { ...opts, proxy, timeout: proxy ? 8 : (opts.timeout || 30) });
    tried.push(proxy || "direct");
    if (r.code === 0) continue;
    if (isBlocked(r.text)) continue;
    if (proxy) { WORKING_PROXY = proxy; saveCachedProxy(proxy); }
    return { ...r, proxy: proxy || "direct", tried };
  }
  return { code: 403, text: "", err: "Semua IP/proxy diblokir AZLyrics (Access denied). Tambah proxy baru di azlyrics_proxies.txt.", tried };
}

/* ---------------- parsers ---------------- */
function stripTags(s) { return String(s || "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim(); }

function parseLyrics(html) {
  const titleM = html.match(/<div class="div-share">\s*<h1>([\s\S]*?)<\/h1>/i);
  const title = titleM ? stripTags(titleM[1]).replace(/\s*lyrics\s*$/i, "") : "";
  const artistM = html.match(/<div class="lyricsh">[\s\S]*?<a[^>]*href="[^"]*"[^>]*>\s*<b>([\s\S]*?)<\/b>/i);
  const artist = artistM ? stripTags(artistM[1]).replace(/\s*Lyrics\s*$/i, "") : "";
  const artistUrlM = html.match(/<div class="lyricsh">[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>/i);
  // lyrics body: div setelah komentar lisensi
  let lyrics = "";
  const cidx = html.indexOf("Usage of azlyrics.com content");
  if (cidx > 0) {
    const after = html.slice(cidx);
    const end = after.indexOf("-->");
    const body = end >= 0 ? after.slice(end + 3) : after;
    const closeDiv = body.indexOf("</div>");
    const lyricsHtml = closeDiv >= 0 ? body.slice(0, closeDiv) : body;
    lyrics = lyricsHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\r/g, "").trim();
  }
  if (!lyrics) {
    const b = html.match(/<b>[\s\S]*?<\/b>\s*<br>\s*<br>\s*<div[^>]*>([\s\S]*?)<\/div>/i);
    if (b) lyrics = b[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").replace(/\r/g, "").trim();
  }
  return { title, artist, artistUrl: artistUrlM ? artistUrlM[1] : "", lyrics };
}

function parseArtist(html) {
  const titleM = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleM ? stripTags(titleM[1]) : "";
  const albums = [], songs = [];
  let currentAlbum = null;
  const re = /<div id="(\d+)" class="album">([\s\S]*?)(?=<div id="\d+" class="album"|<div class="listalbum-item">|$)|<div class="listalbum-item">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/div>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) {
      const body = m[2];
      const nameM = body.match(/<b>([\s\S]*?)<\/b>/i);
      const yearM = body.match(/\((\d{4})\)/);
      const subM = body.match(/<div class="album-subtitle">([\s\S]*?)<\/div>/i);
      const imgM = body.match(/<img[^>]*src="([^"]+)"[^>]*>/i);
      currentAlbum = {
        id: m[1],
        name: nameM ? stripTags(nameM[1]).replace(/^["\u201c]+|["\u201d]+$/g, "") : "",
        year: yearM ? yearM[1] : "",
        subtitle: subM ? stripTags(subM[1]) : "",
        cover: imgM ? imgM[1] : ""
      };
      albums.push(currentAlbum);
    } else if (m[3]) {
      songs.push({ title: stripTags(m[4]), url: BASE + m[3], album: currentAlbum ? currentAlbum.name : "", albumYear: currentAlbum ? currentAlbum.year : "" });
    }
  }
  return { title, albums, songs };
}

function parseIndex(html) {
  const artists = [];
  const re = /<a href="([0-9a-z]+\/[^"]+\.html)">([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const name = stripTags(m[2]);
    if (!name) continue;
    artists.push({ name, url: BASE + "/" + m[1] });
  }
  return artists;
}

/* ---------------- commands ---------------- */
async function cmdLyrics(argv) {
  let url;
  if (argv.length >= 2 && /^\d+$/.test(argv[1])) {
    url = `${BASE}/lyrics/${argv[0]}/${argv[1]}.html`;
  } else if (argv.length >= 2) {
    url = `${BASE}/lyrics/${argv[0]}/${argv[1]}.html`;
  } else if (/^https?:\/\//.test(argv[0] || "")) {
    url = argv[0];
  } else if (/\/lyrics\//.test(argv[0] || "")) {
    url = BASE + argv[0];
  } else die("Usage: node azlyrics.js lyrics <url> atau <artist> <song>");
  const r = fetchSmart(url);
  if (r.code !== 200) die(`HTTP ${r.code} untuk ${url}`);
  const p = parseLyrics(r.text);
  if (!p.lyrics) process.exitCode = 1;
  out({ credit: "Zane", url, ...p, found: !!p.lyrics });
}
async function cmdArtist(argv) {
  const target = argv[0];
  if (!target) die("Usage: node azlyrics.js artist <letter/name>  (mis. t/taylorswift.html)");
  const url = /^[0-9a-z]\/[^/]+\.html$/.test(target) ? `${BASE}/${target}` : /^https?:\/\//.test(target) ? target : `${BASE}/${target}.html`;
  const r = fetchSmart(url);
  if (r.code !== 200) die(`HTTP ${r.code} untuk ${url}`);
  const p = parseArtist(r.text);
  out({ credit: "Zane", url, ...p });
}
async function cmdIndex(argv) {
  const letter = argv[0];
  if (!letter) die("Usage: node azlyrics.js index <letter|19>  (mis. t atau 19)");
  const url = `${BASE}/${letter}.html`;
  const r = fetchSmart(url);
  if (r.code !== 200) die(`HTTP ${r.code} untuk ${url}`);
  const artists = parseIndex(r.text);
  out({ credit: "Zane", letter, url, total: artists.length, artists });
}
async function cmdSuggest(argv) {
  const q = argv[0];
  if (!q) die("Usage: node azlyrics.js suggest <query>");
  const r = fetchSmart(`${BASE}/suggest/?q=${encodeURIComponent(q)}`);
  let j = null; try { j = JSON.parse(r.text); } catch { }
  out({ credit: "Zane", query: q, raw: j || r.text });
}
async function cmdSearch(argv) {
  const q = argv.join(" ");
  if (!q) die("Usage: node azlyrics.js search <query>");
  const r = fetchSmart(`${BASE}/search/?q=${encodeURIComponent(q)}`);
  const songs = [];
  const re = /href="([^"]*\/lyrics\/[^"]+)"/gi;
  let m;
  while ((m = re.exec(r.text)) !== null) songs.push(m[1]);
  const artists = parseIndex(r.text);
  out({
    credit: "Zane", query: q,
    note: "Halaman search AZLyrics memuat result via JS/AJAX (tidak ada di HTML). Pakai 'artist-search' untuk cari artis, lalu 'artist' untuk daftar lagu.",
    songs, artists
  });
}
async function cmdArtistSearch(argv) {
  const q = argv.join(" ");
  if (!q) die("Usage: node azlyrics.js artist-search <nama artis>");
  const letter = (q[0] || "").toLowerCase();
  if (!/[a-z]/.test(letter)) die("Query harus diawali huruf.");
  const r = fetchSmart(`${BASE}/${letter}.html`);
  const matches = parseIndex(r.text).filter((a) => a.name.toLowerCase().includes(q.toLowerCase()));
  out({ credit: "Zane", query: q, letter, total: matches.length, artists: matches });
}
async function cmdFind(argv) {
  const q = argv.filter((a) => a !== "--no-lyrics").join(" ");
  if (!q) die("Usage: node azlyrics.js find <query> [--no-lyrics]  (mis. find somebody pleasure aziz hedra)");
  const withLyrics = !argv.includes("--no-lyrics");
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const qLower = q.toLowerCase();
  const candidates = new Map();
  const letters = new Set(words.map((w) => w[0]).filter((c) => /[a-z]/.test(c)));
  for (const letter of letters) {
    const r = fetchSmart(`${BASE}/${letter}.html`);
    for (const a of parseIndex(r.text)) {
      const name = a.name.toLowerCase();
      if (name.includes(qLower) || words.some((w) => name.includes(w))) candidates.set(a.url, a);
    }
  }
  const results = [];
  for (const [url, artist] of candidates) {
    const ar = fetchSmart(url);
    const p = parseArtist(ar.text);
    const artistName = p.title ? p.title.replace(/\s*Lyrics\s*$/i, "") : artist.name;
    for (const s of p.songs) {
      const title = s.title.toLowerCase();
      if (title.includes(qLower) || words.some((w) => title.includes(w))) {
        const entry = { artist: artistName, artistUrl: url, song: s.title, url: s.url, album: s.album, albumYear: s.albumYear };
        if (withLyrics) {
          const lr = fetchSmart(s.url);
          const lp = parseLyrics(lr.text);
          entry.lyrics = lp.lyrics;
          entry.lyricsFound = !!lp.lyrics;
        }
        results.push(entry);
      }
    }
  }
  out({ credit: "Zane", query: q, artistsFound: candidates.size, total: results.length, withLyrics, results });
}
async function cmdHelp() {
  process.stdout.write(`azlyrics.js — AZLyrics scraper [skrep]
Usage:
  node azlyrics.js find <query> [--no-lyrics]  cari lagu + lirik sekaligus
  node azlyrics.js lyrics <artist> <song>      ambil lirik
  node azlyrics.js lyrics <url>                lirik dari URL
  node azlyrics.js artist <letter/name>        disco lengkap
  node azlyrics.js index <letter|19>           indeks artis
  node azlyrics.js artist-search <nama>        cari artis
  node azlyrics.js suggest <query>             autocomplete (terbatas)
  node azlyrics.js search <query>              search (terbatas)
  node azlyrics.js --proxy <url> <command>     paksa proxy
  node azlyrics.js --help

Contoh:
  node azlyrics.js find somebody pleasure aziz hedra
  node azlyrics.js lyrics azizhedra somebodyspleasure
  node azlyrics.js artist t/taylorswift.html

Proxy: auto-rotasi azlyrics_proxies.txt + cache .cache/azlyrics_proxy.txt
kalau AZLyrics blokir IP (Access denied). Tambah proxy baru di file itu.

credit: Zane\n`);
  process.exit(0);
}

/* ---------------- main ---------------- */
let GLOBAL_PROXY = null;
async function main() {
  const rawArgv = process.argv.slice(2);
  const argv = [];
  for (let i = 0; i < rawArgv.length; i++) {
    if (rawArgv[i] === "--proxy" && rawArgv[i + 1]) { GLOBAL_PROXY = rawArgv[i + 1]; i++; }
    else if (rawArgv[i].startsWith("--proxy=")) { GLOBAL_PROXY = rawArgv[i].slice(8); }
    else argv.push(rawArgv[i]);
  }
  if (!argv.length) { cmdHelp(); return; }
  const first = argv[0];
  if (first === "--help" || first === "-h" || first === "help") { cmdHelp(); return; }
  if (first === "lyrics") return cmdLyrics(argv.slice(1));
  if (first === "artist") return cmdArtist(argv.slice(1));
  if (first === "index") return cmdIndex(argv.slice(1));
  if (first === "suggest") return cmdSuggest(argv.slice(1));
  if (first === "artist-search") return cmdArtistSearch(argv.slice(1));
  if (first === "find") return cmdFind(argv.slice(1));
  if (first === "search") return cmdSearch(argv.slice(1));
  die(`command tak dikenal: ${first}`);
}
main().catch((e) => die(`unexpected: ${String(e && e.stack || e).slice(0, 300)}`));