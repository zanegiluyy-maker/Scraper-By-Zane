/**
 * Name : Y2Mate Scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://y2mate.gs
 * Type : Scraper
 * Function : youtube mp3 downloader
 * Note : Support MP3/MP4, error fix sendiri.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
export const BASE_URL = 'https://y2mate.gs'
export const FORMATS = Object.freeze(['mp3', 'mp4'])
const DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const BOT_RE = /just a moment|cf-chl|verify you are human|checking your browser|bot detected|access denied/i
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
export class Y2MateScraperError extends Error {
  constructor(message, { code = 'SCRAPER_ERROR', status, cause, retryable = false } = {}) {
    super(message, { cause })
    this.name = 'Y2MateScraperError'
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
  throw new Y2MateScraperError('Proses dibatalkan', { code: 'ABORTED', cause })
})
function webUrl(value) {
  try {
    const url = new URL(String(value))
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Unsafe URL')
    return url
  } catch (cause) {
    throw new Y2MateScraperError('URL Y2Mate tidak valid', { code: 'INVALID_REMOTE_URL', cause })
  }
}
function withParams(value, params) {
  const url = webUrl(value)
  for (const [key, item] of Object.entries(params)) url.searchParams.set(key, String(item))
  return url
}
function timeoutSignal(parent, timeout) {
  const timer = AbortSignal.timeout(timeout)
  return parent ? AbortSignal.any([parent, timer]) : timer
}
function emit(client, stage, progress, message) {
  try { client.onProgress?.({ stage, progress, message }) } catch { return }
}
function requestHeaders(client, accept, { page = false, extra = {} } = {}) {
  return {
    Accept: accept,
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Referer: BASE_URL,
    'User-Agent': client.userAgent,
    ...(page ? {} : { Origin: new URL(BASE_URL).origin }),
    'Sec-Fetch-Dest': page ? 'document' : 'empty',
    'Sec-Fetch-Mode': page ? 'navigate' : 'cors',
    'Sec-Fetch-Site': page ? 'none' : 'same-origin',
    ...extra,
  }
}
async function request(url, client, label, { json = true, page = false, extra = {} } = {}) {
  for (let attempt = 0; attempt <= client.retries; attempt += 1) {
    try {
      const response = await fetch(webUrl(url), {
        headers: requestHeaders(client, json ? 'application/json, text/plain, */*' : 'text/html, */*', { page, extra }),
        redirect: 'follow',
        signal: timeoutSignal(client.signal, client.requestTimeoutMs),
      })
      const body = await response.text()
      webUrl(response.url || url)
      if (BOT_RE.test(body)) throw new Y2MateScraperError('Y2Mate meminta verifikasi browser', { code: 'BOT_CHALLENGE', status: response.status })
      if (!response.ok) {
        const error = new Y2MateScraperError(`${label} gagal dengan HTTP ${response.status}`, {
          code: `HTTP_${response.status}`, status: response.status, retryable: RETRY_STATUS.has(response.status),
        })
        error.retryAfter = Number(response.headers.get('retry-after')) || 0
        throw error
      }
      if (!json) return body
      try { return JSON.parse(body) } catch (cause) {
        throw new Y2MateScraperError(`${label} menghasilkan JSON tidak valid`, { code: 'INVALID_JSON', cause })
      }
    } catch (cause) {
      if (client.sourceSignal?.aborted) throw new Y2MateScraperError(`${label} dibatalkan`, { code: 'ABORTED', cause })
      const error = cause instanceof Y2MateScraperError ? cause : new Y2MateScraperError(`${label} gagal: ${cause.message}`, {
        code: cause.name === 'TimeoutError' ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', cause, retryable: true,
      })
      if (!error.retryable || attempt === client.retries) throw error
      await wait(error.retryAfter ? Math.min(error.retryAfter * 1000, 5000) : 1000 * 2 ** attempt, client.signal)
    }
  }
}
function serviceCheck(data, label) {
  const raw = data.error ?? data.err ?? 0
  const code = Number(raw)
  if (!Number.isFinite(code) || code <= 0) return
  if (/bot|forbidden|denied/i.test(String(raw))) throw new Y2MateScraperError(`${label}: bot terdeteksi`, { code: 'BOT_CHALLENGE' })
  throw new Y2MateScraperError(`${label} ditolak dengan kode ${raw}`, { code: 'SERVICE_ERROR', status: code })
}
async function discover(client) {
  const html = await request(BASE_URL, client, 'Halaman Y2Mate', { json: false, page: true })
  const apiKey = html.match(/\bapiKey\s*=\s*(['"])([A-Za-z0-9_-]{16,128})\1/)?.[2]
  const scriptSrc = html.match(/<script\b[^>]*\bsrc\s*=\s*(['"])([^'"]*y2mate(?:\.min)?\.js[^'"]*)\1/i)?.[2]
  if (!apiKey || !scriptSrc) throw new Y2MateScraperError('Struktur Y2Mate berubah', { code: 'DISCOVERY_FAILED' })
  const script = await request(new URL(scriptSrc, BASE_URL), client, 'Script Y2Mate', { json: false })
  const encodedHost = script.match(/\bendpoint\s*=\s*atob\(\s*(['"])([A-Za-z0-9+/=]+)\1\s*\)/)?.[2]
  const host = encodedHost ? Buffer.from(encodedHost, 'base64').toString() : 'etacloud.org'
  return { apiKey, apiOrigin: webUrl(`https://eta.${host}`).origin, referrer: new URL(BASE_URL).hostname }
}
async function getJob(initialUrl, videoId, format, client, label) {
  let url = initialUrl
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const data = await request(withParams(url, { v: videoId, f: format, _: Date.now() }), client, label)
    serviceCheck(data, label)
    const title = text(data.title)
    const downloadUrl = text(data.downloadURL)
    if (String(data.status).toLowerCase() === 'download' && downloadUrl) return { type: 'ready', title, downloadUrl }
    if (String(data.redirect) === '1' && text(data.redirectURL)) { url = data.redirectURL; continue }
    if (text(data.progressURL) && downloadUrl) return { type: 'progress', title, progress: Number(data.progress) || 0, progressUrl: data.progressURL, downloadUrl }
    throw new Y2MateScraperError(`${label} tidak mengembalikan status valid`, { code: 'INVALID_RESPONSE' })
  }
  throw new Y2MateScraperError('Terlalu banyak redirect', { code: 'TOO_MANY_REDIRECTS' })
}
async function primary(site, videoId, format, client) {
  const authUrl = new URL('/api/v1/auth', `${site.apiOrigin}/`)
  authUrl.searchParams.set('api_key', site.apiKey)
  authUrl.searchParams.set('_', Date.now())
  const auth = await request(authUrl, client, 'Auth Y2Mate')
  serviceCheck(auth, 'Auth Y2Mate')
  if (!text(auth.key)) throw new Y2MateScraperError('Token Y2Mate tidak ditemukan', { code: 'AUTH_FAILED' })
  const initUrl = new URL('/api/v1/init', `${site.apiOrigin}/`)
  initUrl.searchParams.set('_', Date.now())
  const init = await request(initUrl, client, 'Init Y2Mate', { extra: { Authorization: `Bearer ${auth.key}` } })
  serviceCheck(init, 'Init Y2Mate')
  if (!text(init.convertURL)) throw new Y2MateScraperError('URL convert tidak ditemukan', { code: 'INVALID_RESPONSE' })
  return { job: await getJob(init.convertURL, videoId, format, client, 'Convert Y2Mate'), geo: String(auth.geo ?? '0') }
}
async function start(videoId, format, client) {
  let site = await discover(client)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return { ...(await primary(site, videoId, format, client)), site } } catch (error) {
      if (attempt === 0 && error.status === 403 && error.code !== 'BOT_CHALLENGE') {
        await wait(1000, client.signal)
        site = await discover(client)
        continue
      }
      throw error
    }
  }
}
function makeResult(job, site, videoId, format) {
  const downloadUrl = withParams(job.downloadUrl, { v: videoId, f: format, r: site.referrer }).toString()
  return { ok: true, service: 'y2mate', format, videoId, title: job.title || `${videoId} - YouTube`, downloadUrl, downloads: [downloadUrl] }
}
async function finish(initialJob, site, videoId, format, geo, client) {
  if (initialJob.type === 'ready') { emit(client, 'completed', 3, 'Selesai'); return makeResult(initialJob, site, videoId, format) }
  if (geo !== '0') {
    const messages = ['Memeriksa video', 'Mengekstrak audio', 'Mengonversi video']
    for (let value = 0; value < 3; value += 1) {
      emit(client, 'processing', value, messages[value])
      await wait(client.pollIntervalMs, client.signal)
    }
    emit(client, 'completed', 3, 'Selesai')
    return makeResult(initialJob, site, videoId, format)
  }
  const messages = ['Memeriksa video', 'Mengekstrak audio', 'Mengonversi video', 'Selesai']
  let job = initialJob
  while (job.progress < 3) {
    await wait(client.pollIntervalMs, client.signal)
    const data = await request(withParams(job.progressUrl, { _: Date.now() }), client, 'Progress Y2Mate')
    serviceCheck(data, 'Progress Y2Mate')
    if (String(data.status).toLowerCase() === 'download' && text(data.downloadURL)) return makeResult({ title: text(data.title) || job.title, downloadUrl: data.downloadURL }, site, videoId, format)
    if (String(data.redirect) === '1' && text(data.redirectURL)) return finish(await getJob(data.redirectURL, videoId, format, client, 'Redirect Y2Mate'), site, videoId, format, '0', client)
    job = { ...job, title: text(data.title) || job.title, progress: data.progress === undefined ? job.progress : Number(data.progress) || 0, progressUrl: text(data.progressURL) || job.progressUrl, downloadUrl: text(data.downloadURL) || job.downloadUrl }
    const stage = Math.max(0, Math.min(3, job.progress))
    emit(client, stage === 3 ? 'completed' : 'processing', stage, messages[stage])
  }
  return makeResult(job, site, videoId, format)
}
export function extractYouTubeVideoId(input) {
  const value = String(input || '').trim()
  if (/^[\w-]{11}$/.test(value)) return value
  if (!value) throw new Y2MateScraperError('URL YouTube wajib diisi', { code: 'INVALID_INPUT' })
  let url
  try { url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`) } catch (cause) {
    throw new Y2MateScraperError('URL YouTube tidak valid', { code: 'INVALID_INPUT', cause })
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const parts = url.pathname.split('/').filter(Boolean)
  const id = host === 'youtu.be' ? parts[0] : ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)
    ? (url.searchParams.get('v') || (['embed', 'live', 'shorts'].includes(parts[0]) ? parts[1] : '')) : ''
  if (!/^[\w-]{11}$/.test(id || '')) throw new Y2MateScraperError('URL YouTube tidak didukung', { code: 'INVALID_INPUT' })
  return id
}
function failure(error) {
  const reasons = {
    BOT_CHALLENGE: 'Y2Mate meminta verifikasi browser; proteksi bot tidak dapat dilewati tanpa browser.',
    REQUEST_TIMEOUT: 'Request melewati batas waktu.', TIMEOUT: 'Konversi melewati batas waktu.', ABORTED: 'Proses dibatalkan.',
    INVALID_INPUT: error.message, HTTP_403: 'Y2Mate menolak akses setelah session dicoba ulang.', HTTP_429: 'Limit Y2Mate tercapai.',
  }
  return { ok: false, why: reasons[error.code] || error.message, code: error.code || 'SCRAPER_ERROR' }
}
/**
 * Ambil metadata dan URL download dari Y2Mate.
 * @param {string} url - URL YouTube atau video ID
 * @param {'mp3'|'mp4'} [format='mp3'] - Format hasil
 * @param {{timeoutMs?:number,pollIntervalMs?:number,retries?:number,userAgent?:string,signal?:AbortSignal,onProgress?:Function}} [options]
 * @returns {Promise<{ok:true,downloadUrl:string,downloads:string[]}|{ok:false,why:string,code?:string}>}
 */
export async function ytmp3Dl(url, format = 'mp3', options = {}) {
  const selected = String(format).toLowerCase()
  const selectedFormat = FORMATS.includes(selected) ? selected : 'mp3'
  try {
    const videoId = extractYouTubeVideoId(url)
    const sourceSignal = options.signal
    const timeoutMs = integer(options.timeoutMs, 600_000, 5000, 3_600_000)
    const signal = timeoutSignal(sourceSignal, timeoutMs)
    const client = {
      userAgent: String(options.userAgent || DEFAULT_UA), sourceSignal, signal,
      requestTimeoutMs: integer(options.requestTimeoutMs, 60_000, 1000, 300_000),
      pollIntervalMs: integer(options.pollIntervalMs, 3000, 500, 30_000),
      retries: integer(options.retries, 2, 0, 5), onProgress: options.onProgress,
    }
    const { job, site, geo } = await start(videoId, selectedFormat, client)
    return await finish(job, site, videoId, selectedFormat, geo || '0', client)
  } catch (error) {
    return failure(error)
  }
}
export const y2mateDl = ytmp3Dl
export default { ytmp3Dl, y2mateDl, FORMATS }
async function cli() {
  const args = process.argv.slice(2)
  if (!args.length || args.includes('--help')) return console.log('Usage: node ytmp3.js <url-youtube> [--format mp3|mp4] [--json]')
  const formatAt = args.findIndex((arg) => arg === '--format' || arg.startsWith('--format='))
  const format = formatAt < 0 ? 'mp3' : (args[formatAt].includes('=') ? args[formatAt].split('=')[1] : args[formatAt + 1])
  const json = args.includes('--json')
  const result = await ytmp3Dl(args[0], format, { onProgress: json ? null : ({ stage, progress, message }) => console.error(`[${stage}] ${progress === null ? '' : `${Math.round(progress / 3 * 100)}% `}${message}`) })
  if (json) console.log(JSON.stringify(result, null, 2))
  else if (result.ok) console.log(`Title    : ${result.title}\nVideo ID : ${result.videoId}\nFormat   : ${result.format.toUpperCase()}\nDownload : ${result.downloadUrl}`)
  else console.error(`ytmp3: ${result.why}`)
  if (!result.ok) process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli()
