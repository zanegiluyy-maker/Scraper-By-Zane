/**
 * Name : Thum.io screenshot scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://www.thum.io
 * Type : Scraper
 * Function : screenshot halaman web jadi gambar PNG
 * Note : free 1000x/bulan tanpa daftar; viewport tetap 1200 (fullpage & custom viewport berbayar)
 */

const API = 'https://image.thum.io/get'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const T_REQ = 60_000
const MAX_BYTES = 8 * 1024 * 1024

// Cache hasil (URL+dimensi → PNG, 5 menit, cap 20): hemat jatah 1000/bln.
const cache = new Map()
const CACHE_TTL = 5 * 60_000, CACHE_MAX = 20

/** Error typed: BAD_URL | HTTP | BAD_IMAGE | TIMEOUT | NETWORK */
export class ThumError extends Error {
  /** @param {string} code @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message); this.name = 'ThumError'; this.code = code; Object.assign(this, extra)
  }
}

/** fetch + timeout; timer dibersihkan di finally. */
async function fetchT(url, ms) {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  try {
    return await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' }, signal: c.signal, redirect: 'follow' })
  } finally { clearTimeout(t) }
}

/** PNG/JPEG/GIF lewat magic byte (header bisa bohong). */
export function isImage(b) {
  if (!b || b.length < 4) return false
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true
  return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46
}

/**
 * Screenshot URL → PNG.
 * @param {string} url URL target (http/https)
 * @param {object} [opts] @param {number} [opts.width=800] lebar output (100..1200)
 * @param {number} [opts.crop=600] tinggi crop dari render 1200px (100..1200)
 * @param {number} [opts.maxAge=1] refresh bila cache thum.io lebih tua (jam)
 * @returns {Promise<{buffer: Buffer, width: number, crop: number}>}
 */
export async function screenshot(url, opts = {}) {
  const target = String(url || '').trim()
  if (!/^https?:\/\//i.test(target)) throw new ThumError('BAD_URL', 'URL harus http(s)://')
  const width = Math.min(1200, Math.max(100, Math.round(Number(opts.width) || 800)))
  const crop = Math.min(1200, Math.max(100, Math.round(Number(opts.crop) || 600)))
  const maxAge = Math.max(0, Math.round(Number(opts.maxAge ?? 1)))

  const key = `${target}\u0000${width}x${crop}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.v

  const api = `${API}/noanimate/width/${width}/crop/${crop}/maxAge/${maxAge}/${target}`
  // 1× retry HANYA untuk gagal jaringan/timeout (transient). HTTP 4xx/5xx
  // tidak di-retry: 404 = target mati, dan ulang tidak mengubah apa pun.
  let res = null, netErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetchT(api, T_REQ)
      netErr = null
      break
    } catch (e) {
      netErr = e
      if (e?.name !== 'AbortError' && !/fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(String(e?.message || ''))) break
    }
  }
  if (!res) {
    if (netErr?.name === 'AbortError') throw new ThumError('TIMEOUT', `Render >${T_REQ / 1000} detik.`)
    throw new ThumError('NETWORK', 'Gagal koneksi ke thum.io.')
  }
  // Catatan: target mati dibalas 404 DENGAN body PNG → status wajib 200.
  if (!res.ok) throw new ThumError('HTTP', `thum.io HTTP ${res.status} (target tidak valid / kuota habis).`, { status: res.status })
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 2048) throw new ThumError('BAD_IMAGE', 'Hasil terlalu kecil, render gagal.')
  if (buf.length > MAX_BYTES) throw new ThumError('BAD_IMAGE', 'Hasil >8MB, tolak.')
  if (!isImage(buf)) throw new ThumError('BAD_IMAGE', 'Bukan gambar valid.')

  const out = { buffer: buf, width, crop }
  cache.delete(key); cache.set(key, { at: Date.now(), v: out })
  while (cache.size > CACHE_MAX) { const o = cache.keys().next().value; if (o === undefined) break; cache.delete(o) }
  return out
}

export const _internal = { API, T_REQ, MAX_BYTES, cacheStats: () => ({ entries: cache.size, max: CACHE_MAX }) }
