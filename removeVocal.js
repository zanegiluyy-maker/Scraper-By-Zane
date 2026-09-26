/**
 * Name : X-Minus Vocal Remover
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://x-minus.pro/ai
 * Type : Scraper
 * Function : remove vocals from audio or YouTube
 * Note : Free tier only, mengikuti limit dan snippet resmi X-Minus.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

export const BASE_URL = 'https://x-minus.pro/ai'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const RETRY = new Set([408, 425, 429, 500, 502, 503, 504])
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'oga', 'aac', 'wma', 'mp4', 'mkv', 'webm', 'm4b'])

export class XMinusError extends Error {
  constructor(message, { code = 'XMINUS_ERROR', status, cause } = {}) {
    super(message, { cause })
    this.name = 'XMinusError'
    this.code = code
    this.status = status
  }
}

const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : ''
const wait = (ms, signal) => sleep(ms, undefined, { signal }).catch((cause) => { throw new XMinusError('Proses dibatalkan', { code: 'ABORTED', cause }) })
const log = (logger, level, message, meta = {}) => { if (typeof logger === 'function') { try { logger({ level, message, timestamp: new Date().toISOString(), ...meta }) } catch { return } } }

function pick(source, name) {
  return source.match(new RegExp(`\\b${name}\\s*:\\s*['"]([^'"]*)['"]`))?.[1] || source.match(new RegExp(`\\b${name}\\s*:\\s*(-?[0-9.]+)`))?.[1] || ''
}
function hiddenValue(html, id) {
  const tag = [...html.matchAll(/<input\b[^>]*>/g)].find((match) => new RegExp(`\\bid=["']${id}["']`).test(match[0]))?.[0] || ''
  return tag.match(/\bvalue=["']([^"']*)["']/)?.[1] || ''
}

async function getPage(options = {}) {
  const response = await fetch(BASE_URL, {
    redirect: 'follow',
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.requestTimeoutMs || 60_000)]) : AbortSignal.timeout(options.requestTimeoutMs || 60_000),
    headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': options.userAgent || UA, Referer: BASE_URL },
  })
  const html = await response.text()
  if (!response.ok || !html.includes('vocal-cut-auth-key')) throw new XMinusError(`Halaman X-Minus gagal: HTTP ${response.status}`, { code: `HTTP_${response.status}`, status: response.status })
  const authKey = hiddenValue(html, 'vocal-cut-auth-key')
  const uid = hiddenValue(html, 'vocal-cut-uid')
  const fp = hiddenValue(html, 'vocal-cut-fp') || '-'
  if (!authKey || !uid) throw new XMinusError('Session X-Minus tidak lengkap', { code: 'SESSION_INVALID' })
  const initSource = html.match(/var aiInitData\s*=\s*({[\s\S]*?})\s*;?/)?.[1] || html
  const settingsSource = html.match(/var aiSettings\s*=\s*({[\s\S]*?})\s*;?/)?.[1] || html
  const uploadHost = text(pick(initSource, 'upload_host')) || '//mmd.uvronline.app'
  return {
    authKey, uid, clientFp: fp, locale: text(pick(html, 'LOCALE')) || 'en_US', hostname: new URL(BASE_URL).hostname,
    uploadHost: uploadHost.startsWith('//') ? `https:${uploadHost}` : uploadHost,
    version: pick(initSource, 'version') || '3-4-0',
    maxFilesize: Number(pick(initSource, 'max_filesize')) || 70,
    model: pick(settingsSource, 'model') || 'mdx_v2_vocft',
    separation: pick(settingsSource, 'sep_name_backend') || 'inst_vocal',
    separationType: pick(settingsSource, 'separation_type') || 'vocals_music',
    aggressiveness: pick(settingsSource, 'aggressiveness') || '2',
    lvpanning: pick(settingsSource, 'lvpanning') || 'center',
    uvrbve: pick(settingsSource, 'uvrbvect') || 'auto',
    prerate: pick(settingsSource, 'prerate') || '100',
    isPremium: pick(initSource, 'is_premium') === '1',
  }
}

async function postForm(url, form, options = {}, label = 'X-Minus') {
  const timeout = options.requestTimeoutMs || 60_000
  for (let attempt = 0; attempt <= (options.retries || 0); attempt += 1) {
    try {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
      const response = await fetch(url, { method: 'POST', body: form, signal, headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': options.userAgent || UA, Referer: BASE_URL, Origin: new URL(BASE_URL).origin } })
      const raw = await response.text()
      let data
      try { data = JSON.parse(raw) } catch (cause) { throw new XMinusError(`${label}: JSON tidak valid`, { code: 'INVALID_JSON', cause }) }
      if (!response.ok) throw new XMinusError(`${label}: HTTP ${response.status}`, { code: `HTTP_${response.status}`, status: response.status })
      if (data.status === 'rejected') throw new XMinusError(text(data.message) || 'Permintaan ditolak X-Minus', { code: 'REJECTED' })
      return data
    } catch (error) {
      if (options.signal?.aborted) throw new XMinusError(`${label} dibatalkan`, { code: 'ABORTED', cause: error })
      if (error instanceof XMinusError && !RETRY.has(error.status)) throw error
      if (attempt === (options.retries || 0)) throw error instanceof XMinusError ? error : new XMinusError(`${label}: ${error.message}`, { code: 'NETWORK_ERROR', cause: error })
      await wait(1000 * 2 ** attempt, options.signal)
    }
  }
}

function youtubeId(value) {
  const input = text(value)
  if (/^[\w-]{11}$/.test(input)) return input
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`)
    const parts = url.pathname.split('/').filter(Boolean)
    const id = url.searchParams.get('v') || (['shorts', 'embed', 'live', 'v'].includes(parts[0]) ? parts[1] : '')
    return /^[\w-]{11}$/.test(id || '') ? id : ''
  } catch { return '' }
}

function formFields(session) {
  const form = new FormData()
  for (const [key, value] of Object.entries({ auth_key: session.authKey, locale: session.locale, separation: session.separation, separation_type: session.separationType, format: 'mp3', version: session.version, model: session.model, aggressiveness: session.aggressiveness, lvpanning: session.lvpanning, uvrbve_ct: session.uvrbve, pre_rate: session.prerate, bve_preproc: 'auto', show_setting_format: '0', hostname: session.hostname, client_fp: session.clientFp })) form.append(key, String(value))
  return form
}

async function localBlob(filePath, maxBytes = 70 * 1024 * 1024) {
  let info
  try { info = await stat(filePath) } catch (cause) { throw new XMinusError('File tidak ditemukan', { code: 'FILE_NOT_FOUND', cause }) }
  const ext = extname(filePath).slice(1).toLowerCase()
  if (!AUDIO_EXT.has(ext)) throw new XMinusError('Format file tidak didukung', { code: 'UNSUPPORTED_FORMAT' })
  if (!info.size) throw new XMinusError('File kosong', { code: 'EMPTY_FILE' })
  if (info.size >= maxBytes) throw new XMinusError('File melebihi batas ukuran X-Minus', { code: 'FILE_TOO_LARGE' })
  return new Blob([await readFile(filePath)], { type: ext === 'mp3' ? 'audio/mpeg' : `audio/${ext}` })
}

function downloadUrls(host, jobId) {
  const result = {}
  for (const stem of ['vocal', 'inst']) {
    const url = new URL('/dl/vocalCutAi', host)
    url.searchParams.set('job-id', jobId)
    url.searchParams.set('stem', stem)
    url.searchParams.set('fmt', 'mp3')
    url.searchParams.set('cdn', '0')
    result[stem] = url.toString()
  }
  return result
}

async function pollJob(session, jobId, options = {}) {
  const maxPolls = Math.min(Number(options.maxPolls) || 55, 100)
  const interval = Math.max(Number(options.pollIntervalMs) || 5000, 2000)
  for (let attempt = 0; attempt <= maxPolls; attempt += 1) {
    const form = new FormData()
    form.append('job_id', jobId)
    form.append('auth_key', session.authKey)
    form.append('locale', session.locale)
    const data = await postForm(`${session.uploadHost}/upload/vocalCutAi?check-job-status`, form, { ...options, retries: options.retries ?? 2 }, 'Status X-Minus')
    if (data.status === 'failed') throw new XMinusError(text(data.err_msg) || 'Pekerjaan gagal di X-Minus', { code: 'JOB_FAILED' })
    if (data.status === 'done') return data
    if (attempt < maxPolls) await wait(interval, options.signal)
  }
  throw new XMinusError('Waktu polling X-Minus habis', { code: 'POLL_TIMEOUT' })
}

/**
 * Pisahkan vokal dan musik melalui free tier X-Minus.
 * @param {string} input - Path file audio/video lokal atau URL/ID YouTube
 * @param {{maxPolls?:number,pollIntervalMs?:number,requestTimeoutMs?:number,retries?:number,signal?:AbortSignal,logger?:Function}} [options]
 * @returns {Promise<{ok:true,jobId:string,vocalUrl:string,instrumentalUrl:string,freeSnippet:boolean,sourceDuration:number|null,quota:object}|{ok:false,why:string,code:string}>}
 */
export async function xminusRemoveVocal(input, options = {}) {
  try {
    const value = text(input)
    if (!value) return { ok: false, why: 'Input wajib diisi.', code: 'INVALID_INPUT' }
    const session = await getPage(options)
    if (session.isPremium) log(options.logger, 'debug', 'X-Minus session premium terdeteksi; memakai endpoint free resmi')
    const form = formFields(session)
    let inputType
    if (/^[\w-]{11}$/.test(value) || /youtube\.com|youtu\.be/i.test(value)) {
      const id = youtubeId(value)
      if (!id) throw new XMinusError('URL/ID YouTube tidak valid', { code: 'INVALID_INPUT' })
      form.append('vocal-cut-from-youtube', id)
      inputType = 'youtube'
    } else {
      const blob = await localBlob(value, session.maxFilesize * 1024 * 1024)
      form.append('myfile', blob, basename(value))
      inputType = 'file'
    }
    log(options.logger, 'info', 'mengirim audio ke X-Minus', { inputType })
    const accepted = await postForm(`${session.uploadHost}/upload/vocalCutAi?catch-file`, form, { ...options, retries: options.retries ?? 0 }, 'Upload X-Minus')
    if (accepted.status !== 'accepted' || !text(accepted.job_id)) throw new XMinusError('X-Minus tidak memberikan job ID', { code: 'NO_JOB_ID' })
    const jobId = text(accepted.job_id)
    const finished = await pollJob(session, jobId, options)
    const urls = downloadUrls(session.uploadHost, jobId)
    return { ok: true, service: 'x-minus', inputType, jobId, title: text(finished.source_filename) || basename(value).replace(/\.[^.]+$/, ''), sourceDuration: Number(finished.source_duration ?? accepted.source_duration) || null, vocalUrl: urls.vocal, instrumentalUrl: urls.inst, downloads: urls, freeSnippet: String(finished.free_snippet_notif ?? accepted.free_snippet_notif) === '1', quota: { processed24h: Number(accepted.processed_24h) || 0, limit24h: Number(accepted.limit_24h) || 0, remainingTime: Number(accepted.remaining_time) || 0 } }
  } catch (error) {
    return { ok: false, why: error.message || 'Gagal X-Minus.', code: error.code || 'SCRAPER_ERROR' }
  }
}

export const removeVocal = xminusRemoveVocal
export default { xminusRemoveVocal, removeVocal }

async function cli() {
  const args = process.argv.slice(2)
  if (!args.length || args.includes('--help')) return console.log('Usage:\n  node xminus.js youtube <url/id>\n  node xminus.js file <path>')
  const result = await xminusRemoveVocal(args[1])
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli()
