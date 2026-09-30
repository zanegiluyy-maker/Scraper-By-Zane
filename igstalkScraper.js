/**
 * Name : insta-stories-viewer.com IG stalker scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://insta-stories-viewer.com
 * Type : Scraper
 * Function : info profil + daftar story aktif Instagram tanpa login
 * Note : TANPA key/captcha (token /connect/ + socket.io polling, fetch bawaan); story kosong = akun sedang tidak ada story (bukan error)
 */

import https from 'node:https'
import dns from 'node:dns'

const BASE = 'https://insta-stories-viewer.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const TIMEOUT_MS = 25_000
const POLL_MAX = 10
const POLL_MS = 2000
const MAX_MEDIA_BYTES = 15 * 1024 * 1024

/** Ambil payload 42["searchResult",{...}] dari teks polling engine.io. */
function extractPayloads(text) {
  const out = []
  const tag = '42["searchResult",'
  let i = 0
  while ((i = text.indexOf(tag, i)) >= 0) {
    let j = i + tag.length
    let depth = 0
    let instr = false
    let esc = false
    for (; j < text.length; j++) {
      const c = text[j]
      if (instr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') instr = false
      } else if (c === '"') instr = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (!depth) break
      }
    }
    try {
      out.push(JSON.parse(text.slice(i + tag.length, j + 1)))
    } catch { /* paket parsial — lewati */ }
    i = j + 1
  }
  return out
}

const normMedia = (m) => ({
  id: m?.id || null,
  isVideo: !!m?.is_video,
  url: m?.video_url || m?.display_url || null, // token → resolve via mediaUrl()
  thumb: m?.thumbnail_src || m?.display_url || null, // token → resolve via mediaUrl()
});

/** Token media situs → URL proxy CDN yang bisa diunduh. */
const IMG_PROXY = 'https://cdn.iqsaved.com/img2.php?url='
export function mediaUrl(token) {
  const t = String(token || '')
  if (!t) return null
  if (/^https?:\/\//i.test(t)) return t
  return IMG_PROXY + encodeURIComponent(t)
}

export class IgStalker {
  constructor() {
    this.jar = ''
  }

  async _fetch(path, opts = {}) {
    const res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: {
        'User-Agent': UA,
        Referer: `${BASE}/`,
        ...(this.jar ? { Cookie: this.jar } : {}),
        ...(opts.headers || {}),
      },
    })
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : []
    const fresh = raw.map((c) => c.split(';')[0]).join('; ')
    if (fresh) this.jar = this.jar ? `${this.jar}; ${fresh}` : fresh
    return res
  }

  /** Buka sesi socket.io (polling) → sid. */
  async _openSocket() {
    const t = await this._fetch('/socket.io/?EIO=4&transport=polling', { signal: AbortSignal.timeout(TIMEOUT_MS) })
    const hs = await t.text()
    const sid = JSON.parse(hs.slice(hs.indexOf('{'))).sid
    if (!sid) throw new Error('Handshake socket gagal.')
    return sid
  }

  async _postSid(sid, body) {
    await this._fetch(`/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  }

  async _pollSid(sid, wantMs = 20000) {
    const t0 = Date.now()
    let n = 0
    const pays = []
    while (Date.now() - t0 < wantMs && n < POLL_MAX) {
      n++
      const p = await this._fetch(`/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const text = await p.text()
      // 41 = server menutup socket (hasil sudah dikirim) → berhenti, jangan
      // polling sid mati ("Session ID unknown") selamanya.
      if (/(^|[\d:])41($|[\d:])/.test(text) && !text.includes('searchResult')) break
      pays.push(...extractPayloads(text))
      if (pays.length) break
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
    return pays
  }

  /** Satu request = satu socket fresh (server menutup socket tiap selesai). */
  async _searchOnce(username, serverType) {
    const sid = await this._openSocket()
    try {
      await this._postSid(sid, '40')
      await this._postSid(
        sid,
        `42${JSON.stringify(['search', { username, date: Date.now(), token: this.token, serverType }])}`
      )
      return await this._pollSid(sid)
    } finally {
      try {
        await this._fetch(`/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: '41',
          signal: AbortSignal.timeout(5000),
        })
      } catch { /* tutup sesi best-effort */ }
    }
  }

  /**
   * Profil + story aktif.
   * @param {string} input username / @username / link instagram.com
   * @returns {Promise<{profile, stories[]}>}
   */
  async stalk(input) {
    let uid = String(input || '').trim().replace(/^@/, '')
    const m = uid.match(/(?:instagram\.com\/)([A-Za-z0-9._]+)/)
    if (m) uid = m[1]
    if (!/^[A-Za-z0-9._]{1,30}$/.test(uid)) throw new Error('Username Instagram tidak valid.')

    const tokenRes = await this._fetch('/connect/', { signal: AbortSignal.timeout(TIMEOUT_MS) })
    const token = (await tokenRes.json().catch(() => null))?.token
    if (!token) throw new Error('Gagal minta token sesi.')
    this.token = token

    const infoPays = await this._searchOnce(uid, 'user-info')
    const info = infoPays.map((p) => p.data).find((d) => d?.user) || null
    if (!info) throw new Error('Profil tidak ditemukan atau privat.')
    const u = info.user

    // Story: socket FRESH kedua (server menutup socket tiap selesai).
    // Kosong = memang tidak ada story aktif.
    const storyPays = await this._searchOnce(uid, 'stories').catch(() => [])
    const reels = []
    for (const p of storyPays) {
      const r = p.data?.user?.reels || p.data?.reels
      if (Array.isArray(r)) reels.push(...r)
    }

    return {
      profile: {
        id: u.id || null,
        username: u.username || uid,
        fullName: u.full_name || '',
        bio: u.biography || '',
        avatar: mediaUrl(u.profile_pic_url_hd || u.profile_pic_url),
        verified: !!u.is_verified,
        isPrivate: !!u.is_private,
        followers: u.edge_followed_by ?? null,
        following: u.edge_follow ?? null,
        posts: u.edges_count ?? null,
      },
      stories: reels
        .map((m) => {
          const n = normMedia(m)
          return { ...n, url: mediaUrl(n.url), thumb: mediaUrl(n.thumb) }
        })
        .filter((s) => s.url),
    }
  }
}

/**
 * Unduh file story via proxy CDN situs (token sudah di-resolve jadi URL
 * penuh oleh mediaUrl). IPv4 eksplisit sebagai fallback bila fetch biasa
 * kena rute IPv6 buntu (kasus CDN Meta di sebagian server).
 * Hanya host proxy + CDN Instagram/Meta yang diizinkan.
 */
export async function downloadStoryFile(fileUrl, { maxBytes = MAX_MEDIA_BYTES, timeoutMs = 90_000 } = {}) {
  let u
  try {
    u = new URL(String(fileUrl || ''))
  } catch {
    throw new Error('URL file tidak valid.')
  }
  if (!/(\.|^)(iqsaved\.com|fbcdn\.net|cdninstagram\.com|instagram\.com)$/i.test(u.hostname)) {
    throw new Error('Host file tidak diizinkan.')
  }
  // Jalur cepat dulu (terbukti untuk iqsaved); fallback IPv4 bila connect gagal.
  try {
    const res = await fetch(u.toString(), {
      signal: AbortSignal.timeout(Math.min(timeoutMs, 60_000)),
      headers: { 'User-Agent': UA, Accept: '*/*', Referer: 'https://insta-stories-viewer.com/' },
    })
    if (!res.ok) throw new Error(`Unduhan gagal (HTTP ${res.status}).`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) throw new Error('File kosong.')
    if (buf.length > maxBytes) throw new Error('File melebihi batas.')
    return { buffer: buf, mime: res.headers.get('content-type') || '' }
  } catch (e) {
    if (!/connect|timeout|UND_ERR|ENOTFOUND|EHOST|fetch failed/i.test(String(e?.message || '') + String(e?.cause?.code || ''))) throw e
  }
  const got = await new Promise((resolve, reject) => {
    const ref = /iqsaved\.com$/i.test(u.hostname) ? 'https://insta-stories-viewer.com/' : 'https://www.instagram.com/'
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        autoSelectFamily: false,
        headers: { 'User-Agent': UA, Accept: '*/*', Referer: ref },
        lookup: (host, opts, cb) => dns.lookup(host, { family: 4 }, cb),
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          return reject(Object.assign(new Error('redirect'), { location: res.headers.location }))
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
            return reject(new Error('File melebihi batas.'))
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
  }).catch(async (e) => {
    if (!e?.location) throw e
    try {
      return await downloadStoryFile(new URL(e.location, u).toString(), { maxBytes, timeoutMs })
    } catch {
      throw e
    }
  })
  return got
}
