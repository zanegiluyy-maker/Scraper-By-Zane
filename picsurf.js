/**
 * Name : pic.surf Upload + Link Shortener Scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://www.pic.surf
 * Type : Scraper
 * Function : upload image/video -> short URL, shorten destination URL -> short URL,
 *            resolve identifier -> final target, batch upload (anonymous free flow).
 * Note : error fix sendiri.
 *        Zero credential — semua fitur jalan anonymous tanpa cookie/login.
 *        Output JSON selalu menyertakan credit: Zane.
 *
 *        Usage:
 *          node picsurf.js upload foto.jpg
 *          node picsurf.js upload foto.jpg --expiration 1d --verbose
 *          node picsurf.js upload-url "https://site.com/a.jpg"
 *          node picsurf.js shorten "https://example.com/long/path"
 *          node picsurf.js shorten "https://example.com" --one-view
 *          node picsurf.js resolve abc123
 *          node picsurf.js whoami
 *          node picsurf.js batch foto.jpg "https://site.com/b.png"
 *
 *        Flags:
 *          --cookie "<browser cookie>"   opsional, unlock expiration/encryption akun
 *          --expiration never|1v|10m|1d|1m|1y
 *          --encrypted                   AES-GCM encrypt-in-browser (butuh cookie)
 *          --one-view                    shorten: hapus setelah 1x visit
 *          --proxies "<http://h:p,...>"  pool proxy buat rotasi IP saat rate limit
 *          --retry <n>                   default 3
 *          --skip-check                  lewati dedup check.php?hash=
 *          --verbose                     log retry/challenge ke stderr
 *
 *        Env (opsional, TIDAK wajib):
 *          PICSURF_COOKIE                cookie session akun
 *          PICSURF_PROXIES               proxy pool newline/comma
 *          CF_APIKEY                     solver API key (turnstile auto-solve)
 *          CF_TURNSTILE_SITEKEY          sitekey kalau site pasang challenge
 *
 *        Limit free: image 100MB, video 1GB, no captcha di jalur anonim.
 *        Kena 429/rate -> auto retry + rotasi UA; --proxies buat reset IP.
 *        Bot/CF challenge body terdeteksi; kalau perlu solver set env di atas.
 *
 *        Verified live: shorten/upload/upload-url/resolve/whoami/batch.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

export const BASE_URL = 'https://www.pic.surf'
const ORIGIN = 'https://www.pic.surf'
const UA_POOL = Object.freeze([
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
])
const RETRY = new Set([403, 408, 425, 429, 500, 502, 503, 504])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'])
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi'])
const MAX_IMAGE = 100 * 1024 * 1024
const MAX_VIDEO = 1024 * 1024 * 1024
const BOT_RE = /just a moment|cf-chl|cf_chl|challenge-platform|verify you are human|checking your browser|turnstile|g-recaptcha|hcaptcha|bot detected|access denied|attention required/i
const CF_API = process.env.CF_APIKEY ? `https://api.jerexd.my.id/api/tools/cfturnstile?apikey=${process.env.CF_APIKEY}` : ''

export class PicSurfError extends Error {
  constructor(message, { code = 'PICSURF_ERROR', status, cause } = {}) {
    super(message, { cause })
    this.name = 'PicSurfError'
    this.code = code
    this.status = status
  }
}

const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : ''
const integer = (value, fallback, min, max) => Math.max(min, Math.min(max, Math.round(Number(value ?? fallback) || fallback)))
const wait = (ms, signal) => sleep(ms, undefined, { signal }).catch((cause) => { throw new PicSurfError('Proses dibatalkan', { code: 'ABORTED', cause }) })
const log = (logger, level, message, meta = {}) => { if (typeof logger === 'function') { try { logger({ level, message, timestamp: new Date().toISOString(), ...meta }) } catch { return } } }
const pickUa = (i = 0) => UA_POOL[i % UA_POOL.length]

function parseCookies(raw) {
  const value = text(raw)
  if (!value) return ''
  if (/\r|\n/.test(value)) throw new PicSurfError('Cookie tidak valid', { code: 'INVALID_COOKIE' })
  return value
}

function timeoutSignal(parent, timeoutMs) {
  const timer = AbortSignal.timeout(timeoutMs)
  return parent ? AbortSignal.any([parent, timer]) : timer
}

function browserHeaders({ userAgent, cookie, page = false, extra = {} }) {
  return {
    Accept: page ? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8' : 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Origin: ORIGIN,
    Referer: `${BASE_URL}/`,
    'User-Agent': userAgent,
    'Sec-Fetch-Dest': page ? 'document' : 'empty',
    'Sec-Fetch-Mode': page ? 'navigate' : 'cors',
    'Sec-Fetch-Site': page ? 'none' : 'same-origin',
    'Sec-CH-UA': '"Chromium";v="142", "Google Chrome";v="142", "Not=A?Brand";v="24"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  }
}

function detectChallenge(body, status, headers) {
  const raw = typeof body === 'string' ? body : ''
  const server = String(headers?.get?.('server') || headers?.server || '')
  const ct = String(headers?.get?.('content-type') || headers?.['content-type'] || '')
  if (status === 403 || status === 429 || status === 503) {
    if (BOT_RE.test(raw) || /cloudflare|cf-ray/i.test(server) || /text\/html/i.test(ct)) return true
  }
  if (BOT_RE.test(raw)) return true
  if (/challenge-platform|cf-turnstile|hcaptcha\.com|recaptcha\.net/i.test(raw)) return true
  return false
}

async function solveTurnstile(options = {}) {
  const sitekey = text(options.turnstileSitekey || process.env.CF_TURNSTILE_SITEKEY)
  const pageUrl = text(options.turnstilePageUrl) || `${BASE_URL}/`
  if (!CF_API || !sitekey) return ''
  try {
    const url = new URL(CF_API)
    url.searchParams.set('sitekey', sitekey)
    url.searchParams.set('pageurl', pageUrl)
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': pickUa() } })
    const data = await response.json()
    return text(data?.result || data?.token || data?.data)
  } catch {
    return ''
  }
}

async function request(client, endpoint, init = {}) {
  const base = String(client.baseUrl || BASE_URL).replace(/\/+$/, '')
  const url = new URL(endpoint, `${base}/`)
  const retries = integer(init.retries ?? client.retries, 3, 0, 6)
  let lastError = null
  let attemptIndex = 0
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    attemptIndex = attempt
    const userAgent = client.cookies?.length ? pickUa(attempt + (client.uaOffset || 0)) : pickUa(attempt)
    const cookie = typeof client.cookieJar === 'function' ? client.cookieJar() : client.cookie
    try {
      const signal = timeoutSignal(client.signal, init.timeoutMs || client.requestTimeoutMs)
      const response = await fetch(url, {
        ...init,
        redirect: init.redirect || 'follow',
        headers: browserHeaders({ userAgent, cookie, page: !!init.page, extra: init.headers || {} }),
        signal,
      })
      const raw = await response.text()
      const challenge = detectChallenge(raw, response.status, response.headers)
      if (challenge) {
        const token = await solveTurnstile(client)
        lastError = new PicSurfError('Bot/Cloudflare challenge terdeteksi', { code: 'BOT_CHALLENGE', status: response.status })
        if (token && init.retryOnChallenge !== false) {
          const retryHeaders = { ...(init.headers || {}), 'cf-turnstile-response': token }
          const retryResponse = await fetch(url, {
            ...init,
            redirect: init.redirect || 'follow',
            headers: browserHeaders({ userAgent: pickUa(attempt + 1), cookie, page: !!init.page, extra: retryHeaders }),
            signal: timeoutSignal(client.signal, init.timeoutMs || client.requestTimeoutMs),
          })
          const retryRaw = await retryResponse.text()
          if (!detectChallenge(retryRaw, retryResponse.status, retryResponse.headers)) {
            return finalize(retryResponse, retryRaw, init, url)
          }
        }
        throw lastError
      }
      return finalize(response, raw, init, url)
    } catch (error) {
      if (client.signal?.aborted) throw new PicSurfError('Request dibatalkan', { code: 'ABORTED', cause: error })
      if (error instanceof PicSurfError && error.code === 'BOT_CHALLENGE' && attempt === retries) throw error
      if (error instanceof PicSurfError && !RETRY.has(error.status) && error.code !== 'NETWORK_ERROR' && error.code !== 'REQUEST_TIMEOUT') {
        if (attempt === retries) throw error
      }
      const retryable = error instanceof PicSurfError
        ? RETRY.has(error.status) || error.code === 'BOT_CHALLENGE' || error.code === 'NETWORK_ERROR' || error.code === 'REQUEST_TIMEOUT'
        : true
      if (!retryable || attempt === retries) {
        throw error instanceof PicSurfError ? error : new PicSurfError(error.message || 'Request gagal', { code: error.name === 'TimeoutError' ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', cause: error })
      }
      const retryAfter = Number(error.retryAfter || 0)
      const delay = retryAfter ? Math.min(retryAfter * 1000, 8000) : Math.min(400 * 2 ** attempt + Math.floor(Math.random() * 200), 8000)
      log(client.logger, 'warn', 'retry', { endpoint: url.pathname, attempt: attempt + 1, code: error.code || 'NETWORK', status: error.status || 0 })
      await wait(delay, client.signal)
    }
  }
  throw lastError || new PicSurfError('Request gagal', { code: 'NETWORK_ERROR' })
}

function finalize(response, raw, init, url) {
  const challenge = detectChallenge(raw, response.status, response.headers)
  if (challenge) throw new PicSurfError('Bot/Cloudflare challenge terdeteksi', { code: 'BOT_CHALLENGE', status: response.status })
  if (init.raw) return { response, raw, url }
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    let code = response.status === 429 ? 'RATE_LIMIT' : response.status === 413 ? 'FILE_TOO_LARGE' : `HTTP_${response.status}`
    try {
      const data = JSON.parse(raw)
      message = text(data.error) || text(data.message) || message
      if (/limit|rate|quota|too many/i.test(message)) code = 'RATE_LIMIT'
      if (/size|large|100|mb/i.test(message)) code = 'FILE_TOO_LARGE'
      if (/invalid|url/i.test(message) && /url|destination/i.test(message)) code = 'INVALID_URL'
      return { response, raw, url, data, error: { message, code } }
    } catch {
      return { response, raw, url, error: { message, code } }
    }
  }
  try {
    return { response, raw, url, data: JSON.parse(raw) }
  } catch {
    return { response, raw, url, data: null }
  }
}

async function bootstrap(client) {
  const cookieHeader = parseCookies(client.cookie)
  client.cookie = cookieHeader || ''
  try {
    const result = await request(client, '/auth/whoami', { method: 'GET', page: true, retries: 1, timeoutMs: 20_000 })
    const data = result.data || {}
    if (data.authenticated && text(data.token)) {
      client.jwt = text(data.token)
      log(client.logger, 'info', 'session authenticated', { nickname: text(data.nickname) })
      return client
    }
  } catch {
    /* anonymous path continues */
  }
  client.jwt = ''
  return client
}

function authHeaders(client, extra = {}) {
  if (client.jwt) extra.Authorization = `Bearer ${client.jwt}`
  return extra
}

function makeClient(options = {}) {
  const cookie = parseCookies(options.cookie || process.env.PICSURF_COOKIE || process.env.PIC_SURF_COOKIE)
  const proxies = Array.isArray(options.proxies)
    ? options.proxies.map((item) => text(item)).filter(Boolean)
    : text(options.proxies || process.env.PICSURF_PROXIES)
      ? text(options.proxies || process.env.PICSURF_PROXIES).split(/[\n,]+/).map((item) => item.trim()).filter(Boolean)
      : []
  return {
    baseUrl: String(options.baseUrl || BASE_URL),
    userAgent: text(options.userAgent) || pickUa(),
    uaOffset: integer(options.uaOffset, 0, 0, 99),
    cookie,
    jwt: '',
    cookies: [],
    proxyIndex: integer(options.proxyIndex, 0, 0, 9999),
    proxies,
    retries: integer(options.retries, 3, 0, 6),
    requestTimeoutMs: integer(options.requestTimeoutMs, 60_000, 5_000, 300_000),
    uploadTimeoutMs: integer(options.uploadTimeoutMs, 180_000, 10_000, 600_000),
    signal: options.signal,
    logger: options.logger,
    turnstileSitekey: options.turnstileSitekey,
    turnstilePageUrl: options.turnstilePageUrl,
    skipCheck: options.skipCheck !== false,
  }
}

function classifyPath(input) {
  const value = text(input)
  if (!value) return 'empty'
  if (/^https?:\/\//i.test(value) || value.startsWith('//')) return 'url'
  return 'file'
}

function sniffMime(fileName, buffer) {
  const ext = extname(fileName).slice(1).toLowerCase()
  if (buffer?.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer?.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer?.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buffer?.length >= 6 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')) return 'image/gif'
  if (buffer?.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4'
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  }
  return map[ext] || 'application/octet-stream'
}

async function sha256Hex(buffer) {
  try {
    const { createHash } = await import('node:crypto')
    return createHash('sha256').update(buffer).digest('hex')
  } catch {
    return ''
  }
}

async function fetchRemote(client, remoteUrl) {
  const url = text(remoteUrl)
  if (!/^https?:\/\//i.test(url)) throw new PicSurfError('URL remote tidak valid', { code: 'INVALID_URL' })
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new PicSurfError('Protokol tidak didukung', { code: 'INVALID_URL' })
  const response = await fetch(parsed, {
    redirect: 'follow',
    signal: timeoutSignal(client.signal, client.uploadTimeoutMs),
    headers: browserHeaders({ userAgent: client.userAgent, cookie: client.cookie, page: true }),
  })
  if (!response.ok) throw new PicSurfError(`Download remote gagal: HTTP ${response.status}`, { code: `HTTP_${response.status}`, status: response.status })
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.length) throw new PicSurfError('File remote kosong', { code: 'EMPTY_FILE' })
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim()
  const name = basename(parsed.pathname) || `remote-${randomUUID().slice(0, 8)}`
  return { buffer, fileName: name, contentType, size: buffer.length }
}

async function loadLocal(filePath, options = {}) {
  const file = text(filePath)
  if (!file) throw new PicSurfError('Path file wajib diisi', { code: 'INVALID_INPUT' })
  const ext = extname(file).slice(1).toLowerCase()
  const allowed = IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext)
  if (!allowed && !options.allowAny) throw new PicSurfError('Format file tidak didukung (image/video)', { code: 'UNSUPPORTED_FORMAT' })
  let info
  try { info = await stat(file) } catch (cause) { throw new PicSurfError('File tidak ditemukan', { code: 'FILE_NOT_FOUND', cause }) }
  if (!info.size) throw new PicSurfError('File kosong', { code: 'EMPTY_FILE' })
  const isVideo = VIDEO_EXT.has(ext)
  const maxBytes = integer(options.maxBytes, isVideo ? MAX_VIDEO : MAX_IMAGE, 1024, MAX_VIDEO)
  if (info.size > maxBytes) throw new PicSurfError(`File melebihi batas ${Math.round(maxBytes / 1024 / 1024)} MB`, { code: 'FILE_TOO_LARGE' })
  const buffer = await readFile(file)
  return { buffer, fileName: basename(file), contentType: sniffMime(basename(file), buffer), size: info.size, isVideo }
}

function toBlob(payload) {
  return new Blob([payload.buffer], { type: payload.contentType || sniffMime(payload.fileName, payload.buffer) })
}

function buildUploadForm(payload, options = {}) {
  const form = new FormData()
  form.append('file', toBlob(payload), payload.fileName)
  const expiration = text(options.expiration)
  if (expiration) form.append('expiration', expiration)
  if (options.encrypted) {
    form.append('encrypted', '1')
    form.append('original_name', payload.fileName)
    form.append('extension', extname(payload.fileName).slice(1).toLowerCase())
    form.append('mime_type', payload.contentType || 'application/octet-stream')
  }
  return form
}

async function uploadPrepared(client, payload, options = {}) {
  if (!client.skipCheck) {
    try {
      const hash = await sha256Hex(payload.buffer)
      if (hash) {
        const check = await request(client, `/check.php?hash=${hash}`, { method: 'GET', retries: 1, timeoutMs: 15_000 })
        if (check.data?.exists && text(check.data.identifier)) {
          const shortUrl = `${client.baseUrl.replace(/\/+$/, '')}/${text(check.data.identifier)}`
          log(client.logger, 'info', 'dedup hit', { identifier: text(check.data.identifier) })
          return {
            ok: true,
            service: 'picsurf',
            credit: 'Zane',
            mode: 'upload',
            identifier: text(check.data.identifier),
            shortUrl,
            url: shortUrl,
            fileName: payload.fileName,
            size: payload.size,
            contentType: payload.contentType,
            dedup: true,
          }
        }
      }
    } catch {
      /* skip dedup */
    }
  }
  const form = buildUploadForm(payload, options)
  const headers = authHeaders(client, {
    Accept: 'application/json, text/plain, */*',
    Origin: ORIGIN,
    Referer: `${BASE_URL}/`,
  })
  const result = await request(client, '/upload.php', {
    method: 'POST',
    body: form,
    headers,
    timeoutMs: client.uploadTimeoutMs,
    retries: client.retries,
  })
  if (result.error) throw new PicSurfError(result.error.message, { code: result.error.code, status: result.response?.status })
  const data = result.data || {}
  const identifier = text(data.identifier)
  if (!identifier) throw new PicSurfError(text(data.error) || 'Respons upload tidak valid', { code: 'INVALID_RESPONSE' })
  const shortUrl = `${client.baseUrl.replace(/\/+$/, '')}/${identifier}`
  return {
    ok: true,
    service: 'picsurf',
    credit: 'Zane',
    mode: 'upload',
    identifier,
    shortUrl,
    url: shortUrl,
    fileName: payload.fileName,
    size: payload.size,
    contentType: payload.contentType,
    dedup: false,
    encrypted: !!options.encrypted,
    expiration: text(options.expiration) || null,
  }
}

/**
 * Upload file lokal ke pic.surf, kembalikan short URL.
 * @param {string} filePath - Path file image/video
 * @param {{cookie?:string,baseUrl?:string,expiration?:string,encrypted?:boolean,maxBytes?:number,retries?:number,requestTimeoutMs?:number,uploadTimeoutMs?:number,signal?:AbortSignal,logger?:Function,skipCheck?:boolean,proxies?:string[]|string,turnstileSitekey?:string}} [options]
 * @returns {Promise<{ok:true,service:string,mode:string,identifier:string,shortUrl:string,url:string,fileName:string,size:number,contentType:string,dedup:boolean}|{ok:false,why:string,code:string}>}
 */
export async function picsurfUpload(filePath, options = {}) {
  try {
    const client = makeClient(options)
    await bootstrap(client)
    const payload = await loadLocal(filePath, options)
    log(client.logger, 'info', 'uploading', { fileName: payload.fileName, size: payload.size, contentType: payload.contentType })
    return await uploadPrepared(client, payload, options)
  } catch (error) {
    return failure(error)
  }
}

/**
 * Download URL remote lalu upload ke pic.surf, kembalikan short URL.
 * @param {string} remoteUrl - URL http(s) file image/video
 * @param {{cookie?:string,baseUrl?:string,expiration?:string,encrypted?:boolean,retries?:number,requestTimeoutMs?:number,uploadTimeoutMs?:number,signal?:AbortSignal,logger?:Function,skipCheck?:boolean}} [options]
 * @returns {Promise<{ok:true,service:string,mode:string,identifier:string,shortUrl:string,url:string,fileName:string,size:number,contentType:string,dedup:boolean}|{ok:false,why:string,code:string}>}
 */
export async function picsurfUploadUrl(remoteUrl, options = {}) {
  try {
    const client = makeClient(options)
    await bootstrap(client)
    const payload = await fetchRemote(client, remoteUrl)
    log(client.logger, 'info', 'uploading remote', { fileName: payload.fileName, size: payload.size, remoteUrl: text(remoteUrl) })
    return await uploadPrepared(client, payload, options)
  } catch (error) {
    return failure(error)
  }
}

/**
 * Shorten destination URL via /link_create.php, kembalikan short URL.
 * @param {string} destinationUrl - URL tujuan http(s)
 * @param {{oneView?:boolean,cookie?:string,baseUrl?:string,retries?:number,requestTimeoutMs?:number,signal?:AbortSignal,logger?:Function}} [options]
 * @returns {Promise<{ok:true,service:string,mode:string,identifier:string,shortUrl:string,url:string,destination:string,oneView:boolean}|{ok:false,why:string,code:string}>}
 */
export async function picsurfShorten(destinationUrl, options = {}) {
  try {
    const raw = text(destinationUrl)
    if (!raw) throw new PicSurfError('URL tujuan wajib diisi', { code: 'INVALID_INPUT' })
    let destination
    try {
      destination = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    } catch (cause) {
      throw new PicSurfError('URL tujuan tidak valid', { code: 'INVALID_URL', cause })
    }
    if (!['http:', 'https:'].includes(destination.protocol)) throw new PicSurfError('URL tujuan harus http(s)', { code: 'INVALID_URL' })
    const selfHost = new URL(String(options.baseUrl || BASE_URL).replace(/\/+$/, '')).hostname
    if (destination.hostname === selfHost) throw new PicSurfError('URL tujuan tidak boleh host pic.surf sendiri', { code: 'INVALID_URL' })
    const client = makeClient(options)
    await bootstrap(client)
    const oneView = options.oneView === true || options.oneView === 'true' || options.oneView === '1'
    const headers = authHeaders(client, { 'Content-Type': 'application/json' })
    const result = await request(client, '/link_create.php', {
      method: 'POST',
      body: JSON.stringify({ url: destination.toString(), one_view: oneView }),
      headers,
      timeoutMs: client.requestTimeoutMs,
      retries: client.retries,
    })
    if (result.error) throw new PicSurfError(result.error.message, { code: result.error.code, status: result.response?.status })
    const data = result.data || {}
    const identifier = text(data.identifier)
    if (!identifier) throw new PicSurfError(text(data.error) || 'Respons shortener tidak valid', { code: 'INVALID_RESPONSE' })
    const shortUrl = `${client.baseUrl.replace(/\/+$/, '')}/${identifier}`
    return {
      ok: true,
      service: 'picsurf',
      credit: 'Zane',
      mode: 'shorten',
      identifier,
      shortUrl,
      url: shortUrl,
      destination: destination.toString(),
      oneView,
    }
  } catch (error) {
    return failure(error)
  }
}

/**
 * Resolve identifier pic.surf -> final URL (cek eksistensi).
 * @param {string} identifier - Path identifier dari short URL
 * @param {{cookie?:string,baseUrl?:string,retries?:number,signal?:AbortSignal,logger?:Function}} [options]
 * @returns {Promise<{ok:true,service:string,mode:string,identifier:string,shortUrl:string,url:string,status:number,contentType:string|null}|{ok:false,why:string,code:string}>}
 */
export async function picsurfResolve(identifier, options = {}) {
  try {
    const id = text(identifier).replace(/^https?:\/\/(www\.)?pic\.surf\//i, '').replace(/^\//, '').split(/[?#]/)[0]
    if (!id) throw new PicSurfError('Identifier wajib diisi', { code: 'INVALID_INPUT' })
    const client = makeClient(options)
    const result = await request(client, `/${encodeURIComponent(id)}`, {
      method: 'GET',
      page: true,
      redirect: 'manual',
      retries: client.retries,
      timeoutMs: 20_000,
    })
    const shortUrl = `${client.baseUrl.replace(/\/+$/, '')}/${id}`
    const location = result.response.headers.get('location')
    const finalUrl = location ? new URL(location, shortUrl).toString() : shortUrl
    if (result.response.status >= 400 && !result.response.headers.get('location')) {
      throw new PicSurfError(`Identifier tidak ditemukan (HTTP ${result.response.status})`, { code: result.response.status === 404 ? 'NOT_FOUND' : `HTTP_${result.response.status}`, status: result.response.status })
    }
    return {
      ok: true,
      service: 'picsurf',
      credit: 'Zane',
      mode: 'resolve',
      identifier: id,
      shortUrl,
      url: finalUrl,
      status: result.response.status,
      contentType: result.response.headers.get('content-type'),
      redirect: !!location,
    }
  } catch (error) {
    return failure(error)
  }
}

/**
 * Cek status auth session pic.surf.
 * @param {{cookie?:string,baseUrl?:string,signal?:AbortSignal,logger?:Function}} [options]
 * @returns {Promise<{ok:true,service:string,mode:string,authenticated:boolean,token:string|null,nickname:string|null,email:string|null}|{ok:false,why:string,code:string}>}
 */
export async function picsurfWhoami(options = {}) {
  try {
    const client = makeClient(options)
    const result = await request(client, '/auth/whoami', { method: 'GET', page: true, retries: client.retries, timeoutMs: 20_000 })
    const data = result.data || {}
    return {
      ok: true,
      service: 'picsurf',
      credit: 'Zane',
      mode: 'whoami',
      authenticated: !!data.authenticated,
      token: text(data.token) || null,
      nickname: text(data.nickname) || null,
      email: text(data.email) || null,
    }
  } catch (error) {
    return failure(error)
  }
}

/**
 * Batch upload beberapa path/URL, hasil short URL per item.
 * @param {string[]} items - Array path file atau URL remote
 * @param {{cookie?:string,baseUrl?:string,expiration?:string,signal?:AbortSignal,logger?:Function,concurrency?:number}} [options]
 * @returns {Promise<{ok:true,service:string,mode:string,results:Array<{ok:boolean,item:string,shortUrl?:string,identifier?:string,why?:string,code?:string}>}>}
 */
export async function picsurfUploadBatch(items, options = {}) {
  const list = Array.isArray(items) ? items.filter((item) => text(item)) : []
  if (!list.length) return { ok: false, why: 'Tidak ada item untuk diupload.', code: 'INVALID_INPUT' }
  const concurrency = integer(options.concurrency, 2, 1, 6)
  const results = []
  let cursor = 0
  async function worker() {
    while (cursor < list.length) {
      const index = cursor++
      const item = list[index]
      const kind = classifyPath(item)
      const run = kind === 'url' ? picsurfUploadUrl(item, options) : picsurfUpload(item, options)
      const result = await run
      results[index] = result.ok
        ? { ok: true, item, shortUrl: result.shortUrl, identifier: result.identifier, mode: result.mode }
        : { ok: false, item, why: result.why, code: result.code }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, () => worker()))
  return { ok: true, service: 'picsurf', credit: 'Zane', mode: 'batch', results }
}

function failure(error) {
  const reasons = {
    BOT_CHALLENGE: 'Site meminta verifikasi bot/Cloudflare. Set CF_APIKEY + CF_TURNSTILE_SITEKEY untuk auto-solve, atau pakai cookie browser yang sudah lolos challenge.',
    RATE_LIMIT: 'Rate limit tercapai. Rotasi proxy (--proxies) atau cookie akun, lalu retry.',
    FILE_TOO_LARGE: 'File melebihi batas ukuran pic.surf (image 100MB, video 1GB).',
    FILE_NOT_FOUND: error.message,
    EMPTY_FILE: error.message,
    UNSUPPORTED_FORMAT: error.message,
    INVALID_INPUT: error.message,
    INVALID_URL: error.message,
    INVALID_COOKIE: error.message,
    NOT_FOUND: error.message,
    AUTH_REQUIRED: error.message,
    REQUEST_TIMEOUT: 'Request melewati batas waktu.',
    ABORTED: 'Proses dibatalkan.',
    NETWORK_ERROR: error.message || 'Jaringan gagal.',
  }
  return { ok: false, why: reasons[error.code] || error.message || 'pic.surf gagal.', code: error.code || 'SCRAPER_ERROR' }
}

export const upload = picsurfUpload
export const uploadUrl = picsurfUploadUrl
export const shorten = picsurfShorten
export const resolve = picsurfResolve
export const whoami = picsurfWhoami
export default { picsurfUpload, picsurfUploadUrl, picsurfShorten, picsurfResolve, picsurfWhoami, picsurfUploadBatch, upload, uploadUrl, shorten, resolve, whoami, BASE_URL }

function parseCliFlags(args) {
  const flags = { _: [] }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) { flags._.push(arg); continue }
    const eq = arg.indexOf('=')
    if (eq > 0) { flags[arg.slice(2, eq)] = arg.slice(eq + 1); continue }
    const key = arg.slice(2)
    const next = args[i + 1]
    if (next && !next.startsWith('--')) { flags[key] = next; i += 1 } else flags[key] = true
  }
  return flags
}

async function cli() {
  const [command, ...rest] = process.argv.slice(2)
  const flags = parseCliFlags(rest)
  const positional = flags._
  const options = {
    cookie: flags.cookie,
    baseUrl: flags['base-url'],
    expiration: flags.expiration,
    encrypted: flags.encrypted === true || flags.encrypted === 'true',
    oneView: flags['one-view'] === true || flags['one-view'] === 'true' || flags['one-view'] === '1',
    retries: flags.retry !== undefined ? flags.retry : undefined,
    proxies: flags.proxies,
    skipCheck: flags['skip-check'] !== true && flags['skip-check'] !== 'true',
    logger: flags.verbose ? ({ level, message, ...meta }) => console.error(`[${level}] ${message}`, meta) : undefined,
  }
  if (!command || command === '--help') {
    return console.log('Usage:\n  node picsurf.js upload <file>\n  node picsurf.js upload-url <https://...>\n  node picsurf.js shorten <https://destination> [--one-view]\n  node picsurf.js resolve <identifier|url>\n  node picsurf.js whoami [--cookie "..."]\n  node picsurf.js batch <file|url> [file|url...]')
  }
  let result
  if (command === 'upload') result = await picsurfUpload(positional[0], options)
  else if (command === 'upload-url') result = await picsurfUploadUrl(positional[0], options)
  else if (command === 'shorten') result = await picsurfShorten(positional[0], options)
  else if (command === 'resolve') result = await picsurfResolve(positional[0], options)
  else if (command === 'whoami') result = await picsurfWhoami(options)
  else if (command === 'batch') result = await picsurfUploadBatch(positional, options)
  else result = { ok: false, why: 'Command tidak dikenal.', code: 'INVALID_INPUT' }
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli()
