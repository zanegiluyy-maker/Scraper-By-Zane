const SITE = 'https://www.myinstants.com'
const API = 'https://myinstants-api.vercel.app'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// Timeout per lapis (ms). Direct pendek: 403 CF datang <1 detik.
const T = { direct: 12000, api: 15000, dl: 30000, cdx: 20000, avail: 12000 }
const MAX_Q = 100, MAX_ITEMS = 36, MAX_BYTES = 10 * 1024 * 1024

/** Error typed: NO_QUERY|NO_RESULT|BLOCKED|UPSTREAM|TIMEOUT|NETWORK|BAD_AUDIO|TOO_LARGE */
export class MyInstantsError extends Error {
  /** @param {string} code @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message); this.name = 'MyInstantsError'; this.code = code; Object.assign(this, extra)
  }
}

/** fetch + timeout; timer selalu dibersihkan di finally. @returns {Promise<Response>} */
async function fetchT(url, headers, ms) {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  try {
    return await fetch(url, { headers, signal: c.signal, redirect: 'follow' })
  } finally { clearTimeout(t) }
}

const H = {
  nav: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Upgrade-Insecure-Requests': '1', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' },
  api: { 'User-Agent': UA, Accept: 'application/json' },
  audio: (ref) => ({ 'User-Agent': UA, Accept: 'audio/*,*/*;q=0.5', Referer: ref || SITE + '/' }),
}

/** True bila body adalah halaman blokir Cloudflare. */
export function isBlockedPage(t) {
  const s = String(t || '')
  return s.includes('you have been blocked') || s.includes('Attention Required! | Cloudflare') || s.includes('cf-error-details')
}

/** Buang tag + entity umum. */
const cleanText = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * Parse `div.instant` → {id,title,url,mp3}. Toleran urutan atribut & kutip.
 * @param {string} html @returns {Array<{id,title,url,mp3}>}
 */
export function parseInstantList(html) {
  const text = String(html || '')
  const out = [], seen = new Set()
  const res = [
    /<a\b[^>]*class=["'][^"']*\binstant-link\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
    /<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\binstant-link\b[^"']*["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
  ]
  for (const re of res) {
    for (const m of text.matchAll(re)) {
      if (seen.has(m[1])) continue
      seen.add(m[1])
      const title = cleanText(m[2])
      if (!title) continue
      const oc = text.slice(m.index, m.index + 4000).match(/onclick=["']play\(['"]([^'"]+)['"]/i)
      if (!oc) continue
      out.push({
        id: m[1].split('/').filter(Boolean).pop() || m[1],
        title,
        url: m[1].startsWith('http') ? m[1] : SITE + m[1],
        mp3: oc[1].startsWith('http') ? oc[1] : SITE + oc[1],
      })
      if (out.length >= MAX_ITEMS) return out
    }
  }
  return out
}

// ── Cache mini (hasil search 10 mnt/100, snapshot 7 hari/200, blokir 1 jam)
function mkCache(ttl, max) {
  const m = new Map()
  return {
    get: (k) => {
      const h = m.get(k)
      if (!h || Date.now() - h.at > ttl) { m.delete(k); return null }
      m.delete(k); m.set(k, h); return h.v
    },
    put: (k, v) => {
      m.delete(k); m.set(k, { at: Date.now(), v })
      while (m.size > max) { const o = m.keys().next().value; if (o === undefined) break; m.delete(o) }
    },
  }
}
const results = mkCache(10 * 60_000, 100)
const snapshots = mkCache(7 * 24 * 3600_000, 200)
let directBlockedUntil = 0

/** Panggil endpoint API publik. @returns {Promise<Array>} */
async function api(path) {
  let res
  try {
    res = await fetchT(API + path, H.api, T.api)
  } catch (e) {
    if (e?.name === 'AbortError') throw new MyInstantsError('TIMEOUT', 'API timeout.')
    throw new MyInstantsError('NETWORK', 'API gagal koneksi: ' + (e?.message || e))
  }
  if (res.status === 404) return [] // 404 di API ini = "tidak ketemu"
  if (!res.ok) throw new MyInstantsError('UPSTREAM', 'API HTTP ' + res.status + '.', { status: res.status })
  const j = await res.json().catch(() => null)
  return (Array.isArray(j?.data) ? j.data : []).filter((x) => x?.title && x?.mp3).slice(0, MAX_ITEMS)
    .map((x) => ({ id: String(x.id || ''), title: String(x.title), url: String(x.url || ''), mp3: String(x.mp3) }))
}

/** Search direct HTML. Melempar BLOCKED bila kena Cloudflare. */
async function directSearch(q) {
  let res
  try {
    res = await fetchT(SITE + '/en/search/?name=' + encodeURIComponent(q), H.nav, T.direct)
  } catch (e) {
    if (e?.name === 'AbortError') throw new MyInstantsError('TIMEOUT', 'Direct timeout.')
    throw new MyInstantsError('NETWORK', 'Direct gagal koneksi.')
  }
  const text = await res.text()
  if (res.status === 403 || isBlockedPage(text)) {
    directBlockedUntil = Date.now() + 3600_000
    throw new MyInstantsError('BLOCKED', 'Direct kena blokir CF.', { status: res.status })
  }
  if (!res.ok) throw new MyInstantsError('UPSTREAM', 'Direct HTTP ' + res.status + '.')
  return parseInstantList(text)
}

/**
 * Cari soundboard. Direct dulu (kecuali diingat kena blokir) → API.
 * @param {string} query @returns {Promise<{items, via: 'direct'|'api'|'cache'}>}
 */
export async function searchSounds(query) {
  const q = String(query || '').trim().slice(0, MAX_Q)
  if (!q) throw new MyInstantsError('NO_QUERY', 'Query kosong.')
  const key = 's\u0000' + q.toLowerCase()
  const hit = results.get(key)
  if (hit) return { items: hit, via: 'cache' }
  if (Date.now() >= directBlockedUntil) {
    try {
      const items = await directSearch(q)
      if (items.length) { results.put(key, items); return { items, via: 'direct' } }
    } catch { /* jatuh ke API */ }
  }
  const items = await api('/search?q=' + encodeURIComponent(q))
  if (!items.length) throw new MyInstantsError('NO_RESULT', `Sound "${q}" tidak ketemu.`)
  results.put(key, items)
  return { items, via: 'api' }
}

/** Ambil daftar: trending/best/recent. @returns {Promise<{items, via}>} */
async function getList(path, key) {
  const hit = results.get(key)
  if (hit) return { items: hit, via: 'cache' }
  const items = await api(path)
  if (!items.length) throw new MyInstantsError('NO_RESULT', 'Daftar kosong.')
  results.put(key, items)
  return { items, via: 'api' }
}

/** Trending per region (halaman /en/index/<region>/). @param {string} [region='id'] */
export const getTrending = (region = 'id') => getList('/trending?q=' + encodeURIComponent(String(region || 'id').toLowerCase().replace(/[^a-z]/g, '') || 'id'), 't\u0000' + region)
/** Best of all time per region. @param {string} [region='id'] */
export const getBest = (region = 'id') => getList('/best?q=' + encodeURIComponent(String(region || 'id').toLowerCase().replace(/[^a-z]/g, '') || 'id'), 'b\u0000' + region)
/** Baru diupload (global). */
export const getRecent = () => getList('/recent', 'recent')

/** Cek magic byte audio (MP3/OGG/WAV/M4A). */
export function isAudio(b) {
  if (!b || b.length < 4) return false
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return true
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return true
  const s4 = b.subarray(0, 4).toString('latin1')
  if (s4 === 'OggS' || s4 === 'RIFF') return true
  return b.subarray(4, 8).toString('latin1') === 'ftyp'
}

/** Validasi buffer audio (tolak HTML error & file raksasa). @returns {Buffer} */
function checkAudio(buf, ctype) {
  if (!buf.length) throw new MyInstantsError('BAD_AUDIO', 'Audio kosong.')
  if (buf.length > MAX_BYTES) throw new MyInstantsError('TOO_LARGE', 'Audio >10MB.')
  if (ctype.includes('text/') || ctype.includes('html')) throw new MyInstantsError('BLOCKED', 'Balasan HTML, bukan audio.')
  if (!isAudio(buf)) throw new MyInstantsError('BAD_AUDIO', 'Bukan file audio valid.')
  return buf
}

/** Download langsung. */
async function dlDirect(url, ref) {
  let res
  try {
    res = await fetchT(url, H.audio(ref), T.dl)
  } catch (e) {
    if (e?.name === 'AbortError') throw new MyInstantsError('TIMEOUT', 'Download timeout.')
    throw new MyInstantsError('NETWORK', 'Download gagal koneksi.')
  }
  if (res.status === 403 || res.status === 401) throw new MyInstantsError('BLOCKED', 'Download ' + res.status + '.', { status: res.status })
  if (!res.ok) throw new MyInstantsError('BAD_AUDIO', 'Download HTTP ' + res.status + '.')
  return checkAudio(Buffer.from(await res.arrayBuffer()), (res.headers.get('content-type') || '').toLowerCase())
}

/** Timestamp snapshot arsip (baru→lama) via availability API, fallback CDX. */
async function findSnapshots(mp3) {
  const out = []
  try { // availability: cepat (1 snapshot) tapi kadang kosong
    const r = await fetchT('https://archive.org/wayback/available?url=' + encodeURIComponent(mp3), H.api, T.avail)
    const ts = (await r.json().catch(() => null))?.archived_snapshots?.closest?.timestamp
    if (/^\d{14}$/.test(ts || '')) out.push(ts)
  } catch { /* lanjut CDX */ }
  for (let attempt = 0; attempt < 2 && !out.length; attempt++) { // CDX: daftar penuh, kadang lambat
    try {
      const q = new URLSearchParams({ url: mp3, output: 'json', filter: 'statuscode:200', collapse: 'digest', fl: 'timestamp', limit: '20' })
      const r = await fetchT('http://web.archive.org/cdx/search/cdx?' + q, H.api, T.cdx)
      const rows = await r.json().catch(() => null)
      if (Array.isArray(rows)) {
        for (const row of rows.slice(1)) {
          const ts = Array.isArray(row) ? String(row[0] || '') : ''
          if (/^\d{14}$/.test(ts) && !out.includes(ts)) out.push(ts)
        }
      }
    } catch { /* coba lagi sekali */ }
  }
  return out.sort().reverse()
}

/** Download 1 snapshot + validasi. */
async function dlSnapshot(mp3, ts) {
  const res = await fetchT(`http://web.archive.org/web/${ts}id_/${mp3}`, { 'User-Agent': UA, Accept: 'audio/*,*/*' }, T.dl)
  if (!res.ok) throw new MyInstantsError('BAD_AUDIO', `Snapshot ${ts} HTTP ${res.status}.`)
  return checkAudio(Buffer.from(await res.arrayBuffer()), (res.headers.get('content-type') || '').toLowerCase())
}

/** Download via arsip (snapshot cache → availability → CDX → coba 3 terbaru). */
async function dlWayback(mp3) {
  const known = snapshots.get(mp3)
  if (known) {
    try { return await dlSnapshot(mp3, known) } catch { /* cari ulang */ }
  }
  for (const ts of (await findSnapshots(mp3)).slice(0, 3)) {
    try {
      const buf = await dlSnapshot(mp3, ts)
      snapshots.put(mp3, ts)
      return buf
    } catch { /* snapshot rusak → mundur */ }
  }
  throw new MyInstantsError('BAD_AUDIO', 'Tidak ada arsip hidup.')
}

/**
 * Download 1 MP3: direct → arsip Wayback.
 * @param {string} mp3Url @param {string} [referer]
 * @param {object} [opts] @param {(stage: 'direct'|'wayback') => void} [opts.onProgress] sinkron, throw ditoleransi
 * @returns {Promise<Buffer>} (BLOCKED = kedua lapis gagal → pemanggil balas link)
 */
export async function downloadSound(mp3Url, referer, opts = {}) {
  if (!/^https?:\/\//i.test(String(mp3Url || ''))) throw new MyInstantsError('BAD_AUDIO', 'URL audio tidak valid.')
  const step = (s) => { try { opts.onProgress?.(s) } catch {} }
  let directErr = null
  try { step('direct'); return await dlDirect(mp3Url, referer) }
  catch (e) { directErr = e; if (e?.code === 'TOO_LARGE') throw e }
  try { step('wayback'); return await dlWayback(mp3Url) }
  catch { throw directErr }
}

export const _internal = { SITE, API, T, MAX_Q, MAX_BYTES, results, snapshots }
