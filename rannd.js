/**
 * Name : RannD Rocketune Scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://rannd.my.id/player/
 * Type : Scraper
 * Function : rocketune music search, playlist, stream, lyrics
 * Note : Stream memakai relay resmi RannD, error fix sendiri.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
export const BASE_URL = 'https://rannd.my.id/player/'
const DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const BOT_RE = /just a moment|cf-chl|verify you are human|checking your browser|bot detected/i
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
export class RannDScraperError extends Error {
  constructor(message, { code = 'SCRAPER_ERROR', status, cause, retryable = false } = {}) {
    super(message, { cause })
    this.name = 'RannDScraperError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}
const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : ''
const integer = (value, fallback, min, max) => {
  const parsed = Number(value ?? fallback)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback
}
const wait = (ms, signal) => sleep(ms, undefined, { signal }).catch((cause) => {
  throw new RannDScraperError('Proses dibatalkan', { code: 'ABORTED', cause })
})
const requestSignal = (options) => options.signal
  ? AbortSignal.any([options.signal, AbortSignal.timeout(options.requestTimeoutMs)])
  : AbortSignal.timeout(options.requestTimeoutMs)
function endpoint(action, params = {}, baseUrl = BASE_URL) {
  const url = new URL(baseUrl)
  url.searchParams.set('action', action)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  return url
}
function headers(options) {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Referer: BASE_URL,
    'User-Agent': options.userAgent || DEFAULT_UA,
    Origin: new URL(BASE_URL).origin,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  }
}
function clientOptions(options = {}) {
  return {
    baseUrl: String(options.baseUrl || BASE_URL),
    userAgent: String(options.userAgent || DEFAULT_UA),
    requestTimeoutMs: integer(options.requestTimeoutMs, 60_000, 1000, 300_000),
    retries: integer(options.retries, 2, 0, 5),
    signal: options.signal,
  }
}
async function request(action, params, options, label) {
  const client = clientOptions(options)
  for (let attempt = 0; attempt <= client.retries; attempt += 1) {
    try {
      const response = await fetch(endpoint(action, params, client.baseUrl), {
        headers: headers(client),
        redirect: 'follow',
        signal: requestSignal(client),
      })
      const body = await response.text()
      if (BOT_RE.test(body)) throw new RannDScraperError('RannD meminta verifikasi browser', { code: 'BOT_CHALLENGE', status: response.status })
      if (!response.ok) {
        const error = new RannDScraperError(`${label} gagal dengan HTTP ${response.status}`, {
          code: `HTTP_${response.status}`,
          status: response.status,
          retryable: RETRY_STATUS.has(response.status),
        })
        error.retryAfter = Number(response.headers.get('retry-after')) || 0
        throw error
      }
      try { return JSON.parse(body) } catch (cause) {
        throw new RannDScraperError(`${label} menghasilkan JSON tidak valid`, { code: 'INVALID_JSON', cause })
      }
    } catch (cause) {
      if (options.signal?.aborted) throw new RannDScraperError(`${label} dibatalkan`, { code: 'ABORTED', cause })
      const error = cause instanceof RannDScraperError ? cause : new RannDScraperError(`${label} gagal: ${cause.message}`, {
        code: cause.name === 'TimeoutError' ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
        cause,
        retryable: true,
      })
      if (!error.retryable || attempt === client.retries) throw error
      await wait(error.retryAfter ? Math.min(error.retryAfter * 1000, 5000) : 1000 * 2 ** attempt, options.signal)
    }
  }
}
function serviceCheck(data, label) {
  if (data?.success !== false) return
  throw new RannDScraperError(text(data.error) || `${label} ditolak`, { code: 'SERVICE_ERROR' })
}
function normalizeTrack(track) {
  return {
    id: text(track.id) || null, videoId: text(track.videoId), title: text(track.title) || 'Tanpa judul',
    artist: text(track.artist) || text((track.artists || [])[0]) || 'Unknown', artists: Array.isArray(track.artists) ? track.artists : [],
    album: text(track.album) || '', duration: text(track.duration) || '', durationSeconds: Number(track.durationSeconds) || 0,
    thumbnail: text(track.thumbnail) || null, youtubeUrl: text(track.youtubeUrl) || null,
    youtubeMusicUrl: text(track.youtubeMusicUrl) || null, source: text(track.source) || 'youtube',
  }
}
function failure(error) {
  const reasons = {
    BOT_CHALLENGE: 'RannD meminta verifikasi browser; proteksi bot tidak dapat dilewati.',
    REQUEST_TIMEOUT: 'Request melewati batas waktu.',
    ABORTED: 'Proses dibatalkan.',
    HTTP_403: 'Akses RannD ditolak.',
    HTTP_429: 'Rate limit RannD tercapai.',
  }
  return { ok: false, why: reasons[error.code] || error.message || 'Gagal scrape RannD.', code: error.code || 'SCRAPER_ERROR' }
}
/**
 * Cari lagu di Rocketune.
 * @param {string} query - Judul atau artis
 * @param {{limit?:number,baseUrl?:string,signal?:AbortSignal}} [options]
 * @returns {Promise<{ok:true,query:string,count:number,tracks:object[]}|{ok:false,why:string}>}
 */
export async function ranndSearch(query, options = {}) {
  const keyword = String(query || '').trim()
  if (!keyword) return { ok: false, why: 'Query pencarian wajib diisi.', code: 'INVALID_INPUT' }
  try {
    const limit = integer(options.limit, 30, 1, 50)
    const data = await request('search', { q: keyword, limit }, options, 'Pencarian RannD')
    serviceCheck(data, 'Pencarian RannD')
    const tracks = (data.tracks || []).map(normalizeTrack).filter((track) => track.videoId)
    return { ok: true, query: keyword, count: tracks.length, tracks }
  } catch (error) {
    return failure(error)
  }
}
export async function ranndPlaylist(playlist, options = {}) {
  const list = String(playlist || '').trim()
  if (!list) return { ok: false, why: 'URL atau ID playlist wajib diisi.', code: 'INVALID_INPUT' }
  try {
    const limit = integer(options.limit, 200, 1, 200)
    const data = await request('playlist', { list, limit }, options, 'Playlist RannD')
    serviceCheck(data, 'Playlist RannD')
    const tracks = (data.tracks || []).map(normalizeTrack).filter((track) => track.videoId)
    return {
      ok: true, playlistId: text(data.playlistId) || list, title: text(data.title) || 'Playlist',
      thumbnail: text(data.thumbnail) || null, trackCount: Number(data.trackCount) || tracks.length,
      count: tracks.length, tracks,
    }
  } catch (error) {
    return failure(error)
  }
}
export async function ranndStream(videoId, options = {}) {
  const id = String(videoId || '').trim()
  if (!/^[\w-]{11}$/.test(id)) return { ok: false, why: 'Video ID YouTube tidak valid.', code: 'INVALID_INPUT' }
  try {
    const data = await request('stream', { videoId: id, _rt: Date.now() }, options, 'Stream RannD')
    serviceCheck(data, 'Stream RannD')
    const streamUrl = text(data.url) || text(data.relayUrl) || text(data.streamUrl)
    if (!streamUrl) throw new RannDScraperError('URL stream RannD tidak ditemukan', { code: 'INVALID_RESPONSE' })
    return {
      ok: true, service: 'rannd-rocketune', videoId: id, title: text(data.title) || '', artist: text(data.artist) || '',
      duration: text(data.duration) || '', durationSeconds: Number(data.durationSeconds) || 0, thumbnail: text(data.thumbnail) || null,
      streamUrl, downloadUrl: streamUrl, directUrl: text(data.directUrl) || null, mimeType: text(data.mimeType) || '',
      contentLength: Number(data.contentLength) || 0, expiresAt: Number(data.expiresAt) || 0,
    }
  } catch (error) {
    return failure(error)
  }
}
export async function ranndLyrics(track, options = {}) {
  const title = text(track?.title)
  if (!title) return { ok: false, why: 'Judul lagu wajib diisi.', code: 'INVALID_INPUT' }
  try {
    const data = await request('lyrics', {
      title,
      artist: text(track.artist),
      album: text(track.album),
      duration: Number(track.durationSeconds) || 0,
    }, options, 'Lirik RannD')
    if (data.ok !== true || !data.data) return { ok: false, why: 'Lirik tidak ditemukan.', code: 'LYRICS_NOT_FOUND' }
    return {
      ok: true, source: text(data.source) || 'rannd', title: text(data.data.title) || title,
      artist: text(data.data.artist) || text(track.artist), syncedLyrics: text(data.data.synced_lyrics),
      plainLyrics: text(data.data.plain_lyrics), instrumental: Boolean(data.data.instrumental),
    }
  } catch (error) {
    return failure(error)
  }
}
function videoIdFrom(input) {
  const value = String(input || '').trim()
  if (/^[\w-]{11}$/.test(value)) return value
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
    const id = url.searchParams.get('v') || url.pathname.split('/').filter(Boolean).pop()
    return /^[\w-]{11}$/.test(id || '') ? id : ''
  } catch {
    return ''
  }
}
/**
 * Cari lagu lalu resolve stream; langsung stream bila input berupa video ID/URL.
 * @param {string} query - Judul, artis, video ID, atau URL YouTube
 * @param {{limit?:number,baseUrl?:string,signal?:AbortSignal}} [options]
 * @returns {Promise<object>}
 */
export async function ranndDl(query, options = {}) {
  try {
    let track = null
    const videoId = videoIdFrom(query)
    if (videoId) track = { videoId, title: '', artist: '' }
    else {
      const search = await ranndSearch(query, options)
      if (!search.ok) return search
      if (!search.count) return { ok: false, why: 'Lagu tidak ditemukan.', code: 'NOT_FOUND' }
      track = search.tracks[0]
    }
    const result = await ranndStream(track.videoId, options)
    return result.ok ? { ...result, query: String(query), track } : result
  } catch (error) {
    return failure(error)
  }
}
export default { ranndSearch, ranndPlaylist, ranndStream, ranndLyrics, ranndDl }
async function cli() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === '--help') return console.log('Usage:\n  node rannd.js search <query> [--limit 30]\n  node rannd.js playlist <url/id> [--limit 200]\n  node rannd.js stream <video-id>\n  node rannd.js lyrics <title> [artist] [album] [duration-seconds]')
  const limitArg = args.findIndex((arg) => arg === '--limit' || arg.startsWith('--limit='))
  const options = limitArg < 0 ? {} : { limit: args[limitArg].includes('=') ? args[limitArg].split('=')[1] : args[limitArg + 1] }
  const positional = args.filter((arg) => !arg.startsWith('--') && arg !== String(options.limit))
  const results = {
    search: () => ranndSearch(positional[0], options),
    playlist: () => ranndPlaylist(positional[0], options),
    stream: () => ranndStream(positional[0], options),
    lyrics: () => ranndLyrics({ title: positional[0], artist: positional[1], album: positional[2], durationSeconds: positional[3] }, options),
  }
  if (!results[command]) return console.error('Command tidak dikenal.'), process.exitCode = 1
  const result = await results[command]()
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli()
