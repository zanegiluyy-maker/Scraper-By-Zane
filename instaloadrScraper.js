/**
 * Name : Instaloadr Instagram scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://www.instaloadr.com
 * Type : Scraper
 * Function : resolve link IG (post/reel/tv) → CDN + unduh langsung
 * Note : TANPA key/captcha; unduh DIRECT fbcdn (proxy /api/stream stall dari server) — hanya host CDN IG yang diizinkan
 */

import https from 'node:https'
import dns from 'node:dns'

const API = 'https://www.instaloadr.com/api/fetch'
const TIMEOUT_MS = 30_000
const MAX_BYTES = 50 * 1024 * 1024

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
]

const baseHeaders = (i, json) => ({
  'User-Agent': UAS[i % UAS.length],
  Accept: json ? 'application/json' : '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.instaloadr.com/',
  ...(json ? { 'Content-Type': 'application/json' } : {}),
})

/** Validasi link IG + tebak media_type dari path. */
export function parseInstagramUrl(input) {
  const s = String(input || '').trim()
  let u
  try {
    u = new URL(s.startsWith('http') ? s : `https://${s}`)
  } catch {
    throw new Error('Bukan link Instagram. Contoh: https://www.instagram.com/reel/xxxx/')
  }
  if (!/(^|\.)instagram\.com$/i.test(u.hostname)) {
    throw new Error('Bukan link instagram.com.')
  }
  const p = u.pathname
  const mediaType = /\/reels?\/|\/tv\//i.test(p) ? 'reel' : /\/stories\//i.test(p) ? 'story' : 'post'
  u.search = ''
  u.hash = ''
  return { url: u.toString(), mediaType }
}

async function postFetch(url, mediaType, uaIndex) {
  const res = await fetch(API, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: baseHeaders(uaIndex, true),
    body: JSON.stringify({ url, media_type: mediaType }),
  })
  const body = await res.json().catch(() => null)
  return { res, body }
}

/**
 * Resolve link IG → daftar media {media_type, download_url, thumbnail_url, width, height, duration}.
 * @param {string} input link instagram.com
 */
export async function getInstagramMedia(input) {
  const { url, mediaType } = parseInstagramUrl(input)

  let out = await postFetch(url, mediaType, 0)
  // Tipe tebakan salah (422) → coba sekali sebagai post.
  if (!out.res.ok && out.res.status === 422 && mediaType !== 'post') {
    out = await postFetch(url, 'post', 1)
  }
  if (!out.res.ok) {
    throw new Error(out.body?.detail || `Server sibuk (HTTP ${out.res.status}).`)
  }
  const items = Array.isArray(out.body?.items) ? out.body.items : []
  const ok = items.filter((it) => it?.download_url)
  if (!ok.length) throw new Error(out.body?.detail || 'Tidak ada media (privat atau kedaluwarsa).')
  return { sourceUrl: out.body?.source_url || url, items: ok }
}

/**
 * GET via IPv4 eksplisit. Alasan: DNS Meta mengembalikan AAAA yang tidak
 * bisa di-route dari server ini (SYN menggantung) — fetch Node memilih
 * IPv6 lalu connect-timeout, padahal A record IPv4-nya sehat.
 */
function getIPv4(fileUrl, { timeoutMs, maxBytes }, hops = 0) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(String(fileUrl || ''))
    } catch {
      return reject(new Error('URL file tidak valid.'))
    }
    if (!/(\.|^)(fbcdn\.net|cdninstagram\.com|instagram\.com)$/i.test(u.hostname)) {
      return reject(new Error('Host file tidak diizinkan.'))
    }
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        // Matikan Happy Eyeballs: lookup kustom di bawah mengembalikan
        // 1 alamat IPv4 (bukan array) — autoSelectFamily justru merusaknya.
        autoSelectFamily: false,
        headers: {
          'User-Agent': UAS[0],
          Accept: '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: 'https://www.instagram.com/',
        },
        lookup: (host, opts, cb) => dns.lookup(host, { family: 4 }, cb),
        timeout: timeoutMs,
      },
      (res) => {
        // Ikuti 1 redirect selama tetap di host yang diizinkan.
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 1) {
          res.resume()
          return resolve(getIPv4(new URL(res.headers.location, u).toString(), { timeoutMs, maxBytes }, hops + 1))
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`Unduhan gagal (HTTP ${res.statusCode}).`))
        }
        const chunks = []
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size > maxBytes) {
            req.destroy()
            return reject(new Error('File melebihi 50MB.'))
          }
          chunks.push(c)
        })
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          if (!buf.length) return reject(new Error('File kosong.'))
          resolve({ buffer: buf, mime: res.headers['content-type'] || '' })
        })
        res.on('error', reject)
      }
    )
    req.on('timeout', () => req.destroy(new Error('Timeout mengunduh.')))
    req.on('error', reject)
    req.end()
  })
}

/**
 * Unduh LANGSUNG dari CDN (bukan via /api/stream — proxy itu stall).
 * Hanya host CDN Instagram/Meta yang diizinkan.
 * @returns {{buffer: Buffer, mime: string}}
 */
export async function downloadInstagramFile(fileUrl, { maxBytes = MAX_BYTES, timeoutMs = 120_000 } = {}) {
  try {
    return await getIPv4(fileUrl, { timeoutMs, maxBytes })
  } catch (err) {
    // Fallback fetch standar (umtuk host yang IPv6-nya sehat).
    if (!/connect|timeout|UND_ERR|ENOTFOUND|EHOST/i.test(String(err?.message || '') + String(err?.cause?.code || ''))) throw err
    const res = await fetch(String(fileUrl), {
      signal: AbortSignal.timeout(Math.min(timeoutMs, 60_000)),
      headers: { 'User-Agent': UAS[0], Accept: '*/*', Referer: 'https://www.instagram.com/' },
    })
    if (!res.ok) throw new Error(`Unduhan gagal (HTTP ${res.status}).`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) throw new Error('File kosong.')
    if (buf.length > maxBytes) throw new Error('File melebihi 50MB.')
    return { buffer: buf, mime: res.headers.get('content-type') || '' }
  }
}
