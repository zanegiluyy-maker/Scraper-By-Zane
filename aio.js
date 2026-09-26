/**
 * Name : DownVideo Scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://downvideo.me/en/
 * Type : Scraper
 * Function : all in one video downloader
 * Note : DownVideo + official YouTube, TikTok, dan Instagram fallback.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
export const BASE_URL = 'https://downvideo.me'
export const FORMATS = Object.freeze(['downvideo', 'youtube', 'tiktok', 'instagram'])
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const BOT = /just a moment|cf-chl|verify you are human|checking your browser|bot detected|access denied/i
const RETRY = new Set([408, 425, 429, 500, 502, 503, 504])
const YT_CLIENTS = [
  ['ANDROID', '3', '20.10.38', 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip', { androidSdkVersion: 35, osName: 'Android', osVersion: '14' }],
  ['IOS', '5', '20.10.4', 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_3 like Mac OS X)', { deviceMake: 'Apple', deviceModel: 'iPhone16,2' }],
]
export class DownVideoScraperError extends Error {
  constructor(message, { code = 'SCRAPER_ERROR', status, cause, retryable = false } = {}) {
    super(message, { cause })
    this.name = 'DownVideoScraperError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}
const text = (v) => typeof v === 'string' && v.trim() ? v.trim() : ''
const int = (v, fallback, min, max) => Math.max(min, Math.min(max, Math.round(Number(v ?? fallback) || fallback)))
const wait = (ms, signal) => sleep(ms, undefined, { signal }).catch((cause) => { throw new DownVideoScraperError('Proses dibatalkan', { code: 'ABORTED', cause }) })
const bytes = (n) => {
  if (!n) return ''
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 3)
  return `${(n / 1024 ** i).toFixed(i ? 2 : 0)} ${['B', 'KB', 'MB', 'GB'][i]}`
}
function log(client, level, message, meta = {}) {
  if (!client.logger) return
  try { client.logger({ level, message, timestamp: new Date().toISOString(), ...meta }) } catch { return }
}
function urlOf(value) {
  try {
    const url = new URL(String(value))
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol')
    return url
  } catch (cause) { throw new DownVideoScraperError('URL tidak valid', { code: 'INVALID_INPUT', cause }) }
}
function jar() {
  const store = new Map()
  return {
    save: (response, source) => {
      const host = new URL(response.url || source).hostname
      for (const raw of response.headers.getSetCookie?.() || []) {
        const pair = raw.split(';')[0], split = pair.indexOf('=')
        if (split < 1) continue
        const domain = raw.match(/(?:^|;\s*)domain=([^;]+)/i)?.[1]?.toLowerCase() || host
        store.set(pair.slice(0, split), { value: pair.slice(split + 1), domain })
      }
    },
    header: (value) => {
      const host = new URL(value).hostname
      return [...store].filter(([, c]) => host === c.domain || host.endsWith(c.domain)).map(([k, c]) => `${k}=${c.value}`).join('; ')
    },
    value: (name) => store.get(name)?.value || '',
  }
}
function client(options = {}, baseUrl = BASE_URL, userAgent = UA) {
  return {
    baseUrl: String(baseUrl).replace(/\/+$/, ''), userAgent: String(options.userAgent || userAgent), jar: jar(),
    timeout: int(options.requestTimeoutMs, 60_000, 1000, 300_000), retries: int(options.retries, 2, 0, 5),
    signal: options.signal, logger: typeof options.logger === 'function' ? options.logger : null,
  }
}
function headers(c, { text = false, page = false, cookies = true, extra = {} } = {}) {
  const cookie = cookies ? c.jar.header(c.baseUrl) : ''
  return {
    Accept: text ? 'text/html,application/xhtml+xml' : 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9', Referer: `${c.baseUrl}/`, 'User-Agent': c.userAgent,
    'Cache-Control': 'no-cache', Pragma: 'no-cache', ...(page ? {} : { Origin: c.baseUrl }),
    'Sec-Fetch-Dest': page ? 'document' : 'empty', 'Sec-Fetch-Mode': page ? 'navigate' : 'cors', 'Sec-Fetch-Site': page ? 'none' : 'same-origin',
    ...(cookie ? { Cookie: cookie } : {}), ...extra,
  }
}
async function request(c, value, label, { json = true, page = false, cookies = true, method = 'GET', body, extra = {} } = {}) {
  const url = urlOf(value)
  for (let attempt = 0; attempt <= c.retries; attempt += 1) {
    const timeout = AbortSignal.timeout(c.timeout)
    try {
      const response = await fetch(url, { method, body, redirect: 'follow', headers: headers(c, { text: !json, page, cookies, extra }), signal: c.signal ? AbortSignal.any([c.signal, timeout]) : timeout })
      c.jar.save(response, url)
      const content = await response.text()
      if (BOT.test(content.slice(0, 20_000))) throw new DownVideoScraperError('Proteksi browser terdeteksi', { code: 'BOT_CHALLENGE', status: response.status })
      if (!response.ok) {
        const error = new DownVideoScraperError(`${label}: HTTP ${response.status} ${content.replace(/\s+/g, ' ').slice(0, 160)}`, { code: `HTTP_${response.status}`, status: response.status, retryable: RETRY.has(response.status) })
        error.retryAfter = Number(response.headers.get('retry-after')) || 0
        throw error
      }
      if (!json) return content
      try { return JSON.parse(content) } catch (cause) { throw new DownVideoScraperError(`${label}: JSON tidak valid`, { code: 'INVALID_JSON', cause }) }
    } catch (cause) {
      if (c.signal?.aborted) throw new DownVideoScraperError(`${label} dibatalkan`, { code: 'ABORTED', cause })
      const error = cause instanceof DownVideoScraperError ? cause : new DownVideoScraperError(`${label}: ${cause.message}`, { code: cause.name === 'TimeoutError' ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', cause, retryable: true })
      if (!error.retryable || attempt === c.retries) throw error
      log(c, 'warn', 'retry', { label, code: error.code, attempt: attempt + 1 })
      await wait(error.retryAfter ? Math.min(error.retryAfter * 1000, 5000) : 1000 * 2 ** attempt, c.signal)
    }
  }
}
async function expand(value, c) {
  const url = urlOf(value), host = url.hostname
  const short = ['vt.tiktok.com', 'vm.tiktok.com', 'instagr.am'].includes(host) || (host === 'www.tiktok.com' && url.pathname.startsWith('/t/'))
  if (!short) return url.toString()
  const response = await fetch(url, { redirect: 'follow', headers: { Accept: 'text/html', 'User-Agent': PHONE_UA } })
  c.jar.save(response, url)
  await response.body?.cancel()
  if (!response.ok) throw new DownVideoScraperError(`Short link HTTP ${response.status}`, { code: `HTTP_${response.status}` })
  return response.url || url.toString()
}
async function probe(media, c, referer) {
  const url = urlOf(media.url), cookie = c.jar.header(url)
  const response = await fetch(url, { redirect: 'follow', headers: { Accept: '*/*', Range: 'bytes=0-0', Referer: referer, 'User-Agent': c.userAgent, ...(cookie ? { Cookie: cookie } : {}) } })
  c.jar.save(response, url)
  const type = (response.headers.get('content-type') || '').toLowerCase(), size = Number(response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]) || media.size || 0
  await response.body?.cancel()
  if (!response.ok || (!type.includes('video') && !type.includes('audio') && response.status !== 206)) throw new DownVideoScraperError(`Media HTTP ${response.status}`, { code: 'MEDIA_FORBIDDEN', status: response.status })
  const requestHeaders = { Referer: referer, 'User-Agent': c.userAgent, ...(cookie ? { Cookie: cookie } : {}) }
  return { ...media, size, formattedSize: media.formattedSize || bytes(size), contentType: type, verified: true, requestHeaders }
}
async function downvideoData(value, c) {
  const url = new URL('/wp-json/aio-dl/api', `${c.baseUrl}/`)
  url.searchParams.set('url', value)
  try { return await request(c, url, 'DownVideo API') } catch (error) {
    if (['BOT_CHALLENGE', 'HTTP_400', 'HTTP_429'].includes(error.code)) throw error
    const html = await request(c, `${c.baseUrl}/en/`, 'Token DownVideo', { json: false, page: true })
    const token = html.match(/id="token"[^>]*value="([a-f0-9]{64})"/i)?.[1]
    if (!token) throw new DownVideoScraperError('Token DownVideo tidak ditemukan', { code: 'TOKEN_MISSING' })
    const body = new URLSearchParams({ url: value, token })
    return request(c, new URL('/wp-json/aio-dl/video-data', `${c.baseUrl}/`), 'DownVideo token', { method: 'POST', body, extra: { 'Content-Type': 'application/x-www-form-urlencoded' } })
  }
}
async function tiktokData(value, options) {
  const c = client(options, 'https://www.tiktok.com', PHONE_UA), pageUrl = urlOf(value)
  pageUrl.search = ''
  let item = null, verified = []
  for (let attempt = 0; attempt < Math.min(c.retries + 3, 6) && !item?.video; attempt += 1) {
    pageUrl.searchParams.set('lang', 'en'); pageUrl.searchParams.set('_region', 'US'); pageUrl.searchParams.set('_ts', Date.now())
    const html = await request(c, pageUrl, 'TikTok', { json: false, page: true, cookies: false })
    const raw = html.match(/<script[^>]+id=["']api-data["'][^>]*>([\s\S]*?)<\/script>/)?.[1]
    try { item = raw ? JSON.parse(raw)?.videoDetail?.itemInfo?.itemStruct : null } catch { item = null }
    if (item) {
      const versions = [...(item.video.bitrateInfo || []).map((v) => [v.PlayAddr?.Url, v.gear_name || 'video']), [item.video.downloadAddr, 'no-watermark'], [item.video.playAddr, 'play']]
      const unique = [...new Map(versions.filter(([u]) => u).map((v) => [v[0], v])).values()]
      verified = []
      for (const [mediaUrl, quality] of unique) { try { verified.push(await probe({ url: mediaUrl, quality, size: 0, formattedSize: '' }, c, 'https://www.tiktok.com/')) } catch { continue } }
    }
    if (attempt + 1 < Math.min(c.retries + 3, 6)) await wait(300 + attempt * 200, c.signal)
  }
  if (!verified.length) throw new DownVideoScraperError('Media TikTok tidak tersedia', { code: 'TIKTOK_MEDIA_UNAVAILABLE' })
  return { title: text(item.desc) || 'TikTok', author: text(item.author?.uniqueId), thumbnail: text(item.video.cover), duration: Number(item.video.duration) || null, source: 'tiktok', sid: null, medias: verified.map((m) => ({ ...m, extension: 'mp4', videoAvailable: true, audioAvailable: true })) }
}
async function instagramData(value, options) {
  const c = client(options, 'https://www.instagram.com'), code = urlOf(value).pathname.match(/\/(?:p|reel|reels|tv)\/([^/?]+)/i)?.[1]
  if (!code) throw new DownVideoScraperError('Shortcode Instagram tidak ditemukan', { code: 'INVALID_INPUT' })
  let item = null
  for (let attempt = 0; attempt < Math.min(c.retries + 2, 5) && !item; attempt += 1) {
    await request(c, `${c.baseUrl}/`, 'Instagram CSRF', { json: false, page: true, cookies: false })
    const csrf = c.jar.value('csrftoken')
    const body = new URLSearchParams({ variables: JSON.stringify({ shortcode: code, __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false }), doc_id: '27128499623469141', server_timestamps: 'true' })
    const data = await request(c, `${c.baseUrl}/graphql/query`, 'Instagram GraphQL', { method: 'POST', body, extra: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-IG-App-ID': '936619743392459', 'X-CSRFToken': csrf, Referer: `${c.baseUrl}/p/${code}/` } })
    item = data?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0] || null
    if (!item) await wait(350 + attempt * 250, c.signal)
  }
  if (!item) throw new DownVideoScraperError('Media Instagram tidak publik', { code: 'INSTAGRAM_DATA_MISSING' })
  const unique = [...new Map((item.video_versions || []).filter((v) => v.url).map((v) => [v.url, { url: v.url, quality: `${v.width || ''}x${v.height || ''}`, size: 0, formattedSize: '' }])).values()]
  const verified = []
  for (const media of unique) { try { verified.push(await probe(media, c, 'https://www.instagram.com/')) } catch { continue } }
  if (!verified.length) throw new DownVideoScraperError('Media Instagram tidak valid', { code: 'INSTAGRAM_MEDIA_UNAVAILABLE' })
  return { title: text(item.caption?.text) || `Instagram ${code}`, author: text(item.user?.username), thumbnail: text(item.image_versions2?.candidates?.[0]?.url), duration: Number(item.video_duration) || null, source: 'instagram', sid: null, medias: verified.map((m) => ({ ...m, extension: 'mp4', videoAvailable: true, audioAvailable: true })) }
}
function youtubeFormat(f) {
  const mime = text(f.mimeType), audioCodec = /mp4a|opus|vorbis/i.test(mime), size = Number(f.contentLength) || 0
  return { url: text(f.url), quality: text(f.qualityLabel) || text(f.audioQuality) || 'source', extension: mime.includes('audio/mp4') ? 'm4a' : mime.includes('webm') ? 'webm' : 'mp4', size, formattedSize: bytes(size), bitrate: Number(f.averageBitrate || f.bitrate) || 0, videoAvailable: f.hasVideo !== false && !mime.startsWith('audio/'), audioAvailable: f.hasAudio !== false && (!mime.startsWith('video/') || audioCodec) }
}
async function youtubeData(value, options) {
  const c = client(options, 'https://www.youtube.com'), id = urlOf(value).searchParams.get('v') || urlOf(value).pathname.split('/').filter(Boolean).pop()
  if (!/^[\w-]{11}$/.test(id || '')) throw new DownVideoScraperError('Video ID YouTube tidak valid', { code: 'INVALID_INPUT' })
  const html = await request(c, `https://www.youtube.com/watch?v=${id}&hl=en`, 'YouTube', { json: false, page: true, cookies: false })
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', visitor = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] || ''
  let player = null
  for (const [name, cid, version, ua, extra] of YT_CLIENTS) {
    const data = await request(c, `https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`, 'YouTube InnerTube', { method: 'POST', body: JSON.stringify({ context: { client: { clientName: name, clientVersion: version, hl: 'en', gl: 'ID', visitorData: visitor, ...extra } }, videoId: id, contentCheckOk: true, racyCheckOk: true }), extra: { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': cid, 'X-YouTube-Client-Version': version, 'User-Agent': ua, Referer: `https://www.youtube.com/watch?v=${id}`, ...(visitor ? { 'X-Goog-Visitor-Id': visitor } : {}) } })
    if (data.playabilityStatus?.status === 'OK') { player = data; break }
  }
  if (!player?.streamingData) throw new DownVideoScraperError('Video YouTube tidak tersedia', { code: 'YOUTUBE_UNAVAILABLE' })
  const muxed = (player.streamingData.formats || []).filter((f) => f.url).map(youtubeFormat)
  const adaptive = (player.streamingData.adaptiveFormats || []).filter((f) => f.url).map(youtubeFormat)
  const audio = adaptive.filter((m) => !m.videoAvailable).sort((a, b) => b.bitrate - a.bitrate)
  const video = adaptive.filter((m) => m.videoAvailable && !m.audioAvailable).sort((a, b) => b.size - a.size)
  const selected = [...new Map([...muxed, audio[0], video[0]].filter(Boolean).map((m) => [m.url, m])).values()]
  const verified = []
  for (const media of selected) { try { verified.push(await probe(media, c, 'https://www.youtube.com/')) } catch { continue } }
  if (!verified.some((m) => m.videoAvailable && m.audioAvailable)) throw new DownVideoScraperError('Format YouTube tidak valid', { code: 'YOUTUBE_MEDIA_UNAVAILABLE' })
  const thumbs = player.videoDetails?.thumbnail?.thumbnails || []
  return { title: text(player.videoDetails?.title), author: text(player.videoDetails?.author), thumbnail: text(thumbs.at(-1)?.url), duration: Number(player.videoDetails?.lengthSeconds) || null, source: 'youtube', sid: null, medias: verified }
}
function normalize(data, value, baseUrl, service) {
  const proxy = service === 'downvideo'
  const medias = (data.medias || []).map((m, index) => {
    const id = Buffer.from(String(index)).toString('base64'), url = text(m.url), download = proxy ? new URL('/wp-content/plugins/aio-video-downloader/download.php', `${baseUrl}/`) : null
    if (download) { download.searchParams.set('source', data.source); download.searchParams.set('media', id); if (data.sid) download.searchParams.set('sid', data.sid) }
    const extension = text(m.extension).toLowerCase()
    return { index, id, quality: text(m.quality), extension, size: Number(m.size) || 0, formattedSize: text(m.formattedSize), videoAvailable: m.videoAvailable !== false, audioAvailable: m.audioAvailable !== false, isAudio: (!m.videoAvailable && m.audioAvailable) || ['mp3', 'm4a', 'aac', 'opus'].includes(extension), verified: Boolean(m.verified), contentType: text(m.contentType) || null, requestHeaders: m.requestHeaders || null, requiresMuxing: m.videoAvailable !== false && m.audioAvailable === false, directUrl: url, downloadUrl: url, proxyUrl: download?.toString() || null }
  }).filter((m) => m.directUrl)
  if (!medias.length) throw new DownVideoScraperError('Media tidak ditemukan', { code: 'NO_MEDIA' })
  const videos = medias.filter((m) => m.videoAvailable).sort((a, b) => b.size - a.size), muxed = videos.filter((m) => m.audioAvailable), only = videos.filter((m) => !m.audioAvailable)
  const thumbnail = text(data.thumbnail)
  return { ok: true, service, originalUrl: value, title: text(data.title) || 'Tanpa judul', author: text(data.author) || null, thumbnail: thumbnail.startsWith('data:') ? null : thumbnail || null, duration: data.duration ?? null, source: text(data.source), count: medias.length, medias, bestVideo: muxed[0] || videos[0] || null, bestVideoOnly: only[0] || null, bestAudio: medias.filter((m) => m.isAudio).sort((a, b) => b.size - a.size)[0] || null }
}
async function choose(primary, secondary, service) {
  try { return { data: await primary(), service } } catch (first) {
    log(secondary.client, 'warn', 'primary failed', { code: first.code })
    try { return { data: await secondary.run(), service: 'downvideo' } } catch (second) { throw new DownVideoScraperError(`${first.message}; ${second.message}`, { code: first.code, cause: second }) }
  }
}
function isPlatform(url, hosts, path) {
  const value = urlOf(url)
  return hosts.some((h) => value.hostname === h || value.hostname.endsWith(`.${h}`)) && (!path || path.test(value.pathname))
}
/**
 * Scrape link video dari DownVideo dengan fallback platform resmi.
 * @param {string} videoUrl - URL video
 * @param {{baseUrl?:string,userAgent?:string,retries?:number,requestTimeoutMs?:number,signal?:AbortSignal,logger?:Function}} [options]
 * @returns {Promise<object>}
 */
export async function downvideoDl(videoUrl, options = {}) {
  const c = client(options)
  try {
    const value = await expand(videoUrl, c)
    let picked
    if (isPlatform(value, ['youtube.com'], /^\/(watch|shorts|live|embed)/) || urlOf(value).hostname === 'youtu.be') picked = await choose(() => youtubeData(value, options), { run: () => downvideoData(value, c), client: c }, 'downvideo-youtube-fallback')
    else if (isPlatform(value, ['instagram.com', 'instagr.am'], /^\/(p|reel|reels|tv)\//)) picked = await choose(() => instagramData(value, options), { run: () => downvideoData(value, c), client: c }, 'downvideo-instagram-fallback')
    else if (isPlatform(value, ['tiktok.com'], /^\/(@[^/]+\/video\/|v\/|t\/)/)) picked = await choose(() => tiktokData(value, options), { run: () => downvideoData(value, c), client: c }, 'downvideo-tiktok-fallback')
    else picked = { data: await downvideoData(value, c), service: 'downvideo' }
    return normalize(picked.data, value, c.baseUrl, picked.service)
  } catch (error) {
    const messages = { BOT_CHALLENGE: 'Proteksi browser tidak dapat dilewati.', HTTP_403: 'Akses ditolak.', HTTP_429: 'Rate limit tercapai.', TIKTOK_MEDIA_UNAVAILABLE: 'Media TikTok tidak tersedia.', INSTAGRAM_DATA_MISSING: 'Media Instagram tidak publik.', YOUTUBE_UNAVAILABLE: 'Video YouTube tidak tersedia.' }
    return { ok: false, why: m