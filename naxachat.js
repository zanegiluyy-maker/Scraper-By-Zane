/**
 * Name : NaXa Chat Scraper (chat AI doang + auto register bypass quota)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://www.naxachat.com
 * Type : Scraper
 * Function : ask (chat AI), register (akun baru otomatis lewat email temp)
 * Note : error fix sendiri. Bypass: Guest cuma 3/bulan per IP, login = Free 20.
 *        Kalau kuota habis, script auto bikin akun baru dari email temp (generator.email).
 *        Self-contained: zero dep, tinggal `node naxachat.js`.
 *        Rotation: akun disimpan di pool (naxa_session.json), dipakai round-robin;
 *        kuota abis -> tandai mati -> pakai akun berikutnya -> bikin baru kalau habis semua.
 *        Usage:
 *          node naxachat.js ask "halo"
 *          node naxachat.js ask "halo" --history $'user: ...\nassistant: ...'
 *          node naxachat.js register -n 3      # tambah 3 akun ke pool
 *          node naxachat.js pool                # lihat kuota tiap akun
 */

import { writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const SITE     = 'https://www.naxachat.com'
const SUPA     = 'https://lhncvnrreuxjhyzcgzli.supabase.co'
const APIKEY   = 'sb_publishable_VE8NUgKll5s4p9tZ-i9D9w_CoX7bkbb'
const SESSION  = new URL(import.meta.url).pathname.replace(/naxachat\.js$/, 'naxa_session.json')
const TIMEOUT  = 45_000
const RETRIES  = 3
const RETRYABLE = new Set([403, 408, 425, 429, 500, 502, 503, 504])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function req(url, { method = 'GET', headers = {}, body, timeout = TIMEOUT, log } = {}) {
  let lastErr
  for (let i = 0; i <= RETRIES; i++) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeout)
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          ...headers,
        },
        body, signal: ac.signal, redirect: 'follow',
      })
      if (RETRYABLE.has(res.status) && i < RETRIES && res.status !== 429) {
        lastErr = new Error(`HTTP ${res.status} ${url}`)
        await sleep(Math.min(2 ** i * 1000, 8000))
        continue
      }
      return res
    } catch (e) {
      lastErr = e
      if (i === RETRIES) break
      await sleep(Math.min(2 ** i * 1000, 8000))
    } finally {
      clearTimeout(t)
    }
  }
  throw lastErr
}

const today = () => new Date().toISOString().slice(0, 10)

/** Pool akun (banyak). File lama (object tunggal) tetap dibaca. */
const loadStore = async () => {
  try {
    const d = JSON.parse(await readFile(SESSION, 'utf8'))
    const arr = Array.isArray(d) ? d : Array.isArray(d?.sessions) ? d.sessions : d ? [d] : []
    return { pool: arr.filter(Boolean), cursor: Number(d?.cursor) || 0 }
  } catch {
    return { pool: [], cursor: 0 }
  }
}
const saveStore = (pool, cursor = 0) =>
  writeFileSync(SESSION, JSON.stringify({ cursor, sessions: pool }, null, 2))
const alive = (s) =>
  s && !s.dead && s.access_token &&
  (!s.usedDay || s.usedDay !== today() || !Number(s.limit) || Number(s.used || 0) < Number(s.limit))
const burn = (s) => { s.usedDay = today(); s.used = Number(s.limit || 1) }

const supaPost = async (path, payload, { headers = {} } = {}) => {
  const res = await req(`${SUPA}${path}`, {
    method: 'POST',
    headers: { apikey: APIKEY, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

// ── EMAIL TEMP (generator.email, tanpa dep) ───────────────
const attrOf = (html, id, key) =>
  html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))?.[0]?.match(new RegExp(`${key}="([^"]+)"`))?.[1]

async function newMail() {
  const res = await req('https://generator.email/email-generator')
  const html = await res.text()
  const user = attrOf(html, 'userName', 'value')
  const domain = attrOf(html, 'domainName2', 'value')
  if (!user || !domain) throw new Error('gagal bikin email temp')
  return { email: `${user}@${domain}`.toLowerCase() }
}

// ── REGISTER: email temp -> signup -> klik link verifikasi -> login ──
export async function register({ log } = {}) {
  const { email } = await newMail()
  const password = `Nx${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  log?.(`email: ${email}`)

  const su = await supaPost('/auth/v1/signup', { email, password })
  if (!su.ok && su.data.error_code !== 'user_already_exists') {
    throw new Error(`signup gagal: ${su.data.msg || su.status}`)
  }
  log?.('signup ok, nunggu email konfirmasi...')

  const link = await waitVerify(email, { log })
  await req(link, { log })
  log?.('email terkonfirmasi')

  const tk = await supaPost('/auth/v1/token?grant_type=password', { email, password })
  if (!tk.ok) throw new Error(`login gagal: ${tk.data.msg || tk.status}`)

  const session = {
    email, password,
    access_token: tk.data.access_token,
    refresh_token: tk.data.refresh_token,
    expires_at: tk.data.expires_at,
    used: 0, limit: 0, usedDay: today(),
    created_at: new Date().toISOString(),
  }
  const { pool, cursor } = await loadStore()
  const i = pool.findIndex((x) => x.email === session.email)
  if (i >= 0) pool[i] = session
  else pool.push(session)
  saveStore(pool, cursor)
  log?.(`akun baru (${pool.length} di pool): ${session.email}`)
  return session
}

/** Ambil HTML inbox generator.email (cookie inbox_ctx bikin body pesan ikut ter-render). */
async function inboxHtml(email, { log } = {}) {
  const [user, domain] = email.split('@')
  const res = await req(`https://generator.email/${domain}/${user}`, {
    headers: {
      Cookie: `inbox_ctx=${encodeURIComponent(`${domain}/${user}/`)}; embx=${encodeURIComponent(JSON.stringify([email]))}; surl=${domain}/${user}`,
    },
    log,
  })
  return res.ok ? res.text() : ''
}

/** Poll inbox sampai link verifikasi supabase muncul (maks 120 detik). */
async function waitVerify(email, { log, tries = 40, wait = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const html = await inboxHtml(email, { log })
      const m = html.match(/https:\/\/lhncvnrreuxjhyzcgzli\.supabase\.co\/auth\/v1\/verify\?[^"'<> ]+/)
      if (m) return m[0].replace(/&amp;/g, '&')
    } catch (e) {
      log?.(`  inbox error: ${e.message}`)
    }
    log?.(`  inbox ${i + 1}/${tries}`)
    await sleep(wait)
  }
  throw new Error('email verifikasi tidak masuk')
}

// ── TOKEN: rotate akun di pool, refresh kalau expired, register kalau mentok ──
/** Pilih akun sehat dari pool (round-robin). Return { session, cursor }. */
export async function pickSession({ fresh = false, log } = {}) {
  if (fresh) return { session: await register({ log }), cursor: 0 }
  const { pool, cursor } = await loadStore()
  if (!pool.length) return { session: await register({ log }), cursor: 0 }

  const now = Math.floor(Date.now() / 1000)
  for (let k = 0; k < pool.length; k++) {
    const i = (cursor + k) % pool.length
    const s = pool[i]
    if (!alive(s)) continue
    const next = (i + 1) % pool.length
    if (s.expires_at && s.expires_at - now > 120) {
      saveStore(pool, next)
      return { session: s, cursor: i }
    }
    const r = await supaPost('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh_token })
    if (r.ok) {
      s.access_token = r.data.access_token
      s.refresh_token = r.data.refresh_token
      s.expires_at = r.data.expires_at
      saveStore(pool, next)
      log?.(`token di-refresh (${s.email})`)
      return { session: s, cursor: i }
    }
    s.dead = true
    log?.(`refresh gagal, akun ditandai mati: ${s.email}`)
    saveStore(pool, cursor)
  }
  return { session: await register({ log }), cursor: 0 }
}

/** Tulis pemakaian akun (dari header x-naxa-usage-*) ke pool. */
async function recordUsage(session, used, limit, { dead = false } = {}) {
  if (!session?.email) return
  const { pool } = await loadStore()
  const row = pool.find((x) => x.email === session.email)
  if (!row) return
  row.usedDay = today()
  row.used = dead ? Number(limit || 1) : Math.max(0, Number(used) || 0)
  row.limit = Number(limit) || row.limit || 0
  saveStore(pool)
}

// ── CHAT ───────────────────────────────────────────────────
const QUOTA_CODES = ['GUEST_LIMIT_REACHED', 'DAILY_LIMIT_REACHED', 'AUTH_EXPIRED', 'AUTH_REQUIRED']

/** `ask("halo")` -> balasan AI. history opsional [{role,content}] */
export async function ask(prompt, { history = [], token, fresh = false, log, personaId, depth = 0 } = {}) {
  const session = token ? { access_token: token } : (await pickSession({ fresh, log })).session
  const msgs = [...history, { role: 'user', content: String(prompt) }]
  const body = {
    history: msgs,
    chatId: null,
    personaId: personaId || null,
    memoryEnabled: false,
    imageMode: false,
    replyMode: 'normal',
    conversationMode: null,
  }
  const res = await req(`${SITE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
    timeout: 180_000,
    log,
  })
  const used = res.headers.get('x-naxa-usage-used')
  const limit = res.headers.get('x-naxa-usage-limit')
  const usage = {
    tier: res.headers.get('x-naxa-tier'),
    used: used === null ? null : Number(used),
    limit: limit === null ? null : Number(limit),
    account: session.email || null,
  }
  if (usage.used !== null && usage.limit !== null) await recordUsage(session, usage.used, usage.limit)

  const text = await res.text()

  if (res.status === 429 || text.startsWith('{')) {
    const err = (() => { try { return JSON.parse(text) } catch { return { error: text } } })()
    if (QUOTA_CODES.includes(err.code)) {
      await recordUsage(session, Number(err.used ?? 1), Number(err.limit ?? 20), { dead: true })
      if (depth >= 8) throw new Error('kuota semua akun habis, coba lagi nanti')
      log?.(`kuota habis di ${session.email || 'guest'} (${err.code}), rotate akun...`)
      return ask(prompt, { history, log, personaId, depth: depth + 1 })
    }
    throw new Error(err.error || err.message || `HTTP ${res.status}`)
  }
  return { text, usage }
}

// ── CLI ────────────────────────────────────────────────────
const { values: v, positionals } = parseArgs({
  options: {
    history: { type: 'string', short: 'H' },
    fresh:   { type: 'boolean', default: false },
    json:    { type: 'boolean', default: false },
    count:   { type: 'string', short: 'n', default: '1' },
    quiet:   { type: 'boolean', short: 'q', default: false },
  },
  allowPositionals: true,
})

const cmd = positionals[0]
const log = v.quiet ? null : (m) => console.error('[*]', m)

const parseHistory = (s) =>
  (s || '').split(/\n+/).filter(Boolean).map((l) => {
    const m = l.match(/^(user|assistant|system)\s*:\s*(.*)$/i)
    return m ? { role: m[1].toLowerCase(), content: m[2] } : { role: 'assistant', content: l }
  })

try {
  if (!cmd || !['ask', 'register', 'pool'].includes(cmd)) {
    console.log('pakai: node naxachat.js ask "<pesan>" | register [-n 3] | pool')
    process.exit(1)
  }
  if (cmd === 'register') {
    const n = Math.max(1, Math.min(20, Number(v.count) || 1))
    const made = []
    for (let i = 0; i < n; i++) {
      const s = await register({ log })
      made.push({ email: s.email, expires_at: s.expires_at })
    }
    console.log(JSON.stringify(made, null, 2))
  } else if (cmd === 'pool') {
    const { pool, cursor } = await loadStore()
    console.log(JSON.stringify({
      total: pool.length,
      alive: pool.filter(alive).length,
      cursor,
      accounts: pool.map((s) => ({
        email: s.email,
        used: Number(s.used || 0),
        limit: Number(s.limit || 0),
        usedDay: s.usedDay || null,
        dead: !!s.dead,
        alive: alive(s),
        created: s.created_at || null,
      })),
    }, null, 2))
  } else {
    const prompt = positionals.slice(1).join(' ').trim()
    if (!prompt) throw new Error('pesan kosong')
    const out = await ask(prompt, { history: parseHistory(v.history), fresh: v.fresh, log })
    if (v.json) console.log(JSON.stringify(out, null, 2))
    else console.log(out.text)
  }
} catch (e) {
  console.error('[!]', e.message || e)
  process.exit(1)
}
