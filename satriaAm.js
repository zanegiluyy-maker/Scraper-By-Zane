/**
 * Name : SATRIAM Alight Motion Premium Scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://satriam.satriadeveloperz.workers.dev
 * Type : Scraper
 * Function : Kirim magic link Alight Motion (stage 1) lalu verifikasi & aktifkan premium (stage 2).
 * Note : Native fetch (Node v18+), zero dependency. Retry + exponential backoff + jitter
 *        untuk 403/429/5xx/timeout, rotasi User-Agent tiap percobaan, honor header Retry-After.
 *        Usage: node satriam.js send <email> | verify <email> <magicLink> [--json] [--verbose] [--raw]
 */

import { parseArgs } from 'node:util'

const BASE    = 'https://satriam.satriadeveloperz.workers.dev'
const API     = `${BASE}/api/satriam`
const TIMEOUT = 30_000
const RETRIES = 4
const RETRYABLE = new Set([403, 408, 425, 429, 500, 502, 503, 504, 520, 522, 524])

const UAS = [
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function headers(i) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
    'User-Agent': UAS[i % UAS.length],
    Origin: BASE,
    Referer: `${BASE}/api/satriam`,
  }
}

/** POST JSON dengan retry, backoff+jitter, rotasi UA, dan Retry-After. */
async function post(path, body, log = () => {}) {
  let lastErr = null
  for (let i = 0; i <= RETRIES; i++) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), TIMEOUT)
    try {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: headers(i),
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      const txt = await res.text()
      let data = null
      try { data = JSON.parse(txt) } catch (_) {}
      log(`[${res.status}] POST ${path} (percobaan ${i + 1})`)

      if (RETRYABLE.has(res.status) && i < RETRIES) {
        const ra = Number(res.headers.get('retry-after'))
        const wait = ra > 0 ? ra * 1000 : Math.min(1500 * 2 ** i, 15_000) + Math.random() * 500
        lastErr = new Error(data?.message || `HTTP ${res.status}`)
        await sleep(wait)
        continue
      }
      if (!data) throw new Error(`Respons bukan JSON (HTTP ${res.status}): ${txt.slice(0, 120)}`)
      if (!res.ok || data.success === false) throw new Error(data.message || data.error || `HTTP ${res.status}`)
      return data
    } catch (e) {
      lastErr = e
      const transient = e.name === 'AbortError' || e instanceof TypeError // timeout / network
      if (!transient || i === RETRIES) break
      await sleep(Math.min(1500 * 2 ** i, 15_000))
    } finally {
      clearTimeout(t)
    }
  }
  throw lastErr || new Error('Request gagal.')
}

/**
 * Stage 1: kirim magic link ke email.
 * @param {string} email
 * @returns {Promise<{success: boolean, email: string, message: string}>}
 */
export async function sendLink(email, opts = {}) {
  email = String(email || '').trim()
  if (!EMAIL_RE.test(email)) throw new Error('Format email tidak valid.')
  return post('/send-link', { email }, opts.log)
}

/**
 * Normalisasi magic link Firebase ke bentuk action URL seperti di docs.
 * Terima wrapper `/__/auth/links?link=<encoded>` maupun `/__/auth/action?...oobCode=...`.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeMagicLink(raw) {
  let s = String(raw || '').trim().replace(/^["']|["']$/g, '')
  let u
  try { u = new URL(s) } catch (_) { throw new Error('Magic link bukan URL valid.') }

  // Buka wrapper `link=` (bisa berlapis) sampai ketemu URL yang punya oobCode
  for (let i = 0; i < 3 && !u.searchParams.get('oobCode'); i++) {
    const inner = u.searchParams.get('link') || u.searchParams.get('deep_link_id')
    if (!inner) break
    try { u = new URL(inner) } catch (_) { break }
  }

  const oob = u.searchParams.get('oobCode')
  if (!oob) throw new Error('Magic link tidak valid: oobCode tidak ditemukan.')

  const mode = u.searchParams.get('mode') || 'signIn'
  const apiKey = u.searchParams.get('apiKey')
  const q = new URLSearchParams({ mode, oobCode: oob })
  if (apiKey) q.set('apiKey', apiKey)
  return `https://alight-creative.firebaseapp.com/__/auth/action?${q}`
}

/**
 * Stage 2: verifikasi magic link & aktifkan premium.
 * @param {string} email
 * @param {string} magicLink - URL firebase (wrapper /links?link= atau /action?) dari email
 * @param {{log?: Function, raw?: boolean}} [opts] raw=true kirim link asli tanpa normalisasi
 */
export async function verifyLink(email, magicLink, opts = {}) {
  email = String(email || '').trim()
  if (!EMAIL_RE.test(email)) throw new Error('Format email tidak valid.')
  const link = opts.raw ? String(magicLink).trim() : normalizeMagicLink(magicLink)
  opts.log?.(`magicLink dikirim: ${link.slice(0, 90)}...`)
  return post('/verify-link', { email, magicLink: link }, opts.log)
}

export default { sendLink, verifyLink, normalizeMagicLink }

// ── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: v, positionals: [cmd, email, link] } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: 'boolean', short: 'j', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      raw: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  })
  const log = v.verbose ? (s) => process.stderr.write(s + '\n') : () => {}

  try {
    let out
    if (cmd === 'send') out = await sendLink(email, { log })
    else if (cmd === 'verify') out = await verifyLink(email, link, { log, raw: v.raw })
    else {
      console.log('Usage:\n  node satriam.js send <email>\n  node satriam.js verify <email> "<magicLink>"\n  opsi: --json --verbose --raw (kirim link apa adanya)')
      process.exit(0)
    }
    if (v.json) console.log(JSON.stringify(out, null, 2))
    else {
      console.log(`✅ ${out.message}`)
      if (out.membershipStatus) console.log(`📦 ${out.planName} | ${out.membershipStatus} | s/d ${out.validUntil}`)
      console.log('\n' + JSON.stringify(out, null, 2))
    }
  } catch (e) {
    if (v.json) console.log(JSON.stringify({ success: false, error: e.message }, null, 2))
    else console.error(`❌ ${e.message}`)
    process.exit(1)
  }
}
