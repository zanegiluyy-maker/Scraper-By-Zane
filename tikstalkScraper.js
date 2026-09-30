/**
 * Name : tik.ninja TikTok stalker scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://tik.ninja
 * Type : Scraper
 * Function : profil + statistik + postingan + followers/following + stories + repost TikTok (tanpa login)
 * Note : TANPA key/captcha; challenge JS (SHA256 per-30-detik + AES-CBC) dihitung ulang per sesi — SEED/TOKEN situs ROTASI jadi wajib bootstrap fresh
 */

import { createHash, createDecipheriv } from 'node:crypto'

const BASE = 'https://tik.ninja'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const TIMEOUT_MS = 30_000
const BUCKET_MS = 30000

function parseCookies(headers) {
  const raw = headers.getSetCookie ? headers.getSetCookie() : []
  return raw.map((c) => c.split(';')[0]).join('; ')
}

export class TikStalker {
  constructor() {
    this.jar = ''
    this.seed = null
    this.token = null
    this.key = null
    this.booted = false
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
    const fresh = parseCookies(res.headers)
    if (fresh) this.jar = this.jar ? `${this.jar}; ${fresh}` : fresh
    return res
  }

  /** WAJIB dulu: cookie sesi + SEED/TOKEN fresh (rotasi tiap periode). */
  async bootstrap() {
    const res = await this._fetch('/', { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`Halaman utama gagal (HTTP ${res.status}).`)
    const html = await res.text()
    const seed = html.match(/JS_CHALLENGE_SEED\s*=\s*"([^"]+)"/)?.[1]
    const token = html.match(/(?:const|let|var)\s+TOKEN\s*=\s*"([^"]+)"/)?.[1]
    if (!seed || !token) throw new Error('Challenge situs berubah (SEED/TOKEN tak ketemu).')
    this.seed = seed
    this.token = token
    this.key = createHash('sha256').update(`${seed}:${token}:response:tik.ninja`).digest()
    this.booted = true
  }

  _jsToken(action) {
    const bucket = Math.floor(Date.now() / BUCKET_MS)
    const hex = createHash('sha256')
      .update(`${this.seed}:${this.token}:${bucket}:${action}:tik.ninja`)
      .digest('hex')
    return { hex, bucket: String(bucket) }
  }

  _decrypt(envelope) {
    const iv = Buffer.from(envelope._i, 'base64')
    const dec = createDecipheriv('aes-256-cbc', this.key, iv)
    const pt = Buffer.concat([dec.update(Buffer.from(envelope._d, 'base64')), dec.final()]).toString()
    return JSON.parse(pt)
  }

  /**
   * Panggil 1 action API. Auto-bootstrap bila belum.
   * 403 → bootstrap ulang + 1x retry (challenge/token bisa kedaluwarsa di
   * tengah jalan, atau request jatuh tepat di batas bucket 30-detik).
   * 403 BERULANG pada get_user = user tak ada/privat.
   */
  async call(action, params = {}) {
    if (!this.booted) await this.bootstrap()
    for (let attempt = 0; attempt < 2; attempt++) {
      const js = this._jsToken(action)
      const body = JSON.stringify({
        ...params,
        action,
        hp: '',
        js_token: js.hex,
        js_bucket: js.bucket,
        __client_build: 'js-token-body-v3',
      })
      let res
      try {
        res = await this._fetch('/api.php', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Token': this.token,
            'X-JS-Token': js.hex,
            'X-JS-Bucket': js.bucket,
            'X-Client-Build': 'js-token-body-v3',
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (e) {
        if (attempt === 0) continue // network blip → 1x retry
        throw new Error('Server tidak merespons — coba lagi.')
      }
      const json = await res.json().catch(() => null)
      if (!json) {
        if (attempt === 0) continue
        throw new Error(`Respons bukan JSON (HTTP ${res.status}).`)
      }
      let data = json
      if (json._t === 'p' && json._i && json._d) {
        try {
          data = this._decrypt(json)
        } catch {
          // Key ikut SEED/TOKEN — dekripsi gagal = sesi basi → re-bootstrap.
          this.booted = false
          if (attempt === 0) {
            await this.bootstrap()
            continue
          }
          throw new Error('Gagal dekripsi respons — coba lagi.')
        }
      }
      if (res.ok) return data?.data ?? data
      if (res.status === 403 && attempt === 0) {
        this.booted = false
        await this.bootstrap()
        continue
      }
      if (res.status === 403 && action === 'get_user') {
        throw new Error('User tidak ditemukan/privat, atau server sedang membatasi — coba lagi 1 menit.')
      }
      throw new Error(data?.error || `Request gagal (${res.status}).`)
    }
  }

  /** Profil + statistik. Terima @handle atau link tiktok.com/@x. */
  async profile(input) {
    let uid = String(input || '').trim().replace(/^@/, '')
    const m = uid.match(/tiktok\.com\/@([\w.]+)/)
    if (m) uid = m[1]
    if (!uid || !/^[\w.]{1,24}$/.test(uid)) throw new Error('Username TikTok tidak valid.')
    const d = await this.call('get_user', { unique_id: uid })
    if (!d?.user) throw new Error('User tidak ditemukan / privat.')
    const u = d.user
    const s = d.stats || {}
    return {
      id: u.id || null,
      username: u.uniqueId || uid,
      nickname: u.nickname || '',
      avatar: u.avatarMedium || u.avatarThumb || null,
      bio: u.signature || '',
      verified: !!u.verified,
      stats: {
        followers: s.followerCount ?? null,
        following: s.followingCount ?? null,
        likes: s.heartCount ?? s.heart ?? null,
        videos: s.videoCount ?? null,
      },
    }
  }

  /** Postingan terbaru. @returns {videos[], cursor, hasMore} */
  async posts(userId, cursor = '0', count = 10) {
    if (!userId) throw new Error('userId kosong.')
    const d = await this.call('get_posts', { user_id: String(userId), cursor: String(cursor), count: Math.min(Math.max(count, 1), 20) })
    return {
      videos: (d?.videos || []).map((v) => ({
        id: v.video_id || v.aweme_id || null,
        title: v.title || '',
        cover: v.cover || null,
        play: v.play || v.download || null,
        duration: v.duration ?? null,
        plays: v.play_count ?? null,
        likes: v.digg_count ?? null,
        comments: v.comment_count ?? null,
        shares: v.share_count ?? null,
        created: v.create_time ?? null,
      })),
      cursor: d?.cursor ?? null,
      hasMore: !!d?.hasMore,
    }
  }

  /** Followers / following (butuh userId dari profile). */
  async followers(userId, count = 10) {
    const d = await this.call('get_followers', { user_id: String(userId), time: '0', count: Math.min(Math.max(count, 1), 30) })
    return d?.followers || d?.users || d || []
  }

  async following(userId, count = 10) {
    const d = await this.call('get_following', { user_id: String(userId), time: '0', count: Math.min(Math.max(count, 1), 30) })
    return d?.following || d?.users || d || []
  }

  async stories(username) {
    const uid = String(username || '').trim().replace(/^@/, '')
    return this.call('get_stories', { unique_id: uid })
  }

  async reposts(username, cursor = '0', count = 10) {
    const uid = String(username || '').trim().replace(/^@/, '')
    return this.call('get_reposts', { unique_id: uid, cursor: String(cursor), count: Math.min(Math.max(count, 1), 20) })
  }
}
