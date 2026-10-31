/**
 * Name : FastDL Instagram Downloader Scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://fastdl.app
 * Type : Scraper
 * Function : Instagram post/reel/igtv URL -> direct media URL + meta (JSON only).
 * Note : error fix sendiri.
 *        Zero dependency — Node built-in saja (crypto, child_process, timers).
 *        Zero credential — tanpa cookie, tanpa CF/Turnstile/solver token.
 *        Bypass:
 *          1) Body signature HMAC-SHA256 (di-reverse dari bundle app).
 *          2) Jalur fastdl.app/api/convert (bukan api-wh) = tanpa captcha.
 *          3) HTTP pakai curl (Node undici TLS/JA3 kena Turnstile; curl lolos).
 *        Output: JSON ke stdout saja, tidak simpan file.
 *        credit: Zane.
 *
 *        Usage:
 *          node fastdl.js "https://www.instagram.com/reel/ABC123/"
 *          node fastdl.js "https://www.instagram.com/p/ABC123/"
 *          node fastdl.js "instagram.com/reel/ABC123/" --verbose
 *
 *        Flags:
 *          --verbose   log ke stderr
 *          --retry <n> default 3
 *
 *        Contoh output:
 *          { success, credit, shortcode, kind, username, best_video, media[], ... }
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { createHmac } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const BASE_URL = 'https://fastdl.app'
const ORIGIN = 'https://fastdl.app'
const CONVERT_URL = `${BASE_URL}/api/convert`
const MSECS_URL = `${BASE_URL}/msec`

const HMAC_KEY = Buffer.from('e4512e74bb3b58fe1ed68bfa25efef6e5023bac6265bf0e84ec785b6821895eb', 'hex')
const FINGERPRINT = 1793188241256
const SIGN_VERSION = 2

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const RETRY = new Set([403, 408, 425, 429, 500, 502, 503, 504])
const IG_URL_RE = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i

export class FastDlError extends Error {
  constructor(message, { code = 'FASTDL_ERROR', status, cause } = {}) {
    super(message, { cause })
    this.name = 'FastDlError'
    this.code = code
    this.status = status
  }
}

const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : ''
const integer = (value, fallback, min, max) => Math.max(min, Math.min(max, Math.round(Number(value ?? fallback) || fallback)))
const wait = (ms) => sleep(ms)
const log = (verbose, ...args) => { if (verbose) console.error('[fastdl]', ...args) }

function sortKeys(obj) {
  const out = {}
  for (const key of Object.keys(obj).sort()) out[key] = obj[key]
  return out
}

let clockOffsetMs = 0

async function curlJson(url, { method = 'GET', body, timeoutMs = 45000, verbose = false } = {}) {
  const args = ['-sS', '-w', '\n%{http_code}', '-X', method, '--max-time', String(Math.ceil(timeoutMs / 1000))]
  if (url === MSECS_URL) {
    args.push('-H', `User-Agent: ${UA}`, '-H', 'Accept: application/json')
  } else {
    args.push(
      '-H', `User-Agent: ${UA}`,
      '-H', 'Accept: application/json, text/plain, */*',
      '-H', `Origin: ${ORIGIN}`,
      '-H', `Referer: ${ORIGIN}/`,
      '-H', 'Content-Type: application/json',
    )
  }
  if (body !== undefined) args.push('--data-binary', JSON.stringify(body))
  log(verbose, 'curl', method, url)
  const { stdout } = await execFileAsync('curl', [...args, url], { maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs + 5000 })
  const idx = stdout.lastIndexOf('\n')
  const raw = idx === -1 ? stdout : stdout.slice(0, idx)
  const status = Number(stdout.slice(idx + 1).trim()) || 0
  let data = null
  try { data = raw ? JSON.parse(raw) : null } catch { data = null }
  return { ok: status >= 200 && status < 300, status, raw, data }
}

async function syncClock({ verbose } = {}) {
  try {
    const res = await curlJson(MSECS_URL, { verbose })
    const serverMs = Math.round(1000 * Number(res.data?.msec) || 0)
    if (!serverMs) return
    const offset = Date.now() - serverMs
    clockOffsetMs = Math.abs(offset) < 60000 ? 0 : offset
    log(verbose, 'clockOffset', clockOffsetMs)
  } catch (cause) {
    log(verbose, 'clock sync skip', cause?.message)
  }
}

export function signBody(body) {
  const ts = Date.now() - clockOffsetMs
  const message = JSON.stringify(sortKeys(body)) + ts
  const _s = createHmac('sha256', HMAC_KEY).update(message, 'utf8').digest('hex')
  return { ...body, ts, _ts: FINGERPRINT, _tsc: clockOffsetMs, _sv: SIGN_VERSION, _s }
}

export function normalizeUrl(input) {
  const raw = text(input)
  if (!raw) throw new FastDlError('URL kosong', { code: 'EMPTY_URL' })
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`
  let url
  try { url = new URL(candidate) } catch {
    throw new FastDlError(`URL tidak valid: ${raw}`, { code: 'BAD_URL' })
  }
  if (!/instagram\.com$/i.test(url.hostname) && !/instagr\.am$/i.test(url.hostname)) {
    throw new FastDlError(`Bukan URL Instagram: ${url.hostname}`, { code: 'NOT_INSTAGRAM' })
  }
  const m = url.pathname.match(IG_URL_RE) || raw.match(IG_URL_RE)
  if (!m) throw new FastDlError('URL harus post/reel/igtv', { code: 'UNSUPPORTED_PATH' })
  const kind = /reel/i.test(url.pathname) ? 'reel' : /tv/i.test(url.pathname) ? 'igtv' : 'post'
  return { target_url: url.origin + url.pathname, shortcode: m[1], kind }
}

function parseConvert(data, { shortcode, kind, source }) {
  if (!data || typeof data !== 'object') throw new FastDlError('Respons kosong', { code: 'EMPTY_RESPONSE' })
  if (data.code === 'CAPTCHA_REQUIRED' || /captcha/i.test(String(data.info || ''))) {
    throw new FastDlError('Rate-limit / captcha — tunggu sebentar lalu retry', { code: 'CAPTCHA_REQUIRED', status: 422 })
  }
  if (data.success === false || (data.info === -1 && data.invalid_request)) {
    throw new FastDlError(text(data.message) || 'invalid_request', { code: 'INVALID_REQUEST' })
  }
  const list = Array.isArray(data.url) ? data.url.filter((u) => text(u?.url)) : []
  if (!list.length) throw new FastDlError('Tidak ada media ditemukan', { code: 'NO_MEDIA' })

  const media = list.map((item) => ({
    url: item.url,
    name: text(item.name) || '',
    type: text(item.type) || '',
    ext: text(item.ext) || '',
    quality: integer(item.quality, 0, 0, 9999),
    subname: text(item.subname) || '',
  }))

  const videos = media.filter((m) => /mp4|video/i.test(`${m.ext} ${m.type} ${m.name}`))
  const images = media.filter((m) => /jpg|jpeg|png|webp|image/i.test(`${m.ext} ${m.type} ${m.name}`))
  const bestVideo = videos.sort((a, b) => b.quality - a.quality)[0] || null
  const bestImage = images.sort((a, b) => b.quality - a.quality)[0] || null

  const meta = data.meta && typeof data.meta === 'object' ? data.meta : {}
  return {
    success: true,
    credit: 'Zane',
    source: text(meta.source) || source,
    shortcode: text(meta.shortcode) || shortcode,
    kind,
    username: text(meta.username) || '',
    title: text(meta.title) || '',
    like_count: integer(meta.like_count, 0, 0, Number.MAX_SAFE_INTEGER),
    comment_count: integer(meta.comment_count, 0, 0, Number.MAX_SAFE_INTEGER),
    taken_at: integer(meta.taken_at, 0, 0, Number.MAX_SAFE_INTEGER),
    media_count: media.length,
    best_video: bestVideo,
    best_image: bestImage,
    media,
  }
}

export async function convert(input, { verbose = false, retries = 3 } = {}) {
  const { target_url, shortcode, kind } = normalizeUrl(input)
  await syncClock({ verbose })

  let lastError
  for (let attempt = 1; attempt <= retries; attempt++) {
    const body = signBody({ target_url })
    try {
      log(verbose, 'POST try', attempt, body.ts)
      const res = await curlJson(CONVERT_URL, { method: 'POST', body, verbose })
      if (!res.data) {
        throw new FastDlError(`Respons bukan JSON (status ${res.status})`, { code: 'BAD_JSON', status: res.status })
      }
      if (res.status === 422 && res.data?.code === 'CAPTCHA_REQUIRED') {
        lastError = new FastDlError('Captcha/rate-limit — backoff', { code: 'CAPTCHA_REQUIRED', status: 422 })
        const backoff = 1500 * attempt + Math.floor(Math.random() * 800)
        log(verbose, 'backoff', backoff)
        await wait(backoff)
        continue
      }
      if (RETRY.has(res.status)) {
        lastError = new FastDlError(`HTTP ${res.status}`, { code: 'HTTP_' + res.status, status: res.status })
        await wait(800 * attempt)
        continue
      }
      if (!res.ok) {
        throw new FastDlError(text(res.data?.message) || text(res.data?.info) || `HTTP ${res.status}`, {
          code: 'HTTP_' + res.status,
          status: res.status,
        })
      }
      return parseConvert(res.data, { shortcode, kind, source: target_url })
    } catch (cause) {
      lastError = cause instanceof FastDlError ? cause : new FastDlError(cause?.message || 'curl gagal', { code: 'CURL_FAILED', cause })
      if (attempt < retries) {
        log(verbose, 'retry after', lastError.code)
        await wait(700 * attempt)
      }
    }
  }
  throw lastError || new FastDlError('Gagal convert', { code: 'FAILED' })
}

function parseArgs(argv) {
  const args = { _: [], verbose: false, retries: 3 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--verbose') args.verbose = true
    else if (a === '--retry') args.retries = integer(argv[++i], 3, 1, 10)
    else if (a.startsWith('--')) throw new FastDlError(`Flag tidak dikenal: ${a}`, { code: 'BAD_FLAG' })
    else args._.push(a)
  }
  return args
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const input = args._[0]
  if (!input) {
    console.log(JSON.stringify({
      success: false,
      credit: 'Zane',
      message: 'Usage: node fastdl.js "<instagram-url>" [--verbose] [--retry n]',
    }, null, 2))
    process.exitCode = 1
    return
  }
  const result = await convert(input, { verbose: args.verbose, retries: args.retries })
  console.log(JSON.stringify(result, null, 2))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.log(JSON.stringify({
      success: false,
      credit: 'Zane',
      error: err?.code || 'ERROR',
      message: err?.message || String(err),
    }, null, 2))
    process.exitCode = 1
  })
}
