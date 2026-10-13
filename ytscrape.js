/**
 * Name : YouTube Scraper (search engine max 30 + downloader via provider, JSON only)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://www.youtube.com (+ provider: invidious & y2mate.gs)
 * Type : Scraper
 * Function : search -> 30 hasil pencarian; dl -> link download video/audio -> JSON ke layar
 * Note : error fix sendiri. Search ambil ytInitialData dari halaman results lalu sambung pakai
 *        endpoint InnerTube /youtubei/v1/search (continuation) — tanpa API key Google, tanpa login,
 *        tanpa captcha. Download: langsung dari YouTube gak bisa (streamingData sekarang semua
 *        signatureCipher + butuh nsig/po-token, client ANDROID/IOS kena 400/LOGIN_REQUIRED), jadi
 *        pakai 2 provider yang di-scrape:
 *          1. invidious  -> api /api/v1/videos/<id> (daftar instance live dari api.invidious.io +
 *                           fallback hardcoded), balikin adaptiveFormats (video-only + audio-only)
 *                           plus formatStreams (muxed) & hls/dash. No captcha, no CF challenge.
 *          2. y2mate.gs  -> backend etacloud (auth/init/convert/progress), hasilnya mp3/mp4 jadi.
 *        Urutan auto: mp4 -> invidious dulu (cepat, link langsung), mp3 -> y2mate dulu (mp3 beneran;
 *        invidious cuma m4a/opus). Tiap link hasil akhir di-probe (GET Range lalu potong socket)
 *        biar ketahuan mati/hidupnya. Zero dep, native https, nol file ditulis ke disk.
 *        Usage:
 *          node ytscrape.js search "one piece opening" --limit 30
 *          node ytscrape.js dl <link|id> --format mp4
 *          node ytscrape.js dl <link|id> --format mp3 --provider y2mate
 *          node ytscrape.js dl <link|id> --itag 137 --provider invidious
 *          node ytscrape.js instances
 */

import { request as httpsReq } from 'node:https'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

const YT = 'https://www.youtube.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const TIMEOUT = 30_000
const RETRIES = 2

// instance invidious yang biasanya buka API (dicek ulang tiap jalan)
const IV_FALLBACK = [
  'invidious.f5.si', 'inv.nadeko.net', 'invidious.tiekoetter.com', 'yewtu.be',
  'invidious.nerdvpn.de', 'invidious.privacyredirect.com', 'invidious.materialio.us',
  'invidious.fdn.fr', 'iv.ggtyler.dev', 'invidious.protokolla.fi',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── HTTP ────────────────────────────────────────────────────
/** Request HTTPS native, ikut redirect, retry untuk 429/5xx/timeout. */
async function req(url, { method = 'GET', headers = {}, body, maxRedirect = 5, timeout = TIMEOUT, retries = RETRIES } = {}) {
  let cur = url
  for (let hop = 0; hop <= maxRedirect; hop++) {
    const u = new URL(cur)
    let out = null
    for (let i = 0; i <= retries; i++) {
      out = await new Promise((resolve) => {
        const rq = httpsReq(
          {
            protocol: u.protocol, hostname: u.hostname, port: u.port || 443,
            path: u.pathname + u.search, method, servername: u.hostname,
            headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers },
          },
          (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => resolve({
              status: res.statusCode, headers: res.headers,
              text: Buffer.concat(chunks).toString('utf8'), finalUrl: cur,
            }))
          },
        )
        rq.setTimeout(timeout, () => rq.destroy(new Error('timeout')))
        rq.on('error', (e) => resolve({ status: 0, error: e.message }))
        if (body) rq.write(body)
        rq.end()
      })
      if ((out.status >= 500 || out.status === 429 || out.status === 0) && i < retries) {
        await sleep(700 * (i + 1))
        continue
      }
      break
    }
    const loc = out.headers?.location
    if (loc && out.status >= 300 && out.status < 400) {
      cur = new URL(loc, cur).toString()
      continue
    }
    return out
  }
  throw new Error('gagal: kebanyakan redirect')
}

/** Probe link download: GET Range 1 byte, langsung potong socket (gak tarik body). */
async function probe(url) {
  try {
    let cur = url
    for (let hop = 0; hop < 5; hop++) {
      const u = new URL(cur)
      const out = await new Promise((resolve) => {
        const rq = httpsReq(
          {
            protocol: u.protocol, hostname: u.hostname, port: u.port || 443,
            path: u.pathname + u.search, method: 'GET', servername: u.hostname,
            headers: { 'User-Agent': UA, Range: 'bytes=0-0', Accept: '*/*' },
          },
          (res) => {
            res.destroy()
            resolve({
              status: res.statusCode, headers: res.headers, finalUrl: cur,
            })
          },
        )
        rq.setTimeout(12_000, () => rq.destroy(new Error('timeout')))
        rq.on('error', (e) => resolve({ status: 0, error: e.message }))
        rq.end()
      })
      const loc = out.headers?.location
      if (loc && out.status >= 300 && out.status < 400) {
        cur = new URL(loc, cur).toString()
        continue
      }
      const range = out.headers?.['content-range'] || ''
      const total = Number((range.split('/')[1] || out.headers?.['content-length'] || '').trim())
      return {
        ok: out.status === 200 || out.status === 206,
        status: out.status,
        contentType: out.headers?.['content-type'] || null,
        totalBytes: Number.isFinite(total) && total > 0 ? total : null,
        contentDisposition: out.headers?.['content-disposition'] || null,
        finalHost: new URL(cur).hostname,
      }
    }
    return { ok: false, status: 0, error: 'kebanyakan redirect' }
  } catch (e) {
    return { ok: false, status: 0, error: e.message }
  }
}

// ── SEARCH (ytInitialData + continuation InnerTube) ─────────
function scanJson(text, start) {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

const runs = (o) => (o?.runs || []).map((r) => r.text).join('')

function walkSearch(node, out, tokenRef) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const v of node) walkSearch(v, out, tokenRef)
    return
  }
  const v = node.videoRenderer
  if (v?.videoId) {
    out.push({
      id: v.videoId,
      url: `https://www.youtube.com/watch?v=${v.videoId}`,
      title: runs(v.title) || null,
      length: v.lengthText?.simpleText || null,
      views: v.viewCountText?.simpleText || null,
      channel: runs(v.ownerText) || null,
      channelUrl: v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId
        ? `${YT}/channel/${v.ownerText.runs[0].navigationEndpoint.browseEndpoint.browseId}` : null,
      published: v.publishedTimeText?.simpleText || null,
      thumb: v.thumbnail?.thumbnails?.at?.(-1)?.url || null,
    })
  }
  if (!tokenRef.token) {
    const t = node.continuationCommand?.token || node.continuationEndpoint?.continuationCommand?.token
    if (t) tokenRef.token = t
  }
  for (const val of Object.values(node)) walkSearch(val, out, tokenRef)
}

/** Cari di YouTube: halaman results + sambungan continuation sampai limit. */
async function search(query, { limit = 30, pages = 3, log } = {}) {
  const q = String(query || '').trim()
  if (!q) throw new Error('query kosong')
  const max = Math.max(1, Math.min(Number(limit) || 30, 60))

  const page = await req(`${YT}/results?search_query=${encodeURIComponent(q)}&hl=en&gl=US`, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  })
  if (page.status !== 200) throw new Error(`halaman search HTTP ${page.status}`)

  const key = page.text.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1]
  const ver = page.text.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1] || '2.20261009.01.00'
  const at = page.text.indexOf('var ytInitialData')
  const brace = page.text.indexOf('{', at)
  if (at < 0 || brace < 0) throw new Error('ytInitialData tak ketemu (kemungkinan kena consent/bot)')
  const data = JSON.parse(scanJson(page.text, brace))

  const results = []
  const tokenRef = {}
  walkSearch(data, results, tokenRef)
  log?.(`page1: ${results.length} video`)

  let token = tokenRef.token
  for (let p = 1; p < Math.max(1, Number(pages) || 3) && results.length < max && token; p++) {
    await sleep(350)
    const body = JSON.stringify({ context: { client: { hl: 'en', gl: 'US', clientName: 'WEB', clientVersion: ver } }, continuation: token })
    const res = await req(`${YT}/youtubei/v1/search?key=${key}&prettyPrint=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': ver },
      body,
    })
    if (res.status !== 200) {
      log?.(`continuation HTTP ${res.status}, stop`)
      break
    }
    const before = results.length
    const ref = {}
    walkSearch(JSON.parse(res.text), results, ref)
    log?.(`page${p + 1}: +${results.length - before} video`)
    if (results.length === before) break
    token = ref.token
  }

  const seen = new Set()
  const dedup = []
  for (const r of results) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    dedup.push({ ...r, rank: dedup.length + 1 })
    if (dedup.length >= max) break
  }
  return { query: q, limit: max, count: dedup.length, results: dedup }
}

// ── VIDEO ID ────────────────────────────────────────────────
function videoId(input) {
  const value = String(input || '').trim()
  if (/^[\w-]{11}$/.test(value)) return value
  let url
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
  } catch {
    throw new Error('link YouTube tidak valid')
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const parts = url.pathname.split('/').filter(Boolean)
  const id = host === 'youtu.be'
    ? parts[0]
    : (url.searchParams.get('v') || (['embed', 'live', 'shorts', 'v'].includes(parts[0]) ? parts[1] : ''))
  if (!/^[\w-]{11}$/.test(id || '')) throw new Error('link YouTube tidak didukung')
  return id
}

// ── PROVIDER 1: INVIDIOUS ───────────────────────────────────
async function ivInstances(log) {
  const list = new Set(IV_FALLBACK)
  try {
    const r = await req('https://api.invidious.io/instances.json', { timeout: 12_000, retries: 0 })
    const j = JSON.parse(r.text)
    if (Array.isArray(j)) {
      for (const [host, meta] of j) {
        if (meta?.type?.includes('http') || meta?.api) list.add(host)
      }
    }
  } catch {
    log?.('daftar instance live gagal, pakai fallback')
  }
  return [...list]
}

/** Ambil info + stream dari satu instance invidious. */
async function ivFetch(host, id, timeout = 16_000) {
  const r = await req(`https://${host}/api/v1/videos/${id}`, {
    headers: { Accept: 'application/json', Referer: `https://${host}/` },
    timeout, retries: 0,
  })
  if (r.status !== 200) throw new Error(`HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`)
  let j
  try { j = JSON.parse(r.text) } catch { throw new Error('respons bukan JSON (kemungkinan halaman error/bot)') }
  const adaptive = j.adaptiveFormats || []
  const muxed = j.formatStreams || []
  if (!adaptive.length && !muxed.length) throw new Error('tidak ada stream')
  // invidious: "resolution" bisa label ("360p") atau "640x360"; "size" bisa WxH atau jumlah byte
  const wh = (f) => {
    for (const key of ['resolution', 'size']) {
      const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(f[key] || ''))
      if (m) return m
    }
    return null
  }
  const bytesOf = (f) => {
    const n = Number(f.clen ?? f.size)
    return Number.isFinite(n) && n > 1000 ? n : null
  }
  return {
    instance: host,
    title: j.title || null,
    author: j.author || null,
    lengthSeconds: j.lengthSeconds || null,
    viewCount: j.viewCount || null,
    liveNow: !!j.liveNow,
    hlsUrl: j.hlsUrl || null,
    dashUrl: j.dashUrl || null,
    muxed: muxed.map((f) => {
      const m = wh(f)
      return {
        itag: Number(f.itag) || null, kind: 'muxed', type: f.type || null,
        quality: f.qualityLabel || f.quality || null, container: f.container || null,
        width: m ? Number(m[1]) : null,
        height: m ? Number(m[2]) : null,
        bytes: bytesOf(f),
        url: f.url,
      }
    }),
    adaptive: adaptive.map((f) => {
      const m = wh(f)
      const label = f.qualityLabel || ''
      return {
        itag: Number(f.itag) || null,
        kind: String(f.type || '').startsWith('audio') ? 'audio' : 'video',
        type: f.type || null, quality: label || f.quality || null,
        container: f.container || null, encoding: f.encoding || null,
        width: m ? Number(m[1]) : null,
        height: m ? Number(m[2]) : (Number((label.match(/(\d{3,4})p/) || [])[1]) || null),
        fps: f.fps || null,
        bitrate: Number(f.bitrate) || null,
        bytes: bytesOf(f),
        url: f.url,
      }
    }).filter((f) => f.url),
  }
}

/** Coba instance satu-satu sampai ada yang balikin stream. */
async function viaInvidious(id, log) {
  const hosts = await ivInstances(log)
  const errors = []
  for (const host of hosts) {
    try {
      const info = await ivFetch(host, id)
      log?.(`invidious ok di ${host} (${info.muxed.length + info.adaptive.length} stream)`)
      return { provider: 'invidious', videoId: id, ...info, errors }
    } catch (e) {
      errors.push({ host, why: e.message })
    }
  }
  throw new Error(`semua instance invidious gagal (${errors.length}): ${errors.slice(0, 3).map((e) => `${e.host}=${e.why}`).join('; ')}`)
}

// ── PROVIDER 2: Y2MATE (backend etacloud) ───────────────────
const Y2 = 'https://y2mate.gs'
const y2json = async (url, label, extra = {}) => {
  const r = await req(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Cache-Control': 'no-cache', Pragma: 'no-cache',
      Referer: `${Y2}/`, Origin: Y2,
      ...extra,
    },
  })
  if (r.status !== 200) throw new Error(`${label} HTTP ${r.status}`)
  let j
  try { j = JSON.parse(r.text) } catch { throw new Error(`${label} bukan JSON`) }
  const code = Number(j.error ?? j.err ?? 0)
  if (Number.isFinite(code) && code > 0) throw new Error(`${label} kode ${code}`)
  return j
}

async function y2discover() {
  const html = await req(Y2, { headers: { Accept: 'text/html' } })
  const apiKey = html.text.match(/\bapiKey\s*=\s*(['"])([A-Za-z0-9_-]{16,128})\1/)?.[2]
  const scriptSrc = html.text.match(/<script\b[^>]*\bsrc\s*=\s*(['"])([^'"]*y2mate(?:\.min)?\.js[^'"]*)\1/i)?.[2]
  if (!apiKey || !scriptSrc) throw new Error('struktur y2mate berubah')
  const script = await req(new URL(scriptSrc, Y2).toString(), { headers: { Accept: 'text/javascript' } })
  const encHost = script.text.match(/\bendpoint\s*=\s*atob\(\s*(['"])([A-Za-z0-9+/=]+)\1\s*\)/)?.[2]
  return { apiKey, apiOrigin: `https://eta.${encHost ? Buffer.from(encHost, 'base64').toString() : 'etacloud.org'}` }
}

async function viaY2mate(id, format, log) {
  // auth/init kadang 403 -> discover ulang sekali (sama kayak ytmp3.js)
  let site = await y2discover()
  let init = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const auth = await y2json(`${site.apiOrigin}/api/v1/auth?api_key=${site.apiKey}&_=${Date.now()}`, 'auth y2mate')
    if (!auth.key) throw new Error('token y2mate tidak ada')
    try {
      init = await y2json(`${site.apiOrigin}/api/v1/init?_=${Date.now()}`, 'init y2mate', { Authorization: `Bearer ${auth.key}` })
      break
    } catch (e) {
      if (attempt === 0 && /403/.test(e.message)) {
        log?.(`${e.message}, discover ulang`)
        await sleep(900)
        site = await y2discover()
        continue
      }
      throw e
    }
  }
  if (!init?.convertURL) throw new Error('URL convert tidak ada')
  const { apiOrigin } = site

  let url = init.convertURL
  let job = null
  const withParams = (raw, params) => {
    const u = new URL(raw)
    for (const [k, val] of Object.entries(params)) u.searchParams.set(k, String(val))
    return u.toString()
  }
  for (let hop = 0; hop <= 5; hop++) {
    const data = await y2json(withParams(url, { v: id, f: format, _: Date.now() }), 'convert y2mate')
    const dl = String(data.downloadURL || '').trim()
    const st = String(data.status || '').toLowerCase()
    if (st === 'download' && dl) { job = { title: data.title || null, downloadUrl: dl }; break }
    if (String(data.redirect) === '1' && data.redirectURL) { url = data.redirectURL; continue }
    if (data.progressURL && dl) { job = { title: data.title || null, downloadUrl: dl, progressUrl: data.progressURL, progress: Number(data.progress) || 0 }; break }
    throw new Error('convert tidak mengembalikan status valid')
  }
  if (!job) throw new Error('convert gagal')

  if (job.progressUrl && (job.progress || 0) < 3) {
    for (let i = 0; i < 20 && (job.progress || 0) < 3; i++) {
      await sleep(3000)
      const data = await y2json(withParams(job.progressUrl, { _: Date.now() }), 'progress y2mate')
      if (String(data.status || '').toLowerCase() === 'download' && data.downloadURL) {
        job = { title: data.title || job.title, downloadUrl: data.downloadURL }
        break
      }
      job.progress = Number(data.progress) || job.progress
      job.downloadUrl = data.downloadURL || job.downloadUrl
    }
  }
  if (!job.downloadUrl) throw new Error('download URL tidak keluar')
  log?.(`y2mate ok (${format})`)
  return {
    provider: 'y2mate', videoId: id, format,
    title: job.title || null, apiOrigin,
    downloadUrl: withParams(job.downloadUrl, { v: id, f: format, r: 'y2mate.gs' }),
  }
}

// ── ORCHESTRASI ─────────────────────────────────────────────
/** Pilih stream terbaik dari hasil invidious (untuk mode mp4/mp3). */
function pickStream(info, { format = 'mp4', itag } = {}) {
  if (itag) {
    const all = [...info.muxed, ...info.adaptive]
    const hit = all.find((f) => Number(f.itag) === Number(itag))
    if (!hit) throw new Error(`itag ${itag} tidak ada di ${info.instance}`)
    return hit
  }
  if (format === 'mp3') {
    const audio = info.adaptive.filter((f) => f.kind === 'audio')
    // 140 = m4a, 251 = webm/opus (biasanya bitrate lebih bagus)
    const best = audio.find((f) => f.itag === 251) || audio.find((f) => f.itag === 140) || audio[0]
    if (!best) throw new Error('tidak ada stream audio')
    return { ...best, note: 'bukan hasil konversi mp3 — m4a/opus mentah (butuh ffmpeg kalau mau mp3)' }
  }
  const muxed = [...info.muxed].sort((a, b) => (b.height || 0) - (a.height || 0))
  if (muxed.length) return muxed[0]
  const video = info.adaptive.filter((f) => f.kind === 'video' && f.container === 'mp4').sort((a, b) => (b.height || 0) - (a.height || 0))
  if (!video.length) throw new Error('tidak ada stream video')
  return { ...video[0], note: 'video-only (DASH) — audio terpisah, gabung pakai ffmpeg' }
}

/** Download: provider invidious (link multi-quality) + y2mate (mp3/mp4 jadi). */
async function download(input, { format = 'mp4', provider = 'auto', itag, check = true, log } = {}) {
  const id = videoId(input)
  const fmt = ['mp3', 'mp4'].includes(String(format).toLowerCase()) ? String(format).toLowerCase() : 'mp4'
  const order = provider === 'invidious' ? ['invidious']
    : provider === 'y2mate' ? ['y2mate']
      : (fmt === 'mp3' ? ['y2mate', 'invidious'] : ['invidious', 'y2mate'])

  const attempts = []
  for (const name of order) {
    try {
      if (name === 'invidious') {
        const info = await viaInvidious(id, log)
        const stream = pickStream(info, { format: fmt, itag })
        const result = {
          source: String(input), videoId: id, title: info.title, author: info.author,
          provider: 'invidious', instance: info.instance, format: fmt, stream,
          streams: { muxed: info.muxed, videoOnly: info.adaptive.filter((f) => f.kind === 'video'), audioOnly: info.adaptive.filter((f) => f.kind === 'audio') },
          hlsUrl: info.hlsUrl, dashUrl: info.dashUrl,
          lengthSeconds: info.lengthSeconds,
        }
        if (check) result.probe = await probe(stream.url)
        if (check && result.probe && result.probe.ok === false) {
          attempts.push({ provider: 'invidious', ok: false, why: `link mati (HTTP ${result.probe.status})` })
          continue
        }
        attempts.push({ provider: 'invidious', ok: true })
        result.attempts = attempts
        return result
      }
      const y = await viaY2mate(id, fmt, log)
      const result = {
        source: String(input), videoId: id, title: y.title,
        provider: 'y2mate', format: fmt, downloadUrl: y.downloadUrl,
      }
      if (check) result.probe = await probe(y.downloadUrl)
      if (check && result.probe && result.probe.ok === false) {
        attempts.push({ provider: 'y2mate', ok: false, why: `link mati (HTTP ${result.probe.status})` })
        continue
      }
      attempts.push({ provider: 'y2mate', ok: true })
      result.attempts = attempts
      return result
    } catch (e) {
      log?.(`${name} gagal: ${e.message}`)
      attempts.push({ provider: name, ok: false, why: e.message })
    }
  }
  throw new Error(`semua provider gagal: ${attempts.map((a) => `${a.provider}=${a.why}`).join('; ')}`)
}

/** Cek status instance invidious (bonus, buat debugging). */
async function instances(log) {
  const hosts = await ivInstances(log)
  const out = []
  // video uji netral (jNQXAC9IVRw kadang balik body kosong di beberapa instance)
  for (const host of hosts.slice(0, 20)) {
    const t0 = Date.now()
    try {
      const r = await req(`https://${host}/api/v1/videos/dQw4w9WgXcQ`, {
        headers: { Accept: 'application/json' }, timeout: 12_000, retries: 0,
      })
      const j = r.status === 200 && r.text ? JSON.parse(r.text) : null
      out.push({
        host, status: r.status, ms: Date.now() - t0,
        api: !!(j && (j.adaptiveFormats?.length || j.formatStreams?.length)),
        streams: (j?.adaptiveFormats?.length || 0) + (j?.formatStreams?.length || 0),
        title: j?.title || null,
      })
    } catch (e) {
      out.push({ host, status: 0, api: false, ms: Date.now() - t0, why: e.message })
    }
  }
  return { total: hosts.length, checked: out.length, instances: out }
}

// ── CLI ─────────────────────────────────────────────────────
const USAGE = `pakai:
  node ytscrape.js search "<query>"     pencarian youtube -> JSON (maks 30)
  node ytscrape.js dl <link|id>         link download video/audio -> JSON
contoh:
  node ytscrape.js search "one piece opening" --limit 30
  node ytscrape.js dl https://youtu.be/9bZkp7q19f0 --format mp4
  node ytscrape.js dl 9bZkp7q19f0 --format mp3
  node ytscrape.js dl <link> --itag 137 --provider invidious
  node ytscrape.js instances
opsi:
  --limit n        jumlah hasil search (default 30, maks 60)
  --pages n        halaman continuation search (default 3)
  --format mp4|mp3 target download (default mp4)
  --provider auto|invidious|y2mate
  --itag n         paksa itag stream invidious (mis. 137 video 1080p, 140 audio m4a)
  --no-check       lewati probe link (default: di-probe dulu)
  -q               matiin log di stderr (stdout tetap JSON)
catatan: nol file ditulis ke disk — keluaran cuma JSON; link stream bertanda tangan &
         kedaluwarsa (±6 jam), resolve ulang tiap mau dipakai. Direct dari youtube butuh
         nsig decipher, jadi provider yang dipakai.`

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const { values: v, positionals } = parseArgs({
    options: {
      limit: { type: 'string', default: '30' },
      pages: { type: 'string', default: '3' },
      format: { type: 'string', default: 'mp4' },
      provider: { type: 'string', default: 'auto' },
      itag: { type: 'string', default: '' },
      'no-check': { type: 'boolean', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
    },
    allowPositionals: true,
  })
  const log = v.quiet ? null : (m) => console.error('[*]', m)
  const [cmd, ...rest] = positionals

  try {
    if (!cmd || cmd === 'help' || cmd === '--help') {
      console.log(USAGE)
      process.exit(0)
    }
    let out
    if (cmd === 'search') {
      out = await search(rest.join(' ') || '', { limit: Number(v.limit) || 30, pages: Number(v.pages) || 3, log })
    } else if (cmd === 'dl' || cmd === 'download') {
      const link = rest[0]
      if (!link) throw new Error('link YouTube kosong')
      out = await download(link, {
        format: v.format, provider: v.provider,
        itag: v.itag ? Number(v.itag) : undefined,
        check: !v['no-check'], log,
      })
    } else if (cmd === 'instances') {
      out = await instances(log)
    } else {
      console.log(USAGE)
      process.exit(1)
    }
    console.log(JSON.stringify(out, null, 2))
  } catch (e) {
    console.error('[!]', e.message || e)
    process.exit(1)
  }
}

export { search, download, videoId, instances }
export default { search, download, videoId, instances }
