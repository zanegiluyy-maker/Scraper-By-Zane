/**
 * Name : Free Fire Stalk Scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://freefire.my.id/stalk
 * Type : Scraper
 * Function : nyari profil player Free Fire by UID + nickname
 * Note : error fix sndiri
 */
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const BASE = 'https://freefire.my.id'
const API = `${BASE}/api`
const DEFAULT_UA = 'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36'
const RETRYABLE = new Set(['RATE_LIMITED', 'UPSTREAM_UNAVAILABLE', 'UPSTREAM_ERROR', 'NETWORK_ERROR'])

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

class FreeFireError extends Error {
  constructor(message, { code = 'FREE_FIRE_ERROR', status = 0, cause } = {}) {
    super(message, { cause })
    this.name = 'FreeFireError'
    this.code = code
    this.status = status
  }
}

const log = (logger, level, message, meta = {}) => {
  if (typeof logger !== 'function') return
  try {
    logger({ level, message, timestamp: new Date().toISOString(), ...meta })
  } catch {
    return
  }
}

function buildHeaders(userAgent, extra = {}) {
  return {
    Accept: 'application/json',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    Origin: BASE,
    Referer: `${BASE}/stalk`,
    'User-Agent': userAgent,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    ...extra
  }
}

/**
 * Selesaikan proof-of-work handshake: cari nonce base36 agar SHA256 punya N digit nol di depan.
 * @param {string} challenge - Token challenge dari `/api/token`
 * @param {number} difficulty - Jumlah digit nol yang diminta
 * @param {{maxAttempts?:number}} [options]
 * @returns {string} Nonce base36
 */
export function solveProofOfWork(challenge, difficulty, { maxAttempts = 50_000_000 } = {}) {
  const prefix = '0'.repeat(Math.min(8, Math.max(1, Number(difficulty) || 4)))
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const nonce = attempt.toString(36)
    if (sha256(`${challenge}:${nonce}`).startsWith(prefix)) return nonce
  }
  throw new FreeFireError('Proof-of-work tidak selesai dalam batas percobaan.', { code: 'POW_FAILED' })
}

function combineSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function readJson(response) {
  const raw = await response.text()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch (cause) {
    throw new FreeFireError('Respons freefire.my.id bukan JSON.', { code: 'INVALID_JSON', status: response.status, cause })
  }
}

function mapError(response, data) {
  const message = text(data.error) || `HTTP ${response.status}`
  const codes = { 400: 'INVALID_INPUT', 401: 'HANDSHAKE_REJECTED', 403: 'BLOCKED', 404: 'NOT_FOUND', 429: 'RATE_LIMITED' }
  let code = codes[response.status]
  if (!code) {
    if (data.maintenance) code = 'UPSTREAM_UNAVAILABLE'
    else if (response.status >= 500) code = 'UPSTREAM_ERROR'
    else code = 'FREE_FIRE_ERROR'
  }
  return new FreeFireError(message, { code, status: response.status })
}

async function handshake(scope, { userAgent, signal, timeoutMs, logger }) {
  const started = Date.now()
  const response = await fetch(`${API}/token?scope=${encodeURIComponent(scope)}`, {
    headers: buildHeaders(userAgent),
    signal: combineSignal(timeoutMs, signal)
  }).catch((cause) => {
    throw new FreeFireError('Gagal menjangkau freefire.my.id.', { code: 'NETWORK_ERROR', cause })
  })
  const data = await readJson(response)
  if (!response.ok) throw mapError(response, data)
  const nonce = solveProofOfWork(data.challenge, data.difficulty)
  log(logger, 'debug', 'handshake selesai', { ms: Date.now() - started, difficulty: data.difficulty })
  return {
    'x-fp-token': data.token,
    'x-fp-pow': nonce,
    'x-fp-sig': sha256(`${data.token}|${scope}|${nonce}`)
  }
}

async function callApi(scope, params, options) {
  const { userAgent = DEFAULT_UA, signal, logger } = options
  const timeoutMs = Number(options.timeoutMs) || 20_000
  const retries = Math.min(3, Math.max(0, Number(options.retries ?? 2)))
  const query = new URLSearchParams(params)
  let failure
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const headers = buildHeaders(userAgent, await handshake(scope, { userAgent, signal, timeoutMs, logger }))
      const response = await fetch(`${BASE}${scope}?${query}`, { headers, signal: combineSignal(timeoutMs, signal) }).catch((cause) => {
        throw new FreeFireError('Permintaan ke API gagal.', { code: 'NETWORK_ERROR', cause })
      })
      const data = await readJson(response)
      if (!response.ok) throw mapError(response, data)
      return data
    } catch (error) {
      failure = error
      if (!RETRYABLE.has(error.code) || attempt === retries) break
      const wait = 500 * 2 ** attempt
      log(logger, 'warn', 'percobaan ulang', { attempt: attempt + 1, wait, code: error.code })
      await sleep(wait)
    }
  }
  throw failure
}

const failure = (error) => ({
  ok: false,
  service: 'freefire-stalk',
  why: error.message || 'Permintaan gagal.',
  code: error.code || 'FREE_FIRE_ERROR',
  status: error.status || 0
})

/**
 * Ambil profil publik pemain Free Fire berdasarkan UID (stalk).
 * @param {string|number} uid - UID pemain, 6-15 digit
 * @param {{timeoutMs?:number,retries?:number,signal?:AbortSignal,logger?:Function}} [options]
 * @returns {Promise<object>} Hasil `{ok:true, ...}` atau `{ok:false, why, code}`
 */
export async function freefireStalk(uid, options = {}) {
  const value = String(uid ?? '').trim()
  if (!/^\d{6,15}$/.test(value)) return { ok: false, service: 'freefire-stalk', why: 'UID harus angka dengan panjang 6-15 digit.', code: 'INVALID_INPUT' }
  try {
    log(options.logger, 'info', 'mengambil profil pemain', { uid: value })
    const data = await callApi('/api/ff', { uid: value }, options)
    const player = data.player || {}
    return {
      ok: true,
      service: 'freefire-stalk',
      uid: text(data.meta?.uid) || value,
      nickname: text(player.nickname),
      region: text(player.region) || text(data.meta?.region),
      level: Number(player.level) || 0,
      rank: Number(player.rank) || null,
      rankingPoints: Number(player.rankingPoints) || null,
      csRank: Number(player.csRank) || null,
      liked: Number(player.liked) || 0,
      primeLevel: Number(player.primeInfo?.primeLevel) || 0,
      guild: data.guild && Object.keys(data.guild).length ? data.guild : null,
      social: data.social && Object.keys(data.social).length ? data.social : null,
      credit: data.credit && Object.keys(data.credit).length ? data.credit : null,
      ban: data.ban && Object.keys(data.ban).length ? data.ban : null,
      pet: data.pet ?? null,
      character: player.equippedCharacter ? { name: player.equippedCharacter.name, icon: player.equippedCharacter.icon } : null,
      avatarUrl: player.equippedCharacterIconUrl || player.avatarUrl || null,
      createdAt: player.createAt ? new Date(Number(player.createAt) * 1000).toISOString() : null,
      lastLoginAt: player.lastLoginAt && player.lastLoginAt !== '0' ? new Date(Number(player.lastLoginAt) * 1000).toISOString() : null,
      raw: data
    }
  } catch (error) {
    return failure(error)
  }
}

/**
 * Cari akun Free Fire berdasarkan nickname (minimal 3 karakter).
 * @param {string} nickname - Nama panggilan pemain
 * @param {{timeoutMs?:number,retries?:number,signal?:AbortSignal,logger?:Function}} [options]
 * @returns {Promise<object>} Hasil pencarian atau objek error
 */
export async function freefireSearch(nickname, options = {}) {
  const value = text(nickname)
  if (value.length < 3) return { ok: false, service: 'freefire-stalk', why: 'Nickname minimal 3 karakter.', code: 'INVALID_INPUT' }
  try {
    const data = await callApi('/api/search', { q: value }, options)
    return {
      ok: true,
      service: 'freefire-stalk',
      query: value,
      maintenance: Boolean(data.maintenance),
      results: (data.results || []).map((item) => ({
        uid: text(item.accountid ?? item.accountId ?? item.uid),
        nickname: text(item.nickname),
        region: text(item.region),
        level: Number(item.level) || 0
      }))
    }
  } catch (error) {
    return failure(error)
  }
}

export const freefirePlayer = freefireStalk
export default freefireStalk

function formatProfile(result) {
  if (!result.ok) return `Gagal: ${result.why} (${result.code})`
  const lines = [
    `${result.nickname || 'Tanpa nama'} - UID ${result.uid}`,
    `Level ${result.level} | Region ${result.region || '-'} | RP ${result.rankingPoints ?? '-'}`,
    result.guild?.guildName ? `Guild: ${result.guild.guildName} (${result.guild.guildLevel || '-'}, ${result.guild.memberNum || 0}/${result.guild.capacity || 0} anggota)` : 'Guild: -',
    result.credit?.creditScore != null ? `Credit score: ${result.credit.creditScore}` : null,
    result.character?.name ? `Karakter: ${result.character.name}` : null,
    result.ban ? `Status: ${result.ban.isBanned ? `BANNED (${result.ban.banPeriod || '?'})` : 'AKTIF'}` : null
  ].filter(Boolean)
  return lines.join('\n')
}

async function cli() {
  const [mode = 'stalk', target = ''] = process.argv.slice(2)
  if (!target) {
    console.log('Usage:\n  node skrep/freefire.js stalk <uid>\n  node skrep/freefire.js search <nickname>\n  node skrep/freefire.js raw <uid>')
    process.exitCode = 1
    return
  }
  if (mode === 'search') {
    const result = await freefireSearch(target)
    console.log(JSON.stringify(result, null, 2))
    return
  }
  const result = await freefireStalk(target)
  console.log(mode === 'raw' ? JSON.stringify(result, null, 2) : formatProfile(result))
  if (!result.ok) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await cli()
