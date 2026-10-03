/**
 * Name : Generator.email Full Scraper (Email Baru, Inbox, Baca Pesan + Raw, Delete All)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://generator.email
 * Type : Scraper
 * Function : Buat email temp, list pesan, baca isi penuh (html+text), raw source (.eml-ish), delete all.
 * Note : Native fetch + cheerio. Cookie inbox_ctx=domain/user[/msgId] jadi konteks inbox.
 *        Captcha raw-source di-solve otomatis (kode di-embed di teks SVG).
 *        Usage:
 *          node generatoremail.js new
 *          node generatoremail.js inbox --email user@domain
 *          node generatoremail.js read --email user@domain --id <msgId> [--raw]
 *          node generatoremail.js delete-all --email user@domain
 */

import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import * as cheerio from 'cheerio'

const BASE    = 'https://generator.email'
const TIMEOUT = 25_000
const RETRIES = 3
const RETRYABLE = new Set([403, 408, 425, 429, 500, 502, 503, 504])
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cookies = new Map()   // dipakai bersama: inbox_ctx, surl, embx, dst.

const setCookie = (name, value) => cookies.set(name, value)
const ckHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')

async function req(url, { method = 'GET', body, headers = {}, log } = {}) {
  let lastErr
  for (let i = 0; i <= RETRIES; i++) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), TIMEOUT)
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', Cookie: ckHeader(), ...headers },
        body, signal: ac.signal, redirect: 'follow',
      })
      const getSet = res.headers.getSetCookie?.() ?? []
      for (const c of getSet) {
        const [p] = c.split(';')
        const idx = p.indexOf('=')
        if (idx > 0) setCookie(p.slice(0, idx).trim(), p.slice(idx + 1).trim())
      }
      const txt = await res.text()
      log?.(`[${res.status}] ${method} ${url.slice(0, 80)} (try ${i + 1})`)
      if (RETRYABLE.has(res.status) && i < RETRIES) {
        const ra = Number(res.headers.get('retry-after'))
        await sleep(ra > 0 ? Math.min(ra * 1000, 5000) : Math.min(1000 * 2 ** i, 8000) + Math.random() * 400)
        lastErr = new Error(`HTTP ${res.status}`); continue
      }
      return { res, txt }
    } catch (e) {
      lastErr = e
      if (e.name !== 'AbortError' && !(e instanceof TypeError)) break
      await sleep(Math.min(1000 * 2 ** i, 8000))
    } finally { clearTimeout(t) }
  }
  throw lastErr || new Error(`Fetch gagal: ${url}`)
}

const pathTo = (email) => {
  const [user, domain] = email.split('@')
  return `${domain}/${user.replace(/[^a-zA-Z0-9._-]/g, '')}`
}

function parseSiteData(html) {
  const m = html.match(/SITE_DATA\s*=\s*({[\s\S]*?});?\s*<\/script>/)
  if (!m) return {}
  try { return JSON.parse(m[1].replace(/,(\s*[}\]])/g, '$1')) } catch {
    const g = (k) => html.match(new RegExp(`${k}:"([^"]*)"`))?.[1] ?? null
    const n = (k) => Number(html.match(new RegExp(`${k}:(\\d+)`))?.[1] ?? 0)
    return { cur_user: g('cur_user'), cur_domain: g('cur_domain'), num_mess: n('num_mess'), mess_id_raw: g('mess_id_raw'), secret_del_mess: g('secret_del_mess') }
  }
}

// ── NEW EMAIL ──────────────────────────────────────────────
export async function newEmail({ log } = {}) {
  const { txt } = await req(`${BASE}/email-generator`, { log })
  const $ = cheerio.load(txt)
  const user = $('#userName').attr('value') || $('#userName').val()
  const domain = $('#domainName2').attr('value') || $('#domainName2').val()
  if (!user || !domain) throw new Error('Gagal membuat email: user/domain tidak ditemukan.')
  const email = `${user}@${domain}`.toLowerCase()
  const path = pathTo(email)
  setCookie('surl', path)
  setCookie('embx', encodeURIComponent(JSON.stringify([email])))
  await req(`${BASE}/check_adres_validation3.php`, {
    method: 'POST', log,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
    body: `usr=${encodeURIComponent(user)}&dmn=${encodeURIComponent(domain)}`,
  }).catch(() => {})
  return { email, username: user, domain, inboxUrl: `${BASE}/${path}` }
}

// ── INBOX LIST ─────────────────────────────────────────────
export async function fetchInbox(email, { log } = {}) {
  if (!email?.includes('@')) throw new Error('Email tidak valid.')
  const [user, domain] = email.split('@')
  setCookie('inbox_ctx', encodeURIComponent(`${domain}/${user}/`))
  const { txt } = await req(`${BASE}/${domain}/${user}`, { log })
  const $ = cheerio.load(txt)
  const sd = parseSiteData(txt)
  const messages = []
  $('#email-table .list-group-item').each((_, el) => {
    const $el = $(el)
    const click = $el.attr('onclick') || ''
    const id = click.match(/loadInboxClientSide\('([^']+)'\)/)?.[1]?.replace(/\/$/, '').split('/').pop() || null
    const from = $el.find('[class*="from_div"]').first().text().trim()
    const subj = $el.find('[class*="subj_div"]').first().text().trim()
    const date = $el.find('[class*="time_div"]').first().text().trim()
    if (id || (from && from !== 'From')) messages.push({ id, from: from || null, subject: subj || null, date: date || null })
  })
  const count = parseInt($('#mess_number').text(), 10) || (sd.num_mess ?? messages.length)
  return { email, count, messages }
}

// ── RAW SOURCE (captcha auto) ──────────────────────────────
async function getRawSource(email, id, { log } = {}) {
  const [user, domain] = email.split('@')
  setCookie('inbox_ctx', encodeURIComponent(`${domain}/${user}/${id}`))
  let { res, txt } = await req(`${BASE}/inbox4/?src=${encodeURIComponent(id)}`, { log })
  if (res.status !== 403) return res.ok ? txt : (() => { throw new Error(`Raw gagal: HTTP ${res.status}`) })()
  log?.('  🧩 captcha, solving...')
  const capRes = await req(`${BASE}/inbox4/?src_captcha=1`, { log })
  const cap = JSON.parse(capRes.txt)
  const code = String(cap.svg || '').replace(/<[^>]+>/g, '').replace(/\s+/g, '')
  ;({ res, txt } = await req(`${BASE}/inbox4/?src=${encodeURIComponent(id)}&cap=${encodeURIComponent(code)}&capt=${encodeURIComponent(cap.token)}`, { log }))
  if (!res.ok) throw new Error(`Captcha gagal (HTTP ${res.status})`)
  return txt
}

// ── READ MESSAGE (full: header + body html/text + raw) ─────
export async function readMessage(email, id, { raw = true, log } = {}) {
  if (!email?.includes('@')) throw new Error('Email tidak valid.')
  const [user, domain] = email.split('@')
  setCookie('inbox_ctx', encodeURIComponent(`${domain}/${user}/${id}`))
  const { txt } = await req(`${BASE}/inbox4/`, { log })
  const $ = cheerio.load(txt)
  const from = $('#mail-summary-head [class*="from_div"]').first().text().trim() || null
  const subject = $('#mail-summary-head [class*="subj_div"] h1, #mail-summary-head [class*="subj_div"]').first().text().trim() || null
  const date = $('#mail-summary-head [class*="time_div"]').first().text().trim() || null
  let bodyHtml = null
  for (const sel of ['.mess_bodiyy', '#mail-summary-body', '.mailsrc-body']) {
    const el = $(sel).first()
    if (el.length) { bodyHtml = el.html()?.trim() || null; break }
  }
  const rawSrc = raw ? await getRawSource(email, id, { log }) : null
  return { id, from, subject, date, bodyHtml, bodyText: bodyHtml ? cheerio.load(`<div>${bodyHtml}</div>`)('div').text().trim() : null, raw: rawSrc }
}

// ── DELETE ALL ─────────────────────────────────────────────
export async function deleteAll(email, { log } = {}) {
  const [user, domain] = email.split('@')
  setCookie('inbox_ctx', encodeURIComponent(`${domain}/${user}/`))
  const { txt } = await req(`${BASE}/inbox4/`, { log })
  const sd = parseSiteData(txt)
  if (!sd.secret_del_mess) throw new Error('secret_del_mess tidak ditemukan (inbox mungkin sudah kosong).')
  const out = await req(`${BASE}/mark_remove.php`, {
    method: 'POST', log,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `delete_all=${encodeURIComponent(sd.secret_del_mess)}`,
  })
  if (String(out.txt).trim() !== 'Messages deleted successfully') throw new Error(`Respons tak terduga: ${out.txt.slice(0, 80)}`)
  return { success: true, message: out.txt.trim() }
}

// ── CLI ────────────────────────────────────────────────────
async function main() {
  const { values: v, positionals: [cmd] } = parseArgs({
    args: process.argv.slice(2),
    options: {
      email: { type: 'string' }, id: { type: 'string' }, raw: { type: 'boolean', default: true },
      out: { type: 'string' }, verbose: { type: 'boolean', short: 'v', default: false },
    }, allowPositionals: true,
  })
  const log = v.verbose ? (s) => process.stderr.write(s + '\n') : () => {}
  try {
    let out
    if (cmd === 'new') out = await newEmail({ log })
    else if (cmd === 'inbox') {
      if (!v.email) throw new Error('--email wajib')
      out = await fetchInbox(v.email, { log })
    } else if (cmd === 'read') {
      if (!v.email || !v.id) throw new Error('--email & --id wajib')
      out = await readMessage(v.email, v.id, { raw: v.raw, log })
    } else if (cmd === 'delete-all') {
      if (!v.email) throw new Error('--email wajib')
      out = await deleteAll(v.email, { log })
    } else {
      console.log(`Usage:\n  node generatoremail.js new\n  node generatoremail.js inbox --email <e>\n  node generatoremail.js read --email <e> --id <id> [--raw]\n  node generatoremail.js delete-all --email <e>\nOpsi: --verbose --out`); return
    }
    if (v.out) await writeFile(v.out, JSON.stringify(out, null, 2), 'utf8')
    console.log(JSON.stringify(out, null, 2))
  } catch (e) { console.error(`❌ ${e.message}`); process.exit(1) }
}

export default { newEmail, fetchInbox, readMessage, deleteAll }
if (import.meta.url === `file://${process.argv[1]}`) main()
                                          
