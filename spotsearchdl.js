/**
 * Name : SpotMP3 Downloader
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://spotmp3.net
 * Type : Scraper
 * Function : cari lagu + resolve link Spotify (track/album/playlist/artist) → job MP3 320 kbps → poll job → buffer audio (+ lirik & daftar sumber)
 * Note : API internal /api/v1 tanpa key/login/captcha; search → POST /resolve → POST /jobs → GET /jobs/:id; download 302 ke R2 (ikuti redirect); kuota gratis 30 track/IP/hari → rotasi proxy publik otomatis saat kuota IP utama habis
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici'

const BASE = 'https://spotmp3.net'
const API = `${BASE}/api/v1`
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 90_000
const MAX_AUDIO_BYTES = 16 * 1024 * 1024 // 16MB — batas aman audio WhatsApp
const DONE_STATUS = new Set(['completed', 'partial', 'failed', 'cancelled'])

// Rotasi proxy: kuota site dihitung per-IP. Job dibuat lewat IP utama dulu,
// kalau kuota habis → pindah ke proxy hidup berikutnya (pool publik).
const PROXY_SOURCES = [
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text&timeout=3000',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
  'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt',
  'https://www.proxy-list.download/api/v1/get?type=http',
]
const PROXY_API = 'https://api.ikyyxd.my.id/v2l/proxy-free/ikyy-xsample'
const PROXY_CACHE_MS = 30 * 60 * 1000
const PROXY_PROBE_TIMEOUT_MS = 6_000
const PROXY_JOB_TIMEOUT_MS = 20_000
const PROXY_JOB_TRIES = 6
const PROXY_PROBE_BATCH = 24

let directQuota = null // sisa kuota IP utama (null = belum tahu)
let proxyCandidates = []
let proxyCandidatesAt = 0
let proxyFetching = null
let aliveProxies = [] // { proxy, remaining }
const deadProxies = new Set()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const shuffle = (arr) => {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function absolute(path) {
  if (!path) return null
  if (/^https?:\/\//i.test(path)) return path
  if (path.startsWith('/api/')) return BASE + path
  return `${API}${path.startsWith('/') ? '' : '/'}${path}`
}

function apiHeaders(extra = {}) {
  return {
    'User-Agent': UA,
    Accept: 'application/json',
    Referer: `${BASE}/`,
    Origin: BASE,
    ...extra,
  }
}

async function request(path, { method = 'GET', body, signal, timeout = TIMEOUT_MS, proxy = null } = {}) {
  const url = absolute(path)
  const headers = apiHeaders(body !== undefined ? { 'Content-Type': 'application/json' } : {})
  const payload = body !== undefined ? JSON.stringify(body) : undefined
  const timeoutSignal = AbortSignal.timeout(timeout)
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  let agent = null
  try {
    let res
    if (proxy) {
      agent = new ProxyAgent(proxy)
      res = await undiciFetch(url, {
        method,
        headers,
        body: payload,
        signal: combined,
        dispatcher: agent,
        redirect: 'follow',
      })
    } else {
      res = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: combined,
        redirect: 'follow',
      })
    }

    const raw = await res.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    if (!res.ok) {
      const err = data?.error || {}
      throw new Error(err.message || data?.detail || `HTTP ${res.status}`)
    }
    return data
  } finally {
    if (agent) {
      try {
        await agent.close()
      } catch {}
    }
  }
}

function normalizeProxyLine(line) {
  let p = String(line || '').trim()
  if (!p || p.startsWith('#')) return null
  if (!/^https?:\/\//i.test(p)) p = `http://${p}`
  const m = p.match(/^https?:\/\/([^/\s]+)$/)
  if (!m) return null
  const hostPort = m[1].split('@').pop()
  const parts = hostPort.split(':')
  if (parts.length !== 2) return null
  const [host, port] = parts
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null
  if (!/^\d{2,5}$/.test(port)) return null
  return p
}

async function refreshProxyCandidates(force = false) {
  if (!force && proxyCandidates.length && Date.now() - proxyCandidatesAt < PROXY_CACHE_MS) {
    return proxyCandidates
  }
  if (proxyFetching) return proxyFetching

  proxyFetching = (async () => {
    const all = new Set()

    await Promise.allSettled(
      PROXY_SOURCES.map(async (src) => {
        try {
          const res = await fetch(src, {
            headers: { 'User-Agent': UA, Accept: 'text/plain,*/*' },
            signal: AbortSignal.timeout(12_000),
          })
          if (!res.ok) return
          const text = await res.text()
          for (const line of text.split(/\r?\n/)) {
            const p = normalizeProxyLine(line)
            if (p) all.add(p)
          }
        } catch {}
      })
    )

    try {
      const res = await fetch(PROXY_API, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        const list = await res.json()
        if (Array.isArray(list)) {
          for (const item of list) {
            const parts = String(item || '').split(':')
            if (parts.length !== 4) continue
            const [host, port, user, pass] = parts
            if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !/^\d{2,5}$/.test(port)) continue
            all.add(`http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`)
          }
        }
      }
    } catch {}

    proxyCandidates = shuffle([...all]).slice(0, 600)
    proxyCandidatesAt = Date.now()
    return proxyCandidates
  })().finally(() => {
    proxyFetching = null
  })

  return proxyFetching
}

async function probeProxy(proxy) {
  try {
    const data = await request('/search?q=probe', { proxy, timeout: PROXY_PROBE_TIMEOUT_MS })
    return Array.isArray(data?.sections)
  } catch {
    return false
  }
}

async function ensureAliveProxy() {
  const reusable = aliveProxies.find((e) => e.remaining === null || e.remaining > 0)
  if (reusable) return reusable

  let refreshed = false
  while (true) {
    const candidates = (await refreshProxyCandidates(refreshed)).filter(
      (p) => !deadProxies.has(p) && !aliveProxies.some((e) => e.proxy === p)
    )

    if (!candidates.length) {
      if (refreshed) return null
      refreshed = true
      continue
    }

    for (let i = 0; i < candidates.length; i += PROXY_PROBE_BATCH) {
      const batch = candidates.slice(i, i + PROXY_PROBE_BATCH)
      const checked = await Promise.all(
        batch.map(async (proxy) => ({ proxy, ok: await probeProxy(proxy) }))
      )

      for (const item of checked) {
        if (!item.ok) {
          deadProxies.add(item.proxy)
          continue
        }
        const entry = { proxy: item.proxy, remaining: null }
        aliveProxies.push(entry)
        if (aliveProxies.length >= 3) return aliveProxies[0]
      }
      if (aliveProxies.length) return aliveProxies[0]
    }

    if (refreshed) return null
    refreshed = true
  }
}

function dropAliveProxy(proxy) {
  const i = aliveProxies.findIndex((e) => e.proxy === proxy)
  if (i >= 0) aliveProxies.splice(i, 1)
}

function isQuotaBlocked(job) {
  const remaining = Number(job?.quota_remaining)
  const dropped = Number(job?.quota_dropped)
  return (
    job?.quota_limited === true ||
    (Number.isFinite(remaining) && remaining <= 0 && dropped > 0) ||
    Number(job?.total) === 0
  )
}

function normalizeTrack(t, fallbackUrl = null) {
  const artists = Array.isArray(t?.artists)
    ? t.artists.map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean)
    : t?.subtitle
      ? [t.subtitle]
      : []

  return {
    id: t?.id || null,
    title: t?.title || 'Unknown',
    artists,
    album: t?.album || t?.album_artist || null,
    durationMs: Number(t?.duration_ms) || 0,
    cover: t?.cover || null,
    url: t?.url || (t?.id ? `https://open.spotify.com/track/${t.id}` : fallbackUrl),
  }
}

/**
 * Cari lagu di SpotMP3.
 * @param {string} query Judul lagu / artis.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ok:true, query:string, tracks:Array, artists:Array, albums:Array} | {ok:false, error:string}>}
 */
export async function search(query, { signal } = {}) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, error: 'Query kosong.' }

  try {
    const data = await request(`/search?q=${encodeURIComponent(q)}`, { signal })
    const sections = Array.isArray(data?.sections) ? data.sections : []
    const trackSection = sections.find((s) => s?.type === 'track')
    const tracks = (trackSection?.items || []).map((t) => normalizeTrack(t))
    const artistSection = sections.find((s) => s?.type === 'artist')
    const albumSection = sections.find((s) => s?.type === 'album')

    return {
      ok: true,
      query: data?.query || q,
      tracks,
      artists: artistSection?.items || [],
      albums: albumSection?.items || [],
    }
  } catch (err) {
    return { ok: false, error: err.message || 'Gagal mencari lagu.' }
  }
}

/**
 * Resolve link Spotify jadi daftar track.
 * @param {string} url Link track / album / playlist / artist.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ok:true, type:string, id:string, title:string, subtitle:string|null, url:string, cover:string|null, totalTracks:number, complete:boolean, tracks:Array} | {ok:false, error:string}>}
 */
export async function resolve(url, { signal } = {}) {
  const u = String(url || '').trim()
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'Link harus diawali http:// atau https://' }

  try {
    const data = await request('/resolve', {
      method: 'POST',
      body: { url: u, limit: 100 },
      signal,
      timeout: 45_000,
    })
    const tracks = Array.isArray(data?.tracks) ? data.tracks.map((t) => normalizeTrack(t, u)) : []
    if (!tracks.length) return { ok: false, error: 'Link tidak berisi track yang bisa diunduh.' }

    return {
      ok: true,
      type: data?.type || 'track',
      id: data?.id || null,
      title: data?.title || tracks[0]?.title || 'Spotify',
      subtitle: data?.subtitle || null,
      url: data?.url || u,
      cover: data?.cover || tracks[0]?.cover || null,
      totalTracks: Number(data?.total_tracks) || tracks.length,
      complete: data?.complete !== false,
      tracks,
    }
  } catch (err) {
    return { ok: false, error: err.message || 'Gagal resolve link Spotify.' }
  }
}

/**
 * Buat job download MP3.
 * @param {string} url URL koleksi / `tracklist:<judul>`.
 * @param {string[]} [trackIds] Track yang dipilih (kosong = semua, maks 100).
 * @param {{ lyrics?: boolean, confirmLarge?: boolean, title?: string, forceProxy?: boolean, signal?: AbortSignal }} [opts]
 * @returns {Promise<{job_id:string, status:string, total:number, events_url:string, job_url:string, quota_limited:boolean, quota_dropped:number, quota_remaining:number}>}
 */
export async function createJob(url, trackIds = [], opts = {}) {
  const body = {
    lyrics: opts.lyrics === true,
    confirm_large: opts.confirmLarge === true,
  }

  if (String(url).startsWith('tracklist:')) {
    body.track_urls = trackIds.map((id) => `https://open.spotify.com/track/${id}`)
    if (opts.title) body.title = opts.title
  } else {
    body.url = url
    if (trackIds.length) body.track_ids = trackIds
  }

  let fallback = null

  // IP utama dulu (paling cepat). Kalau kuota habis → rotasi proxy.
  if (!opts.forceProxy && (directQuota === null || directQuota > 0)) {
    try {
      const job = await request('/jobs', {
        method: 'POST',
        body,
        signal: opts.signal,
        timeout: 45_000,
      })

      const remaining = Number(job?.quota_remaining)
      if (Number.isFinite(remaining)) directQuota = remaining
      if (!isQuotaBlocked(job)) return job

      directQuota = 0
      fallback = job
    } catch (err) {
      if (opts.signal?.aborted) throw err
      // network error / IP diblok → lanjut proxy
    }
  }

  try {
    return await createJobViaProxy(body, { signal: opts.signal })
  } catch (err) {
    if (fallback) return fallback
    throw err
  }
}

/**
 * Buat job lewat proxy hidup (rotasi IP). Proxy mati/kuota habis dibuang,
 * lalu coba proxy berikutnya.
 * @param {object} body Payload POST /jobs.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<object>}
 */
async function createJobViaProxy(body, { signal } = {}) {
  let lastErr = null

  for (let attempt = 0; attempt < PROXY_JOB_TRIES; attempt++) {
    const entry = await ensureAliveProxy()
    if (!entry) break

    try {
      const job = await request('/jobs', {
        method: 'POST',
        body,
        proxy: entry.proxy,
        timeout: PROXY_JOB_TIMEOUT_MS,
        signal,
      })

      const remaining = Number(job?.quota_remaining)
      if (isQuotaBlocked(job)) {
        entry.remaining = 0
        dropAliveProxy(entry.proxy)
        lastErr = new Error('Kuota proxy habis.')
        continue
      }

      if (Number.isFinite(remaining)) {
        entry.remaining = remaining
        if (remaining <= 0) dropAliveProxy(entry.proxy)
      }
      return job
    } catch (err) {
      if (signal?.aborted) throw err
      dropAliveProxy(entry.proxy)
      deadProxies.add(entry.proxy)
      lastErr = err
    }
  }

  throw lastErr || new Error('Tidak ada proxy hidup untuk membuat job.')
}

/**
 * Ambil status job.
 * @param {string} jobIdOrUrl ID job atau path `/api/v1/jobs/...`.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<object>}
 */
export async function getJob(jobIdOrUrl, { signal } = {}) {
  const id = String(jobIdOrUrl || '').trim()
  if (!id) throw new Error('Job ID kosong.')
  const path = /^https?:\/\/|^\/api\//.test(id) ? id : `/jobs/${id}`
  return request(path, { signal })
}

/**
 * Tunggu job sampai selesai (completed/partial/failed/cancelled).
 * @param {string} jobIdOrUrl
 * @param {{ timeoutMs?: number, intervalMs?: number, signal?: AbortSignal, onPoll?: (job:object)=>void }} [opts]
 * @returns {Promise<object>} Job final.
 */
export async function waitForJob(jobIdOrUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 150_000
  const intervalMs = opts.intervalMs ?? 2_500
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const job = await getJob(jobIdOrUrl, { signal: opts.signal })
    if (typeof opts.onPoll === 'function') {
      try { opts.onPoll(job) } catch {}
    }
    if (DONE_STATUS.has(job?.status)) return job
    await sleep(intervalMs)
  }

  throw new Error('Timeout menunggu proses download (server terlalu lama).')
}

/**
 * Ambil buffer audio dari job yang sudah selesai.
 * @param {object} job Job final dari waitForJob().
 * @param {string} [trackId] ID track yang dipilih.
 * @param {{ maxBytes?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{buffer:Buffer, track:object, filename:string|null}>}
 */
export async function downloadTrack(job, trackId, opts = {}) {
  const tracks = Array.isArray(job?.tracks) ? job.tracks : []
  const track = (trackId && tracks.find((t) => t.id === trackId)) || tracks.find((t) => t.status === 'completed') || tracks[0]
  if (!track) throw new Error('Track tidak ditemukan di job.')
  if (track.status !== 'completed' || !track.download_url) {
    throw new Error(track.error || 'Track gagal diproses.')
  }

  const maxBytes = opts.maxBytes ?? MAX_AUDIO_BYTES
  const res = await fetch(absolute(track.download_url), {
    headers: { 'User-Agent': UA, Accept: '*/*', Referer: `${BASE}/` },
    redirect: 'follow',
    signal: opts.signal || AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Download HTTP ${res.status}`)

  const declared = Number(res.headers.get('content-length') || 0)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('Audio terlalu besar untuk WhatsApp (>16MB).')
  }

  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length > maxBytes) throw new Error('Audio terlalu besar untuk WhatsApp (>16MB).')

  return { buffer, track, filename: track.filename || null }
}

/**
 * Ambil lirik track (format LRC) dari job.
 * @param {object} job Job final.
 * @param {string} [trackId]
 * @returns {Promise<string|null>}
 */
export async function getLyrics(job, trackId) {
  const tracks = Array.isArray(job?.tracks) ? job.tracks : []
  const track = (trackId && tracks.find((t) => t.id === trackId)) || tracks[0]
  if (!track?.lyrics_url) return null

  try {
    const res = await fetch(absolute(track.lyrics_url), {
      headers: { 'User-Agent': UA, Accept: 'text/plain,*/*', Referer: `${BASE}/` },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

/**
 * Daftar sumber audio alternatif untuk sebuah track.
 * @param {string} trackId
 * @param {string} [query]
 * @returns {Promise<Array>}
 */
export async function getSources(trackId, query = '') {
  const id = String(trackId || '').trim()
  if (!id) return []
  const q = query ? `?q=${encodeURIComponent(query)}` : ''
  const data = await request(`/tracks/${encodeURIComponent(id)}/sources${q}`)
  return Array.isArray(data?.items) ? data.items : []
}
