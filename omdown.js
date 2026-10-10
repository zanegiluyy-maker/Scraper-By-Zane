/**
 * Name : OMDOWN Scraper (resolve link 26+ platform -> info media + link download)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://www.omdown.site
 * Type : Scraper
 * Function : resolve <link> -> info media + link download (mp4/mp3/gambar)
 * Note : error fix sendiri.
 */

import { request as httpsReq } from 'node:https'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

const BASE = 'https://www.omdown.site'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const ACT_SESSION = '40010ff24080496480300f210c602eff421bbabc68'
const ACT_RESOLVE = '702804ccc82147179e70c99569473492d22dd96950'
// wajib buat lolos cek server: Origin + Sec-Fetch (bukan cuma Referer)
const BROWSER = { Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }
const TIMEOUT = 45_000
const RETRIES = 3
const GAP = 1200 // server minta >=1 detik antar action

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** deteksi platform dari link (tabel persis dari bundle omdown) */
const PATTERNS = [
  [/(?:^|\.)shortdrama\.tiktok\.com$/i, 'PineDrama'],
  [/(?:^|\.)tiktok\.com$/i, 'TikTok'],
  [/(?:^|\.)(?:douyin\.com|iesdouyin\.com)$/i, 'Douyin'],
  [/(?:^|\.)(?:kuaishou\.com|kwai\.com)$/i, 'Kuaishou'],
  [/(?:^|\.)(?:snackvideo\.com|sck\.io)$/i, 'SnackVideo'],
  [/(?:^|\.)(?:xiaohongshu\.com|rednote\.com|xhslink\.com)$/i, 'RedNote'],
  [/(?:^|\.)(?:youtu\.be|youtube\.com)$/i, 'YouTube'],
  [/(?:^|\.)(?:instagram\.com|instagr\.am|ig\.me)$/i, 'Instagram'],
  [/(?:^|\.)(?:twitter\.com|x\.com|t\.co)$/i, 'X'],
  [/(?:^|\.)(?:facebook\.com|fb\.watch|fb\.com)$/i, 'Facebook'],
  [/(?:^|\.)threads\.(?:net|com)$/i, 'Threads'],
  [/(?:^|\.)(?:bsky\.app|bsky\.social)$/i, 'Bluesky'],
  [/(?:^|\.)(?:reddit\.com|redd\.it)$/i, 'Reddit'],
  [/(?:^|\.)capcut\.com$/i, 'CapCut'],
  [/(?:^|\.)snapchat\.com$/i, 'Snapchat'],
  [/(?:^|\.)twitch\.tv$/i, 'Twitch'],
  [/(?:^|\.)(?:bilibili\.com|bilibili\.tv|b23\.tv|bili\.im)$/i, 'Bilibili'],
  [/(?:^|\.)(?:dailymotion\.com|dai\.ly)$/i, 'Dailymotion'],
  [/(?:^|\.)lahelu\.com$/i, 'Lahelu'],
  [/(?:^|\.)(?:spotify\.com|spoti\.fi)$/i, 'Spotify'],
  [/(?:^|\.)soundcloud\.com$/i, 'SoundCloud'],
  [/(?:^|\.)(?:music\.apple\.com|apple\.co)$/i, 'Apple Music'],
  [/(?:^|\.)(?:pinterest\.(?:com|co\.[a-z]{2}|[a-z]{2,3})|pin\.it)$/i, 'Pinterest'],
  [/(?:^|\.)deviantart\.com$/i, 'DeviantArt'],
  [/(?:^|\.)pixiv\.net$/i, 'Pixiv'],
  [/(?:^|\.)mangadex\.org$/i, 'MangaDex'],
  [/(?:^|\.)imgur\.com$/i, 'Imgur'],
]

function detect(raw) {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    const hit = PATTERNS.find(([re]) => re.test(u.hostname))
    return hit ? hit[1] : null
  } catch {
    return null
  }
}

// ── COOKIE (rotate tiap action: simpan yang terbaru, itu yg statusnya "active") ──
const cookies = new Map()
const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
function absorb(set) {
  for (const raw of set || []) {
    const [pair] = raw.split(';')
    const i = pair.indexOf('=')
    if (i < 0) continue
    const name = pair.slice(0, i).trim()
    const value = pair.slice(i + 1).trim()
    if (!value || /Expires=Thu, 01 Jan 1970/i.test(raw)) cookies.delete(name)
    else cookies.set(name, value)
  }
}

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
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + u.search,
            method,
            servername: u.hostname,
            headers: {
              'User-Agent': UA,
              Accept: '*/*',
              'Accept-Language': 'en-US,en;q=0.9',
              Referer: `${BASE}/en`,
              Cookie: cookieHeader(),
              ...headers,
            },
          },
          (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
              if (res.headers['set-cookie']) absorb(res.headers['set-cookie'])
              resolve({
                status: res.statusCode,
                headers: res.headers,
                text: Buffer.concat(chunks).toString('utf8'),
                finalUrl: cur,
              })
            })
          },
        )
        rq.setTimeout(timeout, () => rq.destroy(new Error('timeout')))
        rq.on('error', (e) => resolve({ status: 0, error: e.message }))
        if (body) rq.write(body)
        rq.end()
      })
      if ((out.status >= 500 || out.status === 429 || out.status === 0) && i < retries) {
        await sleep(800 * (i + 1))
        continue
      }
      break
    }
    const loc = out.headers?.location
    if (method === 'GET' && loc && out.status >= 300 && out.status < 400) {
      cur = new URL(loc, cur).toString()
      continue
    }
    return out
  }
  throw new Error('gagal: kebanyakan redirect')
}

/** POST Server Action -> teks flight. */
function action(actionId, payloadBody, locale) {
  return req(`${BASE}/${locale}`, {
    method: 'POST',
    headers: { 'Next-Action': actionId, 'Content-Type': 'text/plain;charset=UTF-8', Accept: 'text/x-component', ...BROWSER },
    body: payloadBody,
  })
}

// ── CRYPTO (hash kustom + XOR, persis dari bundle) ──────────
function hashP(e) {
  let a = 0x811c9dc5
  let n = 0x9e3779b9
  let t = 0x7fffffff
  let o = 0x27d4eb2d
  for (let i = 0; i < e.length; i++) {
    const r = e.charCodeAt(i)
    a = Math.imul(a ^ r, 0x1000193)
    n = Math.imul(n ^ r >>> 2, 0x85ebca6b)
    t = Math.imul(t ^ r << 3 & 255, 0xc2b2ae35)
    o = Math.imul(o ^ r, 0x165667b1)
  }
  const h = (x) => (x >>> 0).toString(16).padStart(8, '0')
  return h(a) + h(n) + h(t) + h(o) + h(a ^ t) + h(n ^ o) + h(a + n) + h(t + o)
}

function buildPayload(url, platform, locale, salt) {
  const t = Date.now()
  const n = Math.floor(1e9 * Math.random()).toString(36)
  const d = JSON.stringify({ u: url.trim(), p: platform || 'Media', l: locale || 'en', t, n })
  const key = Buffer.from(hashP(`${(23100 ^ t) >>> 0}:${salt}:${t % 997}`), 'hex')
  const plain = Buffer.from(d, 'utf8')
  const data = Buffer.from(plain.map((b, i) => b ^ key[i % key.length])).toString('base64url')
  return { data, t, h: hashP(`${data}:${t}:${salt}`) }
}

// ── PARSER FLIGHT (Next.js RSC: row `<id>:<json>` atau `<id>:T<hex>,<teks>`) ──
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

/** ambil objek hasil action `{success,...}` (bisa nempel setelah row teks tanpa newline). */
function findResult(text) {
  let from = 0
  for (;;) {
    const i = text.indexOf('{"success":', from)
    if (i < 0) return null
    from = i + 1
    const raw = scanJson(text, i)
    if (!raw) continue
    try {
      const v = JSON.parse(raw)
      if (v && typeof v === 'object' && typeof v.success === 'boolean') return v
    } catch { /* bukan hasil action, lanjut */ }
  }
}

/** peta row flight -> nilai, dipakai buat resolve ref "$12". */
function buildRefs(text) {
  const map = new Map()
  let pos = 0
  while (pos < text.length) {
    if (text[pos] === '\n') { pos++; continue }
    const m = /^([0-9a-f]+):/.exec(text.slice(pos, pos + 64))
    if (!m) {
      const nl = text.indexOf('\n', pos)
      if (nl < 0) break
      pos = nl + 1
      continue
    }
    const valAt = pos + m[0].length
    const tRow = /^T([0-9a-f]+),/.exec(text.slice(valAt, valAt + 20))
    if (tRow) {
      const len = parseInt(tRow[1], 16)
      const ds = valAt + tRow[0].length
      map.set(m[1], text.slice(ds, ds + len))
      pos = ds + len
      continue
    }
    let end = text.indexOf('\n', valAt)
    if (end < 0) end = text.length
    const raw = text.slice(valAt, end)
    if (raw[0] === '{' || raw[0] === '[') {
      const js = scanJson(text, valAt)
      if (js) {
        try { map.set(m[1], JSON.parse(js)) } catch { /* abaikan */ }
        pos = valAt + js.length
        continue
      }
    }
    try { map.set(m[1], JSON.parse(raw)) } catch { map.set(m[1], raw) }
    pos = end
  }
  return map
}

function deref(value, refs, depth = 0) {
  if (depth > 8 || value == null) return value
  if (typeof value === 'string') {
    if (value === '$undefined') return null
    const m = /^\$(?:@)?([0-9a-f]+)$/.exec(value)
    if (m && refs.has(m[1])) return deref(refs.get(m[1]), refs, depth + 1)
    return value
  }
  if (Array.isArray(value)) return value.map((v) => deref(v, refs, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = deref(v, refs, depth + 1)
    return out
  }
  return value
}

const absolutize = (v) => (typeof v === 'string' && v.startsWith('/') ? `${BASE}${v}` : v)

function shape(d) {
  const out = {}
  for (const [k, v] of Object.entries(d || {})) out[k] = absolutize(v)
  if (Array.isArray(d?.formats)) out.formats = d.formats.map((f) => {
    const o = { ...f }
    for (const key of ['downloadUrl', 'thumbnailUrl', 'previewUrl']) if (key in o) o[key] = absolutize(o[key])
    return o
  })
  if (Array.isArray(d?.slides)) out.slides = d.slides.map((s) => (s && typeof s === 'object' ? shape(s) : absolutize(s)))
  if (d?.thumbnailUrl) out.thumbnailUrl = absolutize(d.thumbnailUrl)
  return out
}

// ── FLOW ────────────────────────────────────────────────────
async function session(locale, log) {
  const body = JSON.stringify([{ trusted: true, clientTime: Date.now(), interactionType: 'resolve' }])
  for (let i = 0; i < 3; i++) {
    const res = await action(ACT_SESSION, body, locale)
    const r = findResult(res.text)
    if (r?.success && r.salt) {
      log?.(`salt ok`)
      return r.salt
    }
    const msg = r?.error || `session gagal (HTTP ${res.status})`
    if (/terlalu cepat|tunggu/i.test(msg)) {
      log?.(`rate limit, ulang ${msg}`)
      await sleep(1600)
      continue
    }
    throw new Error(msg)
  }
  throw new Error('session gagal berkali-kali')
}

async function resolveAction(url, platform, locale, salt, log) {
  const pl = buildPayload(url, platform, locale, salt)
  const res = await action(ACT_RESOLVE, JSON.stringify([pl, platform, locale]), locale)
  const r = findResult(res.text)
  if (!r) throw new Error(`hasil resolve tak ketemu (HTTP ${res.status})`)
  if (!r.success) throw new Error(r.error || 'resolve gagal')
  log?.('resolve ok')
  return deref(r.data, buildRefs(res.text))
}

/** Info media dari link: session -> resolve -> data (link download sudah absolut). */
async function resolve(rawUrl, { platform, locale = 'en', size = false, log } = {}) {
  const url = String(rawUrl || '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('link harus http(s)')
  const plat = platform || detect(url) || 'Media'

  await req(`${BASE}/${locale}`, { log })
  await sleep(GAP)
  const salt = await session(locale, log)
  await sleep(GAP)
  const data = await resolveAction(url, plat, locale, salt, log)
  const out = shape(data)

  if (size && Array.isArray(out.formats)) {
    for (const f of out.formats) {
      // ada entri placeholder (mis. "all-playlist") yang bukan URL
      if (!f.downloadUrl || !/^https?:\/\//i.test(f.downloadUrl)) continue
      const head = await req(f.downloadUrl, { method: 'HEAD' })
      const len = Number(head.headers?.['content-length'])
      f.status = head.status
      f.sizeBytes = Number.isFinite(len) ? len : null
      f.contentType = head.headers?.['content-type'] || null
    }
  }

  return {
    source: url,
    page: `${BASE}/${locale}`,
    platform: plat,
    ...(out.platform ? { resolvedAs: out.platform } : {}),
    ...out,
    formats: out.formats || [],
  }
}

// ── CLI ─────────────────────────────────────────────────────
const USAGE = `pakai:
  node omdown.js <link>          info media + link download -> JSON
contoh:
  node omdown.js "https://www.tiktok.com/@user/video/123"
  node omdown.js "https://youtu.be/dQw4w9WgXcQ" --size
  node omdown.js platforms
opsi:
  --platform <nama>   paksa nama platform (default: deteksi dari link)
  --locale en|id      bahasa respons (default en)
  --size              HEAD tiap format -> status,sizeBytes,contentType
  -q                  matiin log di stderr (stdout tetap JSON)
catatan: nol file ditulis ke disk — keluaran cuma JSON; link /api/media/stream?token=...
         signed & cepat kedaluwarsa, ambil ulang tiap mau dipakai.`

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const { values: v, positionals } = parseArgs({
    options: {
      platform: { type: 'string', default: '' },
      locale: { type: 'string', default: 'en' },
      size: { type: 'boolean', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
    },
    allowPositionals: true,
  })
  const log = v.quiet ? null : (m) => console.error('[*]', m)
  const [cmd, arg] = positionals

  try {
    if (!cmd || cmd === 'help' || cmd === '--help') {
      console.log(USAGE)
      process.exit(0)
    }
    if (cmd === 'platforms') {
      console.log(JSON.stringify(PATTERNS.map(([, n]) => n), null, 2))
      process.exit(0)
    }

    const link = cmd === 'resolve' ? arg : cmd
    const out = await resolve(link, {
      platform: v.platform || undefined,
      locale: v.locale,
      size: v.size,
      log,
    })
    console.log(JSON.stringify(out, null, 2))
  } catch (e) {
    console.error('[!]', e.message || e)
    process.exit(1)
  }
}

export { resolve, detect, PATTERNS }
