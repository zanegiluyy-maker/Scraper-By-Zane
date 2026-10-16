/**
 * Name : YTMp3 PC Scraper (info, search, convert mp3/mp4)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://ytmp3pc.com (YouTube to MP3/MP4 converter)
 * Type : Scraper
 * Function : Scrape lengkap -> info video, search, convert ke MP3
 *            (320/256/192/128 kbps) atau MP4 (1080/720/480/360) -> direct
 *            download URL + headers yang dibutuhkan.
 * Note : error fix sendiri.
 */

import { request as httpReq } from "node:http";
import { request as httpsReq } from "node:https";
import { parseArgs } from "node:util";

const SITE = "https://ytmp3pc.com";
const API_INFO = "/hP2pPvYldCo";
const API_SEARCH = "/J0GPK30qWps";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TIMEOUT = 30_000;
const CONV_ORIGIN = "https://nodex2.ytzyar.cc";
const MUSIC_BASE = "https://ytzyar.cc";
const BUCKET = "https://bucketx2.ytzyar.cc";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dec = (s) =>
  String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();

/** HTTP native: GET/POST JSON, ikut redirect (max 5), retry, tanpa kompresi. */
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
        headers: { "User-Agent": UA, ...headers },
      },
      (rs) => {
        const { statusCode = 0, headers: rh } = rs;
        if (statusCode >= 300 && statusCode < 400 && rh.location && maxRedirect > 0) {
          rs.resume();
          const next = new URL(rh.location, url).toString();
          return resolve(req(next, { method: "GET", headers, body: undefined, timeout, maxRedirect: maxRedirect - 1 }));
        }
        let data = "";
        let n = 0;
        rs.on("data", (c) => {
          n += c.length;
          if (n > 500_000) {
            rs.resume();
            return resolve({ status: statusCode, headers: rh, body: data, truncated: true });
          }
          data += c;
        });
        rs.on("end", () => resolve({ status: statusCode, headers: rh, body: data }));
      }
    );
    rq.setTimeout(timeout, () => rq.destroy(new Error("timeout")));
    rq.on("error", reject);
    if (body) rq.write(body);
    rq.end();
  });
}

async function reqJson(url, opts = {}) {
  const r = await req(url, opts);
  let j = null;
  try {
    j = JSON.parse(r.body);
  } catch {
    /* not json */
  }
  return { ...r, json: j };
}

/** HEAD untuk cek file download (tanpa download body). */
function head(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const rq = httpsReq(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: "HEAD",
        headers: { "User-Agent": UA, ...headers },
      },
      (rs) => {
        rs.resume();
        resolve({ status: rs.statusCode, headers: rs.headers });
      }
    );
    rq.setTimeout(TIMEOUT, () => rq.destroy(new Error("timeout")));
    rq.on("error", reject);
    rq.end();
  });
}

/** Token generator ytzyar: lowercase videoId -> hash custom -> uint32. */
function token(videoId) {
  const a = String(videoId).toLowerCase();
  let d = 0;
  for (let o = 0; o < a.length; o++) {
    d += a.charCodeAt(o);
    d += d << 10;
    d ^= d >>> 6;
  }
  d += d << 3;
  d ^= d >>> 11;
  d += d << 15;
  return d >>> 0;
}

/** Ekstrak YouTube videoId dari URL / bare id / shorts / youtu.be. */
function extractId(input) {
  const s = String(input).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const pats = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/|youtube\.com\/live\/)([A-Za-z0-9_-]{11})/,
    /[?&]v=([A-Za-z0-9_-]{11})/,
  ];
  for (const p of pats) {
    const m = s.match(p);
    if (m) return m[1];
  }
  throw new Error(`videoId tidak dikenali: ${s}`);
}

/** Headers untuk API converter (ytzyar / bucketx2). */
function convHeaders(extra = {}) {
  return {
    Referer: `${CONV_ORIGIN}/`,
    Origin: CONV_ORIGIN,
    ...extra,
  };
}

/** GET info dasar dari ytmp3pc.com frontend API (retry kalau kena challenge HTML). */
async function siteInfo(videoId, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const r = await reqJson(`${SITE}${API_INFO}?v=${encodeURIComponent(videoId)}`, {
      headers: { Referer: `${SITE}/` },
    });
    if (r.json) return r.json;
    lastErr = new Error(`ytmp3pc info gagal (status ${r.status}): ${r.body.slice(0, 120)}`);
    if (i < tries - 1) await sleep(800 * (i + 1));
  }
  throw lastErr;
}

/** GET list kualitas MP3 dari ytzyar. */
async function musicAvailable(videoId) {
  const tok = token(videoId);
  const r = await reqJson(`${MUSIC_BASE}/music/available-music?v=${encodeURIComponent(videoId)}&token=${tok}`, {
    headers: convHeaders({ "Content-Type": "application/json" }),
  });
  if (!r.json || !r.json.success) {
    const msg = r.json?.message || r.body.slice(0, 120);
    if (r.status === 404 || /Invalid JSON/i.test(msg))
      throw new Error(`video ${videoId} tidak didukung converter (mungkin restricted/region-block): ${msg}`);
    throw new Error(`available-music gagal (status ${r.status}): ${msg}`);
  }
  return { tok, data: r.json.data };
}

/** GET list kualitas MP4 dari bucketx2. */
async function videoAvailable(videoId) {
  const tok = token(videoId);
  const r = await reqJson(`${BUCKET}/video/available-video?v=${encodeURIComponent(videoId)}&token=${tok}`, {
    headers: convHeaders({ "Content-Type": "application/json" }),
  });
  if (!r.json || !r.json.success) {
    const msg = r.json?.message || r.body.slice(0, 120);
    if (r.status === 404 || /Invalid JSON/i.test(msg))
      throw new Error(`video ${videoId} tidak didukung converter (mungkin restricted/region-block): ${msg}`);
    throw new Error(`available-video gagal (status ${r.status}): ${msg}`);
  }
  return { tok, data: r.json.data };
}

/** POST pre-progress (mp3 atau mp4) -> {download_url}|{job_id}|error. */
async function preProgress(kind, videoId, quality, tok) {
  const path = kind === "mp4" ? "/video/pre-progress" : "/music/pre-progress";
  const body = JSON.stringify({ video_id: videoId, quality: String(quality), sig: String(tok) });
  const r = await reqJson(`${BUCKET}${path}`, {
    method: "POST",
    headers: convHeaders({ "Content-Type": "application/json" }),
    body,
  });
  if (!r.json) throw new Error(`pre-progress ${kind} gagal (status ${r.status}): ${r.body.slice(0, 160)}`);
  return r.json;
}

/** Poll progress sampai download_url muncul atau error. */
async function pollProgress(kind, jobId, tok, { tries = 90, delay = 1000 } = {}) {
  const path = kind === "mp4" ? "/video/progress" : "/music/progress";
  for (let i = 0; i < tries; i++) {
    const r = await reqJson(`${BUCKET}${path}?job_id=${encodeURIComponent(jobId)}&token=${tok}`, {
      headers: convHeaders(),
    });
    const j = r.json;
    if (!j) throw new Error(`progress ${kind} gagal (status ${r.status}): ${r.body.slice(0, 160)}`);
    if (j.download_url) return j;
    // job gagal di worker (mis. yt-dlp exit 1) — stop, jangan poll sia-sia
    if (j.success === false || j.status === "error" || j.status === "failed" || j.data?.status === "failed") {
      throw new Error(`convert gagal di worker: ${j.message || JSON.stringify(j).slice(0, 160)}`);
    }
    await sleep(delay);
  }
  throw new Error(`progress ${kind} timeout setelah ${tries} polling`);
}

/** HEAD download URL -> {status, contentType, size, filename} */
async function probeDownload(url) {
  const h = await head(url, convHeaders());
  const cd = h.headers["content-disposition"] || "";
  let filename = "";
  const mStar = cd.match(/filename\*=UTF-8''([^;]+)/i);
  const mQ = cd.match(/filename="([^"]+)"/i);
  if (mStar) filename = decodeURIComponent(mStar[1]);
  else if (mQ) filename = dec(mQ[1]);
  return {
    status: h.status,
    contentType: h.headers["content-type"] || "",
    size: h.headers["content-length"] || "",
    filename,
  };
}

/** Full convert: available -> pre-progress -> (poll) -> download_url -> HEAD verify. */
async function convert(videoId, format = "mp3", quality) {
  const kind = format === "mp4" ? "mp4" : "mp3";
  let tok, qualities;
  if (kind === "mp4") {
    const { tok: t, data } = await videoAvailable(videoId);
    tok = t;
    qualities = (data.detail || []).map((d) => ({
      quality: d.quality,
      label: d.quality_label || `${d.quality}p`,
      size: d.size,
      fps: d.fps,
    }));
  } else {
    const { tok: t, data } = await musicAvailable(videoId);
    tok = t;
    qualities = (data.detail || []).map((d) => ({
      quality: d.quality,
      label: d.quality_label || `${d.quality} kbps`,
      size: d.size,
    }));
  }
  if (!qualities.length) throw new Error(`tidak ada kualitas ${kind} untuk video ini`);

  // default: tertinggi
  let q = quality;
  if (q == null || q === "") {
    q = qualities[0].quality;
  }
  const qStr = String(q);
  if (!qualities.some((x) => String(x.quality) === qStr)) {
    throw new Error(`kualitas ${qStr} tidak tersedia (pilihan: ${qualities.map((x) => x.quality).join(", ")})`);
  }

  const pp = await preProgress(kind, videoId, qStr, tok);
  let dl = pp.download_url;
  let jobId = null;
  if (!dl && pp.data && pp.data.job_id) {
    jobId = pp.data.job_id;
    const pj = await pollProgress(kind, jobId, tok);
    dl = pj.download_url;
  }
  if (!dl) throw new Error(`tidak dapat download_url: ${JSON.stringify(pp).slice(0, 200)}`);

  const probe = await probeDownload(dl);
  return {
    videoId,
    format: kind,
    quality: Number(qStr),
    token: tok,
    jobId,
    cached: !!pp.cached,
    downloadUrl: dl,
    headers: convHeaders(),
    file: probe,
  };
}

function usage() {
  return `YTMp3 PC Scraper

Usage:
  node ytmp3pc.js info <url|id>
  node ytmp3pc.js search <query>
  node ytmp3pc.js convert <url|id> [--format mp3|mp4] [--quality <q>]

Contoh:
  node ytmp3pc.js info dQw4w9WgXcQ
  node ytmp3pc.js search despacito
  node ytmp3pc.js convert "https://youtu.be/kJQP7kiw5Fk" --format mp3 --quality 320
  node ytmp3pc.js convert kJQP7kiw5Fk --format mp4 --quality 720

Catatan:
  - convert butuh network ke ytzyar.cc + bucketx2.ytzyar.cc.
  - download_url butuh headers Referer+Origin nodex2 (sudah disertakan).
  - MP3: 320/256/192/128 kbps. MP4: 1080/720/480/360 (fps dari API).
  - pre-progress kadang cached -> langsung download_url; kadang job_id -> di-poll.`;
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      format: { type: "string", short: "f" },
      quality: { type: "string", short: "q" },
      help: { type: "boolean", short: "h" },
    },
  });

  const cmd = positionals[0];
  if (values.help || !cmd) {
    process.stderr.write(usage() + "\n");
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  let out;
  if (cmd === "info") {
    const raw = positionals[1];
    if (!raw) throw new Error("info butuh <url|id>");
    const id = extractId(raw);
    const info = await siteInfo(id);
    out = {
      videoId: id,
      title: dec(info.title),
      author: dec(info.author),
      description: dec(info.description),
      thumbnail: info.thumbnail,
      duration: info.duration,
      size: info.size,
      date: info.date,
      views: info.views,
      type: info.type,
      formats: info.formats || {},
    };
  } else if (cmd === "search") {
    const q = positionals.slice(1).join(" ").trim();
    if (!q) throw new Error("search butuh <query>");
    const r = await reqJson(`${SITE}${API_SEARCH}?query=${encodeURIComponent(q)}`, {
      headers: { Referer: `${SITE}/` },
    });
    if (!r.json) throw new Error(`search gagal (status ${r.status}): ${r.body.slice(0, 160)}`);
    out = {
      query: r.json.query || q,
      count: (r.json.items || []).length,
      items: (r.json.items || []).map((it) => ({
        videoId: it.videoId,
        title: dec(it.title),
        author: dec(it.author),
        duration: it.duration,
        thumbnail: it.thumbnail,
      })),
    };
  } else if (cmd === "convert") {
    const raw = positionals[1];
    if (!raw) throw new Error("convert butuh <url|id>");
    const id = extractId(raw);
    const format = (values.format || "mp3").toLowerCase();
    if (format !== "mp3" && format !== "mp4") throw new Error(`format tidak dikenal: ${format} (pakai mp3|mp4)`);
    out = await convert(id, format, values.quality);
    // sertakan info dasar dari frontend (best effort, tidak blocking convert)
    try {
      const info = await siteInfo(id);
      out.title = dec(info.title);
      out.author = dec(info.author);
      out.thumbnail = info.thumbnail;
      out.siteSize = info.size;
      out.siteDuration = info.duration;
    } catch {
      /* info optional */
    }
  } else {
    throw new Error(`command tidak dikenal: ${cmd}\n\n${usage()}`);
  }

  const s = JSON.stringify(out, null, 2) + "\n";
  await new Promise((r) => process.stdout.write(s, r));
}

main().catch((e) => {
  process.stderr.write(`error: ${e.message || e}\n`);
  process.exitCode = 1;
});
