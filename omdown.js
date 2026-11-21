/**
 * Name : Omdown Scraper (omdown.site)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://www.omdown.site
 * Type : Scraper
 * Function : node omdown.js "<link>" -> JSON metadata + semua download URL
 *            (video/audio/thumbnail). Flag: --no-probe, --format <id>,
 *            --download (tambah param download=1), --help.
 * Note : error fix sendiri.
 *        Zero dependency npm — Node built-in + curl.
 */

import { spawnSync, spawn } from "node:child_process";

const BASE = "https://www.omdown.site";
const LOCALE = "id";
const DOH = "https://cloudflare-dns.com/dns-query";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

// state session (cookie + action id) — lazy init
const sess = {
  cookie: "",       // "om_sec=...; omdown_locale=id"
  actionId: null,
  actionTried: 0,
};

function die(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}
function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function curlRaw(url, opts = {}) {
  const {
    timeout = 25, method = "GET", body, headers = {}, cookie,
    range, compressed = true, follow = true, retries = 3,
  } = opts;
  const run = (useDoh) => {
    // Jangan paksa -4/-6: ticket terikat IP+session yang dipakai resolve;
    // ganti family di tengah jalan -> "locked to original client network".
    const args = ["-s", "-m", String(timeout), "--http1.1"];
    if (compressed) args.push("--compressed");
    if (follow) args.push("-L", "--max-redirs", "4");
    args.push("-A", UA, "-w", "\n__CURL_CODE__%{http_code}");
    if (useDoh) args.push("--doh-url", DOH);
    if (cookie) args.push("-H", `Cookie: ${cookie}`);
    if (range) args.push("-r", range);
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    if (method !== "GET") args.push("-X", method);
    if (body != null) {
      if (!headers["Content-Type"] && !headers["content-type"]) {
        args.push("-H", "Content-Type: text/plain;charset=UTF-8");
      }
      args.push("--data", body);
    }
    args.push(url);
    const r = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const raw = r.stdout || "";
    const m = raw.match(/\n__CURL_CODE__(\d{3})$/);
    return {
      code: m ? Number(m[1]) : 0,
      body: m ? raw.slice(0, m.index) : raw,
      status: r.status ?? 0,
      stderr: r.stderr || "",
    };
  };
  // retry: normal -> DoH -> DoH (delay) — rate-limit / SSL 35 / HTTP 0
  let r = run(false);
  if (r.code === 0 || r.status !== 0) r = run(true);
  if ((r.code === 0 || r.status !== 0) && retries > 1) {
    for (let i = 1; i < retries; i++) {
      const wait = 800 * i + Math.floor(Math.random() * 400);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      r = run(true);
      if (r.code !== 0 && r.status === 0) break;
    }
  }
  return r;
}

function parseSetCookie(res) {
  // kumpulkan Set-Cookie dari header via -D? lebih simpel: ambil dari jar manual
  // curl tanpa -c: kita parse dari header dump terpisah
  return null;
}

function initSession() {
  // GET homepage -> Set-Cookie om_sec + cari action id dari HTML/JS
  const r = curlRaw(`${BASE}/${LOCALE}`, {
    timeout: 20,
    headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  });
  if (r.code !== 200 && r.code !== 301 && r.code !== 302) {
    die(`homepage HTTP ${r.code}`);
  }
  // ambil cookie via header dump
  const dump = spawnSync("curl", [
    "-s", "-m", "20", "--http1.1", "-A", UA,
    "-D", "-", "-o", "/dev/null",
    `${BASE}/${LOCALE}`,
  ], { encoding: "utf8" });
  const cookies = [];
  const scRe = /set-cookie:\s*([^=]+)=([^;]+)/gi;
  let m;
  while ((m = scRe.exec(dump.stdout || "")) !== null) {
    cookies.push(`${m[1]}=${m[2]}`);
  }
  if (!cookies.some((c) => c.startsWith("om_sec="))) {
    // fallback: coba lagi dengan DoH
    const dump2 = spawnSync("curl", [
      "-s", "-m", "20", "--http1.1", "--doh-url", DOH, "-A", UA,
      "-D", "-", "-o", "/dev/null",
      `${BASE}/${LOCALE}`,
    ], { encoding: "utf8" });
    while ((m = scRe.exec(dump2.stdout || "")) !== null) {
      cookies.push(`${m[1]}=${m[2]}`);
    }
  }
  sess.cookie = cookies.join("; ");
  if (!sess.cookie.includes("om_sec=")) {
    // om_sec mungkin optional utk resolve, tapi stream lebih aman dengannya
    sess.cookie = `omdown_locale=${LOCALE}`;
  }

  // discover action id dari chunk JS
  discoverActionId(r.body);
  if (!sess.actionId) {
    // coba list chunks dari HTML
    const chunks = [...r.body.matchAll(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/g)].map((x) => x[1]);
    for (const p of chunks) {
      const js = curlRaw(`${BASE}${p}`, { timeout: 15 });
      if (discoverActionId(js.body)) break;
    }
  }
  if (!sess.actionId) die("gagal discover resolveMediaAction id");
}

function discoverActionId(html) {
  // pola 1: createServerReference("ID",...,"resolveMediaAction")
  let m = html.match(/createServerReference\(\s*"([a-f0-9]{30,})"[^)]{0,200}"resolveMediaAction"/);
  if (m) { sess.actionId = m[1]; return true; }
  // pola 2: "ID",c.callServer,...,"resolveMediaAction"
  m = html.match(/"([a-f0-9]{30,})"[^;]{0,120}"resolveMediaAction"/);
  if (m) { sess.actionId = m[1]; return true; }
  // pola 3: resolveMediaAction muncul, cari hex sebelumnya
  const idx = html.indexOf("resolveMediaAction");
  if (idx >= 0) {
    const before = html.slice(Math.max(0, idx - 120), idx);
    m = before.match(/([a-f0-9]{40,})\s*$/);
    if (m) { sess.actionId = m[1]; return true; }
  }
  return false;
}

function refreshActionId() {
  sess.actionId = null;
  sess.actionTried++;
  const r = curlRaw(`${BASE}/${LOCALE}`, { timeout: 20 });
  discoverActionId(r.body);
  if (!sess.actionId) {
    const chunks = [...r.body.matchAll(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/g)].map((x) => x[1]);
    // prioritaskan chunk yang mengandung "resolve" di nama / terakhir load
    for (const p of chunks) {
      const js = curlRaw(`${BASE}${p}`, { timeout: 15 });
      if (discoverActionId(js.body)) break;
    }
  }
  // refresh cookie juga
  const dump = spawnSync("curl", [
    "-s", "-m", "20", "--http1.1", "-A", UA, "-D", "-", "-o", "/dev/null",
    `${BASE}/${LOCALE}`,
  ], { encoding: "utf8" });
  const cookies = [];
  const scRe = /set-cookie:\s*([^=]+)=([^;]+)/gi;
  let m;
  while ((m = scRe.exec(dump.stdout || "")) !== null) cookies.push(`${m[1]}=${m[2]}`);
  if (cookies.length) sess.cookie = cookies.join("; ");
  if (!sess.actionId) die("rediscover action id gagal");
}

/* ---------- flight parser ---------- */
function parseFlight(text) {
  const rows = {};
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    if (text[pos] === "\n") { pos++; continue; }
    // row id flight protocol = HEX (bisa "1a", "1d", dst) — jangan cuma \d
    const m = text.slice(pos, pos + 32).match(/^([0-9a-f]+):/);
    if (!m) { pos++; continue; }
    const id = m[1];
    let cs = pos + m[0].length;
    if (text[cs] === "T") {
      const hm = text.slice(cs, cs + 24).match(/^T([0-9a-f]+),/);
      if (!hm) { pos = cs + 1; continue; }
      const len = parseInt(hm[1], 16);
      const ds = cs + hm[0].length;
      rows[id] = text.slice(ds, ds + len);
      pos = ds + len;
    } else {
      const nl = text.indexOf("\n", cs);
      const end = nl < 0 ? n : nl;
      rows[id] = text.slice(cs, end);
      pos = end;
    }
  }
  return rows;
}

function resolveRef(rows, ref) {
  if (typeof ref !== "string" || !ref.startsWith("$")) return ref;
  const key = ref.slice(1);
  if (key === "undefined" || key === "null") return null;
  const row = rows[key];
  if (row == null) return null;
  if (row.startsWith("/")) return row;
  if (row.includes("token=")) return row;
  // row murni token / path aneh
  if (row.startsWith("http")) return row;
  return `/api/media/stream?token=${row}`;
}

function extractStreamToken(pathOrToken) {
  if (!pathOrToken) return null;
  const m = String(pathOrToken).match(/token=([^&]+)/);
  return m ? m[1] : pathOrToken;
}

function parseActionResult(text) {
  const rows = parseFlight(text);
  // cari success JSON — biasanya row "1" atau baris mengandung {"success":
  let data = null;
  for (const [, val] of Object.entries(rows)) {
    if (typeof val === "string" && val.includes('"success"')) {
      try {
        const j = JSON.parse(val);
        if (j && typeof j.success === "boolean") { data = j; break; }
      } catch { /* try next */ }
    }
  }
  if (!data) {
    const m = text.match(/(\{"success":(?:true|false)[^]*\})\s*(?:\n|$)/);
    if (m) {
      try { data = JSON.parse(m[1]); } catch { /* ignore */ }
    }
  }
  if (!data) {
    if (text.includes("Server action not found")) return { _err: "action_not_found" };
    if (text.includes("Panggilan langsung")) return { _err: "direct_denied" };
    return { _err: "parse_failed" };
  }
  if (!data.success) return { _err: "resolve_failed", error: data.error || "unknown" };

  const d = data.data || {};
  // resolve format downloadUrl $N
  let formats = Array.isArray(d.formats) ? d.formats.map((f) => ({ ...f })) : [];
  formats = formats.map((f) => {
    if (typeof f.downloadUrl === "string" && f.downloadUrl.startsWith("$")) {
      const url = resolveRef(rows, f.downloadUrl);
      if (url) return { ...f, downloadUrl: url };
      return { ...f, downloadUrl: null, _missingRef: f.downloadUrl.slice(1) };
    }
    // all-slides / all-playlist = zip multi-file, bukan 1 stream
    if (f.downloadUrl === "all-slides" || f.downloadUrl === "all-playlist" || f.id === "all-slides") {
      return { ...f, downloadUrl: null, _special: "multi-zip" };
    }
    return f;
  });
  // slides (carousel IG/FB) -> tambahkan sebagai format download
  if (Array.isArray(d.slides)) {
    for (const s of d.slides) {
      const url = resolveRef(rows, s.url);
      if (!url) continue;
      const kind = s.type === "video" ? "video" : s.type === "image" ? "image" : "file";
      formats.push({
        id: `slide_${s.index ?? formats.length}`,
        label: s.label || `Slide ${s.index}`,
        description: s.label || null,
        kind,
        quality: s.type || null,
        ext: kind === "video" ? "mp4" : kind === "image" ? "jpg" : null,
        downloadUrl: url,
        slideIndex: s.index ?? null,
        thumbnailUrl: resolveRef(rows, s.thumbnailUrl) || null,
      });
    }
  }
  // thumbnail/preview/playUrl bisa inline full path atau $N
  for (const key of ["thumbnailUrl", "previewUrl", "authorAvatar"]) {
    if (typeof d[key] === "string" && d[key].startsWith("$")) {
      const url = resolveRef(rows, d[key]);
      if (url) d[key] = url;
    }
  }
  if (d.music && typeof d.music.playUrl === "string" && d.music.playUrl.startsWith("$")) {
    const url = resolveRef(rows, d.music.playUrl);
    if (url) d.music.playUrl = url;
  }
  // fallback: formats kosong (Reddit dll) tapi thumbnail/preview ada token
  if (!formats.length) {
    const fallback = resolveRef(rows, d.thumbnailUrl) || resolveRef(rows, d.previewUrl)
      || (typeof d.thumbnailUrl === "string" && d.thumbnailUrl.includes("token=") ? d.thumbnailUrl : null)
      || (typeof d.previewUrl === "string" && d.previewUrl.includes("token=") ? d.previewUrl : null);
    if (fallback && fallback.includes("token=")) {
      formats.push({
        id: "thumbnail",
        label: "Thumbnail / Preview",
        description: "fallback: site tidak kirim formats[]",
        kind: d.previewKind === "video" ? "video" : "image",
        quality: d.previewKind || null,
        ext: d.previewKind === "video" ? "mp4" : "jpg",
        downloadUrl: fallback,
      });
    }
  }
  return { data: d, formats, rows };
}

/* ---------- resolve ---------- */
async function resolveMedia(url, platform = null, locale = LOCALE) {
  if (!sess.actionId) initSession();
  const payload = JSON.stringify([url, platform, locale]);
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await sleep(1200 * attempt + Math.floor(Math.random() * 600));
      if (lastErr === "action_not_found" || lastErr === "direct_denied") refreshActionId();
      else if (attempt === 2) refreshActionId();
    }
    const r = curlRaw(`${BASE}/${LOCALE}`, {
      method: "POST",
      timeout: 35,
      cookie: sess.cookie,
      body: payload,
      headers: {
        "Next-Action": sess.actionId,
        "Origin": BASE,
        "Referer": `${BASE}/${LOCALE}`,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Accept": "*/*",
        "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
      },
    });
    const parsed = parseActionResult(r.body);
    if (!parsed._err) {
      // success tapi 0 format = link invalid / placeholder site
      if (!parsed.formats || parsed.formats.length === 0) {
        const d = parsed.data || {};
        if (!d.rawUrl || d.rawUrl === url || !d.title || d.title === "Instagram" || d.author?.includes("(@instagram_user)")) {
          // coba sekali lagi dulu sebelum nyerah (bisa flaky)
          if (attempt < 2) { lastErr = "empty_formats"; continue; }
          return { ...parsed, formats: [], _placeholder: true };
        }
      }
      return parsed;
    }
    lastErr = parsed._err;
    if (parsed.error) lastErr = parsed.error;
    if (parsed.error && /terlalu lama|timeout/i.test(parsed.error)) {
      lastErr = "resolve_failed";
      continue;
    }
    if (parsed._err === "resolve_failed" && /terlalu lama/i.test(parsed.error || "")) continue;
  }
  if (lastErr === "empty_formats") {
    return { _err: null, data: { platform: null, title: null, rawUrl: url }, formats: [], _placeholder: true };
  }
  die(`resolve gagal: ${lastErr || "unknown"}`);
}

/* ---------- stream probe ---------- */
function probeAsync(token) {
  return new Promise((resolve) => {
    const url = `${BASE}/api/media/stream?token=${encodeURIComponent(token)}`;
    const id = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const bodyFile = `/tmp/ombody_${id}.bin`;
    const hdrFile = `/tmp/omhdr_${id}.txt`;
    // curl | head -c 256: baca magic lalu SIGPIPE -> curl stop (gak unduh penuh).
    // Server YT ignore Range & kirim body puluhan MB.
    const curlParts = [
      "curl", "-s", "-m", "12", "--http1.1",
      "-r", "0-127",
      "-A", shellQuote(UA),
      "-H", shellQuote("X-Requested-With: XMLHttpRequest"),
      "-H", shellQuote(`Referer: ${BASE}/${LOCALE}`),
      "-H", shellQuote(`Origin: ${BASE}`),
      "-H", shellQuote("Sec-Fetch-Site: same-origin"),
      "-H", shellQuote("Sec-Fetch-Mode: cors"),
      "-H", shellQuote("Sec-Fetch-Dest: empty"),
      "-H", shellQuote("Accept: */*"),
      "-b", shellQuote(sess.cookie),
      "-D", shellQuote(hdrFile),
      "-o", "-",
      "--", shellQuote(url),
    ].join(" ");
    const script = `${curlParts} 2>/dev/null | head -c 256 > ${shellQuote(bodyFile)}; true`;
    const ch = spawn("sh", ["-c", script]);
    ch.on("close", () => {
      let code = 0;
      try {
        const hdr = spawnSync("cat", [hdrFile], { encoding: "utf8", maxBuffer: 16 * 1024 }).stdout || "";
        const m = hdr.match(/HTTP\/\d\.\d (\d{3})/);
        if (m) code = Number(m[1]);
      } catch { /* ignore */ }
      spawnSync("rm", ["-f", hdrFile]);
      let b = "";
      try {
        const st = spawnSync("head", ["-c", "256", bodyFile], {
          encoding: "buffer",
          maxBuffer: 1024,
        });
        if (st.status === 0 && st.stdout) b = st.stdout.toString("binary");
      } catch { b = ""; }
      spawnSync("rm", ["-f", bodyFile]);
      const hex = Buffer.from(b.slice(0, 16), "binary").toString("hex");
      const isMp4 = b.length >= 8 && b.slice(4, 8) === "ftyp";
      const isMp3 = b.length >= 3 && b.slice(0, 3) === "ID3";
      const isWebm = hex.startsWith("1a45dfa3");
      const isJpeg = hex.startsWith("ffd8ff");
      const isPng = hex.startsWith("89504e47");
      const isWebp = b.length >= 12 && b.slice(0, 4) === "RIFF" && b.slice(8, 12) === "WEBP";
      const magic = isMp4 ? "mp4" : isMp3 ? "mp3" : isWebm ? "webm"
        : isJpeg ? "jpeg" : isPng ? "png" : isWebp ? "webp" : null;
      const alive = !!magic && !(code >= 400 && code <= 599);
      let err = null;
      if (!alive) {
        const text = b.slice(0, 160);
        err = /^[\x20-\x7e\n\r\t]{6,}$/.test(text) ? text : `http ${code}${magic ? ` magic=${magic}` : ""}`;
      }
      resolve({ alive, code, magic, err });
    });
    ch.on("error", () => resolve({ alive: false, code: 0, magic: null, err: "spawn fail" }));
  });
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function probeMany(files) {
  // SEQUENTIAL + jeda cukup — paralel / jeda pendek -> 403
  // "locked to original client session" (rate-limit per session)
  for (const f of files) {
    let p = await probeAsync(f.token);
    if (!p.alive && /locked|signature verification|Access forbidden/i.test(p.err || "")) {
      // backoff lebih agresif: 2s lalu 5s
      await new Promise((r) => setTimeout(r, 2000));
      p = await probeAsync(f.token);
      if (!p.alive && /locked|signature verification|Access forbidden/i.test(p.err || "")) {
        await new Promise((r) => setTimeout(r, 5000));
        p = await probeAsync(f.token);
      }
    }
    f.alive = p.alive;
    f.magic = p.magic;
    if (!p.alive) f.probeError = p.err;
    await new Promise((r) => setTimeout(r, 400));
  }
  return files;
}

function streamUrl(token, { download = false, filename } = {}) {
  const u = new URL(`${BASE}/api/media/stream`);
  u.searchParams.set("token", token);
  if (download) u.searchParams.set("download", "1");
  if (filename) u.searchParams.set("filename", filename);
  return u.toString();
}

/* ---------- commands ---------- */
async function cmdGet(url, flags) {
  if (!url) die('usage: node omdown.js "<link>"  |  --help');
  const res = await resolveMedia(url, null, LOCALE);
  const d = res.data;
  if (res._placeholder || (!res.formats || res.formats.length === 0)) {
    die(`link tidak valid / tidak didukung: ${url}`);
  }
  let files = res.formats.filter((f) =>
    f.downloadUrl &&
    (f.downloadUrl.includes("token=") || f.downloadUrl.startsWith("/api/media/stream") || f.downloadUrl.startsWith("http"))
  );
  if (!files.length) {
    const specials = res.formats.filter((f) => f._special).map((f) => f.id);
    die(specials.length
      ? `tidak ada format stream langsung (ada special: ${specials.join(", ")})`
      : "tidak ada format download");
  }
  const want = flags.format ? String(flags.format) : null;
  if (want) {
    files = files.filter((f) => f.id === want || f.kind === want);
    if (!files.length) die(`format "${want}" tidak ada. tersedia: ${res.formats.map((f) => f.id).join(", ")}`);
  }
  const items = files.map((f) => {
    const token = extractStreamToken(f.downloadUrl);
    return {
      id: f.id,
      label: f.label,
      kind: f.kind, // video | audio | image | ...
      ext: f.ext || null,
      quality: f.quality || null,
      description: f.description || null,
      hasWatermark: f.hasWatermark ?? null,
      token,
      // URL langsung buat di-curl/browser (sudah ada token)
      url: streamUrl(token, {
        download: flags.download === true || flags.download === "1",
        filename: flags.filename ? String(flags.filename) : undefined,
      }),
      alive: null,
      magic: null,
    };
  });
  if (!flags["no-probe"]) {
    await probeMany(items);
  }
  const aliveN = items.filter((x) => x.alive).length;
  const videos = items.filter((x) => x.kind === "video");
  const audios = items.filter((x) => x.kind === "audio");
  const images = items.filter((x) => x.kind === "image" || x.kind === "photo");
  out({
    ok: 1,
    credit: "Zane",
    url,
    platform: d.platform || null,
    title: d.title || null,
    author: d.author || null,
    duration: d.durationLabel || null,
    durationSeconds: typeof d.duration === "number" ? d.duration : null,
    rawUrl: d.rawUrl || null,
    thumbnail: d.thumbnailUrl || null,
    isCarousel: !!d.isCarousel,
    music: d.music
      ? { title: d.music.title || null, author: d.music.author || null, duration: d.music.duration || null, playUrl: d.music.playUrl || null }
      : null,
    // download siap pakai
    download: {
      video: videos.map((x) => ({ id: x.id, quality: x.quality, label: x.label, url: x.url, alive: x.alive, magic: x.magic })),
      audio: audios.map((x) => ({ id: x.id, label: x.label, url: x.url, alive: x.alive, magic: x.magic })),
      image: images.map((x) => ({ id: x.id, label: x.label, url: x.url, alive: x.alive, magic: x.magic })),
    },
    total: items.length,
    alive: flags["no-probe"] ? null : aliveN,
    files: items,
    notes: [
      flags["no-probe"]
        ? "probe dilewati (--no-probe)"
        : `${aliveN}/${items.length} live (probe magic)`,
      "url stream basi ~15 menit — kalau 403 jalankan ulang",
      `action=${sess.actionId?.slice(0, 12)}…`,
    ],
  });
}

function help() {
  out({
    ok: 1,
    credit: "Zane",
    usage: [
      'node omdown.js "<link>"',
      'node omdown.js "<link>" --no-probe',
      'node omdown.js "<link>" --format sd',
      'node omdown.js "<link>" --download',
      "node omdown.js --help",
    ],
    examples: [
      'node omdown.js "https://vt.tiktok.com/ZSpKq6B3B/"',
      'node omdown.js "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --format yt_136_720p',
      'node omdown.js "https://vt.tiktok.com/ZSpKq6B3B/" --download --filename video.mp4',
    ],
    flags: {
      "--no-probe": "lewati cek live (lebih cepat)",
      "--format <id>": "filter 1 format (sd, audio_video, yt_136_720p, ...)",
      "--download": "tambah ?download=1 di URL (Content-Disposition attachment)",
      "--filename <name>": "nama file saat --download",
    },
    notes: [
      "Output: JSON ke stdout. download.video / download.audio / download.image siap di-curl.",
      "Bypass: Sec-Fetch pair utk server action; X-Requested-With utk stream; action ID auto rediscover.",
      "Ticket ~15 menit IP-bound; jangan spam (rate-limit lock).",
    ],
  });
}

/* ---------- main ---------- */
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    const n = argv[i + 1];
    if (n !== undefined && !n.startsWith("--") && ["format", "filename"].includes(k)) {
      flags[k] = n;
      i++;
    } else flags[k] = true;
  } else pos.push(a);
}

const run = async () => {
  if (flags.help || argv.length === 0) {
    help();
    return;
  }
  const url = pos.join(" ").trim();
  if (!url) {
    help();
    return;
  }
  await cmdGet(url, flags);
};
run().catch((e) => die(e?.message || String(e)));
