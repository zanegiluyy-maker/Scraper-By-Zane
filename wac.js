/**
 * Name : WebView APK Builder Scraper (webappcreator.amethystlab.org)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://webappcreator.amethystlab.org
 * Type : Scraper
 * Function : status queue / build website -> APK (submit + poll) -> download URL.
 * Note : error fix sendiri.
 *        Zero dependency npm — Node built-in + curl.
 *        Zero credential — tanpa cookie/login.
 *        Bypass: curl (no browser), auto package name, auto icon PNG,
 *                rate-limit aware (build-apk limit 10/300s), poll status.
 *        Output: JSON ke stdout saja, tidak simpan file.
 *        credit: Zane.
 *
 *        Usage:
 *          node wac.js status
 *          node wac.js build "https://example.com"
 *          node wac.js build "https://example.com" --name "MyApp" --package com.example.app --version 1.0.0 --code 2
 *          node wac.js build "https://example.com" --icon ./icon.png
 *          node wac.js build "https://example.com" --timeout 900 --verbose
 *
 *        Flags:
 *          --name <s>       app name (default: from hostname)
 *          --package <s>    package id (default: auto from name)
 *          --version <s>    versionName default 1.0.0
 *          --code <n>       versionCode default 1
 *          --icon <path>    icon PNG (default: auto generate)
 *          --timeout <s>    poll max seconds (default 600)
 *          --verbose        log ke stderr
 *
 *        Endpoint:
 *          GET  /api/queue-status
 *          POST /api/build-apk   (multipart)
 *          GET  /api/build-status/:projectId
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import { randomBytes, createHash } from 'node:crypto'
import { basename } from 'node:path'

const execFileAsync = promisify(execFile)

export const BASE_URL = 'https://webappcreator.amethystlab.org'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const RETRY = new Set([403, 408, 425, 429, 500, 502, 503, 504])

export class WacError extends Error {
  constructor(message, { code = 'WAC_ERROR', status, cause } = {}) {
    super(message, { cause })
    this.name = 'WacError'
    this.code = code
    this.status = status
  }
}

const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : ''
const integer = (value, fallback, min, max) => Math.max(min, Math.min(max, Math.round(Number(value ?? fallback) || fallback)))
const wait = (ms) => sleep(ms)
const log = (verbose, ...args) => { if (verbose) console.error('[wac]', ...args) }

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (~c) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

/** PNG solid-ish 192x192 tanpa dep canvas */
export function generatePng(size = 192, rgb = [59, 130, 246]) {
  const [r, g, b] = rgb
  const raw = Buffer.alloc((size * 3 + 1) * size)
  let p = 0
  for (let y = 0; y < size; y++) {
    raw[p++] = 0
    for (let x = 0; x < size; x++) {
      // gradient biar bukan flat banget
      const t = (x + y) / (size * 2)
      raw[p++] = Math.min(255, (r + t * 40) | 0)
      raw[p++] = Math.min(255, (g + t * 20) | 0)
      raw[p++] = Math.min(255, (b + t * 10) | 0)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

async function curlRequest(url, { method = 'GET', formFile, fields, timeoutMs = 60000, verbose = false } = {}) {
  const args = ['-sS', '-w', '\n%{http_code}', '-X', method, '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '-H', `User-Agent: ${UA}`,
    '-H', `Origin: ${BASE_URL}`,
    '-H', `Referer: ${BASE_URL}/`,
    '-H', 'Accept: application/json, text/plain, */*',
  ]
  if (formFile) {
    for (const [k, v] of Object.entries(fields || {})) {
      args.push('-F', `${k}=${v}`)
    }
    args.push('-F', `icon=@${formFile};filename=icon.png;type=image/png`)
  } else if (fields && method === 'POST') {
    args.push('-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(fields))
  }
  log(verbose, method, url)
  const { stdout } = await execFileAsync('curl', [...args, url], { maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs + 5000 })
  const idx = stdout.lastIndexOf('\n')
  const raw = idx === -1 ? stdout : stdout.slice(0, idx)
  const status = Number(stdout.slice(idx + 1).trim()) || 0
  let data = null
  try { data = raw ? JSON.parse(raw) : null } catch { data = null }
  return { ok: status >= 200 && status < 300, status, raw, data }
}

export async function queueStatus({ verbose = false } = {}) {
  const res = await curlRequest(`${BASE_URL}/api/queue-status`, { verbose, timeoutMs: 20000 })
  if (!res.data) {
    throw new WacError(`queue-status HTTP ${res.status}`, { code: 'QUEUE_HTTP_' + res.status, status: res.status })
  }
  return {
    success: true,
    credit: 'Zane',
    max_concurrent: integer(res.data.maxConcurrent, 0, 0, 99),
    current_builds: integer(res.data.currentBuilds, 0, 0, 99),
    queue_length: integer(res.data.queueLength, 0, 0, 99),
    active_ids: Array.isArray(res.data.currentBuildIds) ? res.data.currentBuildIds : [],
    queued_ids: Array.isArray(res.data.queuedBuildIds) ? res.data.queuedBuildIds : [],
    timestamp: text(res.data.timestamp),
  }
}

function slugPackage(name) {
  const base = text(name).toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^[0-9]+/, '') || 'app'
  const h = createHash('sha256').update(String(name)).digest('hex').slice(0, 6)
  return `com.webapp.${base}${h}`
}

function parseArgs(argv) {
  const args = { _: [], verbose: false, timeoutSec: 600 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--verbose') args.verbose = true
    else if (a === '--name') args.name = argv[++i]
    else if (a === '--package') args.package = argv[++i]
    else if (a === '--version') args.version = argv[++i]
    else if (a === '--code') args.code = integer(argv[++i], 1, 1, 2147483647)
    else if (a === '--icon') args.icon = argv[++i]
    else if (a === '--timeout') args.timeoutSec = integer(argv[++i], 600, 30, 1800)
    else if (a.startsWith('--')) throw new WacError(`Flag tidak dikenal: ${a}`, { code: 'BAD_FLAG' })
    else args._.push(a)
  }
  return args
}

export async function buildApk(input, {
  name,
  packageName,
  versionName = '1.0.0',
  versionCode = 1,
  iconPath,
  timeoutSec = 600,
  verbose = false,
} = {}) {
  let target = text(input)
  if (!target) throw new WacError('URL kosong', { code: 'EMPTY_URL' })
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`
  try {
    const u = new URL(target)
    if (!u.hostname.includes('.')) throw new Error('bad host')
  } catch {
    throw new WacError(`URL tidak valid: ${target}`, { code: 'BAD_URL' })
  }

  const appName = text(name) || (() => {
    try {
      return new URL(target).hostname.replace(/^www\./, '').split('.')[0]
    } catch { return 'MyApp' }
  })()
  const pkg = text(packageName) || slugPackage(appName)
  const verName = text(versionName) || '1.0.0'
  if (!/^\d+\.\d+\.\d+$/.test(verName)) {
    throw new WacError('versionName harus 1.0.0', { code: 'BAD_VERSION' })
  }
  const verCode = integer(versionCode, 1, 1, 2147483647)

  const fields = {
    websiteUrl: target,
    appName,
    packageName: pkg,
    versionName: verName,
    versionCode: String(verCode),
  }

  let tmpIcon = null
  let iconUsed = false
  if (iconPath) {
    tmpIcon = text(iconPath)
    iconUsed = true
  } else {
    tmpIcon = `/tmp/wac-icon-${process.pid}-${Date.now()}.png`
    await writeFile(tmpIcon, generatePng(192, [59, 130, 246]))
  }

  try {
    // pre-check queue
    const q = await queueStatus({ verbose }).catch(() => null)
    if (q) log(verbose, 'queue', `${q.current_builds}/${q.max_concurrent}`, 'queued', q.queue_length)

    let res
    try {
      res = await curlRequest(`${BASE_URL}/api/build-apk`, {
        method: 'POST',
        formFile: tmpIcon,
        fields,
        timeoutMs: 90000,
        verbose,
      })
    } catch (cause) {
      if (cause?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /429|rate/i.test(String(cause?.message))) {
        throw new WacError('Rate-limit build-apk (10/300s) — tunggu 5 menit', { code: 'RATE_LIMIT', status: 429 })
      }
      throw cause
    }

    if (!res.data) {
      throw new WacError(`build HTTP ${res.status}: ${res.raw.slice(0, 200)}`, {
        code: 'BUILD_HTTP_' + res.status,
        status: res.status,
      })
    }
    if (RETRY.has(res.status)) {
      throw new WacError(`HTTP ${res.status}`, { code: 'HTTP_' + res.status, status: res.status })
    }
    if (res.status === 429) {
      throw new WacError('Rate-limit build-apk (10/300s) — tunggu 5 menit', { code: 'RATE_LIMIT', status: 429 })
    }
    if (!res.ok || res.data.error) {
      throw new WacError(text(res.data.error) || `HTTP ${res.status}`, {
        code: 'BUILD_FAILED',
        status: res.status,
      })
    }

    const base = {
      success: true,
      credit: 'Zane',
      website_url: target,
      app_name: appName,
      package_name: pkg,
      version_name: verName,
      version_code: verCode,
      icon: iconUsed ? iconPath : 'auto',
    }

    // immediate success
    if (res.data.success && res.data.downloadUrl) {
      return {
        ...base,
        mode: 'immediate',
        download_url: res.data.downloadUrl,
        build_time_ms: integer(res.data.buildTime, 0, 0, Number.MAX_SAFE_INTEGER),
        queued: false,
      }
    }

    // queued
    if (res.data.queued || res.data.projectId) {
      const projectId = text(res.data.projectId)
      if (!projectId) throw new WacError('queued tanpa projectId', { code: 'NO_PROJECT_ID' })
      log(verbose, 'queued', projectId, 'pos', res.data.position, 'waitMs', res.data.estimatedWaitTime)

      const deadline = Date.now() + timeoutSec * 1000
      let lastStatus = 'queued'
      while (Date.now() < deadline) {
        await wait(8000)
        const st = await curlRequest(`${BASE_URL}/api/build-status/${encodeURIComponent(projectId)}`, {
          timeoutMs: 20000,
          verbose,
        })
        if (!st.data) {
          log(verbose, 'status http', st.status, st.raw.slice(0, 100))
          continue
        }
        if (st.status === 404) {
          // status expired — mungkin sudah selesai dan dibuang; tidak ada download
          throw new WacError('Status expired — build tidak ditemukan lagi', { code: 'STATUS_EXPIRED', status: 404 })
        }
        if (st.data.error && st.status >= 400) {
          throw new WacError(text(st.data.error), { code: 'STATUS_ERROR', status: st.status })
        }
        lastStatus = text(st.data.status) || lastStatus
        log(verbose, 'status', lastStatus, st.data.progress ?? '')
        if (lastStatus === 'completed') {
          const downloadUrl = text(st.data.downloadUrl)
          if (!downloadUrl) throw new WacError('completed tanpa downloadUrl', { code: 'NO_DOWNLOAD' })
          return {
            ...base,
            mode: 'queued',
            project_id: projectId,
            queued: true,
            position: integer(res.data.position, 0, 0, 999),
            download_url: downloadUrl,
            build_time_ms: integer(st.data.buildTime, 0, 0, Number.MAX_SAFE_INTEGER),
            final_status: lastStatus,
          }
        }
        if (lastStatus === 'failed') {
          throw new WacError(text(st.data.error) || 'Build gagal', { code: 'BUILD_FAILED' })
        }
      }
      throw new WacError(`Timeout ${timeoutSec}s (status: ${lastStatus})`, { code: 'TIMEOUT' })
    }

    throw new WacError(`Respons tidak dikenal: ${JSON.stringify(res.data).slice(0, 200)}`, { code: 'BAD_RESPONSE' })
  } finally {
    if (!iconUsed && tmpIcon) await rm(tmpIcon, { force: true }).catch(() => {})
  }
}

async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(JSON.stringify({
      success: false,
      credit: 'Zane',
      message: 'Usage: node wac.js status | node wac.js build "<url>" [--name N] [--package P] [--version X] [--code N] [--icon path] [--timeout s] [--verbose]',
    }, null, 2))
    process.exitCode = 1
    return
  }

  if (cmd === 'status' || cmd === 'queue') {
    const r = await queueStatus({ verbose: rest.includes('--verbose') })
    console.log(JSON.stringify(r, null, 2))
    return
  }

  if (cmd === 'build' || cmd === 'apk') {
    const args = parseArgs(rest)
    const url = args._[0]
    if (!url) {
      console.log(JSON.stringify({ success: false, credit: 'Zane', message: 'Usage: node wac.js build "<url>" [flags]' }, null, 2))
      process.exitCode = 1
      return
    }
    const result = await buildApk(url, {
      name: args.name,
      packageName: args.package,
      versionName: args.version,
      versionCode: args.code,
      iconPath: args.icon,
      timeoutSec: args.timeoutSec,
      verbose: args.verbose,
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  // shortcut: node wac.js "https://..." = build
  const args = parseArgs(argv)
  const url = args._[0]
  if (!url) {
    console.log(JSON.stringify({
      success: false,
      credit: 'Zane',
      message: 'Usage: node wac.js "https://example.com" | node wac.js status | node wac.js build "url"',
    }, null, 2))
    process.exitCode = 1
    return
  }
  const result = await buildApk(url, {
    name: args.name,
    packageName: args.package,
    versionName: args.version,
    versionCode: args.code,
    iconPath: args.icon,
    timeoutSec: args.timeoutSec,
    verbose: args.verbose,
  })
  console.log(JSON.stringify(result, null, 2))
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isCli) {
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
