/**
 * Name : MangaDex Scraper (search, detail manga, chapter list, halaman baca, latest)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://mangadex.org (API: https://api.mangadex.org)
 * Type : Scraper
 * Function : search,manga,chapters,chapter (link gambar),latest -> output JSON lengkap
 * Note : error fix sendiri. DNS ISP nge-hijack mangadex (nunjuk aduankonten.id),
 *        jadi resolve IP asli lewat DoH (1.1.1.1 / dns.google) + custom lookup bawaan Node.
 *        Zero dep, native https, rate-limit aware (5 req/detik).
 *        Usage (output JSON ke layar, tanpa nyimpan gambar ke disk):
 *          node mangadex.js search "one piece" --limit 5
 *          node mangadex.js manga <id|url>
 *          node mangadex.js chapters <id|url> --lang en --limit 50
 *          node mangadex.js chapter <chapterId>      # lengkap: cover, url halaman, data-saver
 *          node mangadex.js latest --limit 10
 */

import { request as httpsReq } from 'node:https'
import { lookup as dnsLookup } from 'node:dns'
import { parseArgs } from 'node:util'

const API   = 'https://api.mangadex.org'
const SITE  = 'https://mangadex.org'
const CDN   = 'https://uploads.mangadex.org'
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const TIMEOUT  = 30_000
const RETRIES  = 3

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── DNS OVER HTTPS (ISP blokir mangadex, ini bypass-nya) ──
const ipCache = new Map()

async function doh(hostname) {
  if (ipCache.has(hostname)) return ipCache.get(hostname)
  for (const resolver of ['https://1.1.1.1/dns-query', 'https://dns.google/resolve']) {
    try {
      const r = await fetch(`${resolver}?name=${encodeURIComponent(hostname)}&type=A`, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(8000),
      })
      const j = await r.json()
      const ip = (j.Answer || []).find((a) => a.type === 1)?.data
      if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        ipCache.set(hostname, ip)
        return ip
      }
    } catch { /* coba resolver berikutnya */ }
  }
  return null
}

function lookupOverride(hostname, opts, cb) {
  const ip = ipCache.get(hostname)
  if (ip) {
    if (opts?.all) return process.nextTick(() => cb(null, [{ address: ip, family: 4 }]))
    return process.nextTick(() => cb(null, ip, 4))
  }
  dnsLookup(hostname, opts, cb)
}

/** Request HTTPS native + custom lookup (IP dari DoH). */
async function req(url, { method = 'GET', headers = {}, body, timeout = TIMEOUT } = {}) {
  const u = new URL(url)
  await doh(u.hostname)

  for (let i = 0; i <= RETRIES; i++) {
    const out = await new Promise((resolve) => {
      const rq = httpsReq(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method,
          servername: u.hostname,
          lookup: lookupOverride,
          headers: { 'User-Agent': UA, Accept: 'application/json, text/html;q=0.9, */*;q=0.8', ...headers },
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
        },
      )
      rq.setTimeout(timeout, () => rq.destroy(new Error('timeout')))
      rq.on('error', (e) => resolve({ status: 0, error: e.message }))
      if (body) rq.write(body)
      rq.end()
    })

    if (out.status === 429 && i < RETRIES) {
      const wait = Math.min(Number(out.headers?.['retry-after'] || 1) * 1000 || 1200 * (i + 1), 8000)
      await sleep(wait)
      continue
    }
    if ((out.status >= 500 || out.status === 0) && i < RETRIES) {
      await sleep(800 * (i + 1))
      continue
    }
    return out
  }
  throw new Error('request gagal terus-terusan')
}

/** Parameter array di MangaDex harus pakai key[] (includes[]=x). */
const ARR_KEYS = new Set(['includes', 'translatedLanguage', 'contentRating', 'availableTranslatedLanguage'])

const qs = (params = {}) => {
  const p = new URLSearchParams()
  for (const [rawKey, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    const key = (Array.isArray(v) || ARR_KEYS.has(rawKey)) && !rawKey.endsWith('[]') ? `${rawKey}[]` : rawKey
    for (const one of Array.isArray(v) ? v : [v]) p.append(key, one)
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

async function api(path, params) {
  const res = await req(`${API}${path}${qs(params)}`)
  let data = null
  try { data = JSON.parse(res.text) } catch { /* bukan json */ }
  if (res.status >= 400 || data?.result === 'error') {
    const detail = data?.errors?.map((e) => `${e.title}: ${e.detail}`).join(' | ') || res.text.slice(0, 200)
    const err = new Error(`HTTP ${res.status} — ${detail}`)
    err.status = res.status
    throw err
  }
  await sleep(250) // jaga rate limit 5 req/detik
  return data
}

// ── HELPERS ───────────────────────────────────────────────
const pick = (obj, langs = ['en', 'ja-ro', 'ja']) => {
  if (!obj) return ''
  for (const l of langs) if (obj[l]) return obj[l]
  return obj[Object.keys(obj)[0]] || ''
}
const rel = (manga, type) =>
  (manga.relationships || []).filter((r) => r.type === type).map((r) => ({
    id: r.id,
    name: r.attributes?.name || null,
  }))
const coverOf = (manga) => {
  const c = (manga.relationships || []).find((r) => r.type === 'cover_art' && r.attributes?.fileName)
  if (!c) return null
  return {
    id: c.id,
    fileName: c.attributes.fileName,
    volume: c.attributes.volume || null,
    locale: c.attributes.locale || null,
    url: `${CDN}/covers/${manga.id}/${c.attributes.fileName}.512.jpg`,
    urlOriginal: `${CDN}/covers/${manga.id}/${c.attributes.fileName}`,
  }
}
const idOf = (input) => {
  const m = String(input).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  if (!m) throw new Error(`bukan id/URL MangaDex: ${input}`)
  return m[1]
}

const flattenAlt = (alt) =>
  (Array.isArray(alt) ? alt : Object.entries(alt || {}).map(([lang, t]) => ({ [lang]: t })))
    .flatMap((o) => Object.entries(o || {}).map(([lang, title]) => ({ lang, title })))

const mangaBrief = (m) => ({
  id: m.id,
  title: pick(m.attributes?.title),
  altTitles: flattenAlt(m.attributes?.altTitles),
  description: m.attributes?.description || {},
  year: m.attributes?.year ?? null,
  status: m.attributes?.status || null,
  tags: (m.attributes?.tags || []).map((t) => t.attributes?.name),
  authors: rel(m, 'author'),
  artists: rel(m, 'artist'),
  demographic: m.attributes?.publicationDemographic || null,
  contentRating: m.attributes?.contentRating || null,
  originalLanguage: m.attributes?.originalLanguage || null,
  availableLanguages: m.attributes?.availableTranslatedLanguages || [],
  lastChapter: m.attributes?.lastChapter || null,
  lastVolume: m.attributes?.lastVolume || null,
  latestUploadedChapter: m.attributes?.latestUploadedChapter || null,
  cover: coverOf(m),
  url: `${SITE}/title/${m.id}`,
  createdAt: m.attributes?.createdAt || null,
  updatedAt: m.attributes?.updatedAt || null,
})

const chapterBrief = (c, mangaFallback) => {
  const manga = (c.relationships || []).find((r) => r.type === 'manga')
  const groups = (c.relationships || []).filter((r) => r.type === 'scanlation_group')
  return {
    id: c.id,
    chapter: c.attributes?.chapter ?? null,
    volume: c.attributes?.volume ?? null,
    title: c.attributes?.title || null,
    pages: c.attributes?.pages ?? 0,
    language: c.attributes?.translatedLanguage || null,
    scanlator: c.attributes?.scanlator || null,
    groups: groups.map((g) => ({ id: g.id, name: g.attributes?.name || null })),
    externalUrl: c.attributes?.externalUrl || null,
    publishAt: c.attributes?.publishAt || null,
    readableAt: c.attributes?.readableAt || null,
    manga: manga
      ? { id: manga.id, title: pick(manga.attributes?.title) }
      : mangaFallback || null,
    url: `${SITE}/chapter/${c.id}`,
  }
}

// ── COMMANDS ──────────────────────────────────────────────
export async function search(q, { limit = 10, offset = 0, status, lang, log } = {}) {
  const norm = String(q || '').replace(/\s+/g, ' ').trim()
  log?.(`search: ${norm}`)
  const run = (title) =>
    api('/manga', {
      title,
      limit: Math.min(limit, 100),
      offset,
      includes: ['cover_art', 'author', 'artist'],
      contentRating: ['safe', 'suggestive', 'erotica'],
      ...(status ? { status } : {}),
      ...(lang ? { availableTranslatedLanguage: lang } : {}),
    })

  let used = norm
  let d = await run(norm)
  // title= di MangaDex pakai pemisah kata, "onepiece" ga ketemu -> coba sisip spasi
  if ((d.total ?? 0) === 0 && !norm.includes(' ') && norm.length >= 4) {
    for (let i = 1; i < norm.length; i++) {
      const cand = `${norm.slice(0, i)} ${norm.slice(i)}`
      const r = await run(cand)
      if ((r.total ?? 0) > 0) {
        d = r
        used = cand
        log?.(`fallback: "${cand}" -> ${d.total} hasil`)
        break
      }
    }
  }

  return {
    query: q,
    normalized: used,
    total: d.total ?? 0,
    limit,
    offset,
    results: (d.data || []).map(mangaBrief),
  }
}

export async function manga(input, { log } = {}) {
  const id = idOf(input)
  log?.(`manga: ${id}`)
  const d = await api(`/manga/${id}`, { includes: ['cover_art', 'author', 'artist', 'manga_links'] })
  const m = d.data
  const base = mangaBrief(m)
  const stats = await api(`/statistics/manga/${id}`).catch(() => null)
  return {
    ...base,
    links: m.attributes.links || {},
    officialLinks: m.attributes.officialLinks || {},
    state: m.attributes.state || null,
    volumeCount: m.attributes.lastVolume || null,
    chapterReset: !!m.attributes.chapterNumbersResetOnNewVolume,
    statistics: stats ? {
      rating: stats.statistics?.[id]?.rating ?? null,
      follows: stats.statistics?.[id]?.follows ?? null,
      comments: stats.statistics?.[id]?.comments ?? null,
      createdAt: stats.statistics?.[id]?.createdAt ?? null,
    } : null,
    covers: (m.relationships || []).filter((r) => r.type === 'cover_art').map((r) => ({
      id: r.id,
      fileName: r.attributes?.fileName,
      volume: r.attributes?.volume || null,
      locale: r.attributes?.locale || null,
      url: `${CDN}/covers/${m.id}/${r.attributes?.fileName}`,
      thumb512: `${CDN}/covers/${m.id}/${r.attributes?.fileName}.512.jpg`,
    })),
    api: `${API}/manga/${id}`,
  }
}

export async function chapters(input, { lang = ['en'], limit = 50, offset = 0, order = 'desc', log } = {}) {
  const id = idOf(input)
  log?.(`chapters: ${id} (lang: ${[].concat(lang).join(',')})`)
  const d = await api(`/manga/${id}/feed`, {
    limit: Math.min(limit, 500),
    offset,
    translatedLanguage: [].concat(lang),
    includes: ['scanlation_group', 'manga', 'user'],
    [`order[chapter]`]: order,
  })
  const total = d.total ?? (d.data || []).length
  const items = (d.data || []).map((c) => chapterBrief(c))
  return {
    manga: id,
    total,
    limit,
    offset,
    count: items.length,
    chapters: items,
    nextOffset: offset + items.length < total ? offset + items.length : null,
  }
}

export async function chapter(input, { log } = {}) {
  const id = idOf(input)
  log?.(`chapter: ${id}`)
  const d = await api(`/chapter/${id}`, { includes: ['scanlation_group', 'manga'] })
  const home = await api(`/at-home/server/${id}`)
  const hash = home.chapter?.hash || ''
  const mk = (arr, kind) =>
    (arr || []).map((f, i) => ({
      page: i + 1,
      file: f,
      kind,
      url: hash ? `${home.baseUrl}/${kind}/${hash}/${f}` : null,
    }))
  return {
    ...chapterBrief(d.data),
    atHome: {
      baseUrl: home.baseUrl || null,
      hash,
      pageCount: (home.chapter?.data || []).length,
      saverCount: (home.chapter?.dataSaver || []).length,
    },
    pages: mk(home.chapter?.data, 'data'),
    pagesSaver: mk(home.chapter?.dataSaver, 'data-saver'),
    attributes: d.data.attributes,
  }
}

export async function latest({ limit = 10, lang = ['en'], offset = 0, log } = {}) {
  log?.(`latest: ${limit} (${[].concat(lang).join(',')})`)
  const d = await api('/chapter', {
    limit: Math.min(limit, 100),
    offset,
    translatedLanguage: [].concat(lang),
    includes: ['manga', 'scanlation_group'],
    [`order[readableAt]`]: 'desc',
  })
  return {
    total: d.total ?? 0,
    limit,
    offset,
    results: (d.data || []).map((c) => chapterBrief(c)),
  }
}

// ── CLI ───────────────────────────────────────────────────
const { values: v, positionals } = parseArgs({
  options: {
    limit:   { type: 'string', short: 'l', default: '10' },
    offset:  { type: 'string', short: 'o', default: '0' },
    lang:    { type: 'string', short: 'L', default: 'en' },
    status:  { type: 'string', short: 's' },
    order:   { type: 'string', default: 'desc' },
    quiet:   { type: 'boolean', short: 'q', default: false },
  },
  allowPositionals: true,
})

const cmd = positionals[0]
const arg = positionals[1]
const log = v.quiet ? null : (m) => console.error('[*]', m)
const num = (s, d) => (Number.isFinite(Number(s)) ? Number(s) : d)

try {
  if (!cmd || !['search', 'manga', 'chapters', 'chapter', 'latest'].includes(cmd)) {
    console.log('pakai: node mangadex.js search "<judul>" | manga <id|url> | chapters <id|url> | chapter <chapterId> | latest')
    process.exit(1)
  }
  if (!arg && cmd !== 'latest') throw new Error(`butuh argumen untuk ${cmd}`)

  let out
  if (cmd === 'search') out = await search(arg, { limit: num(v.limit, 10), offset: num(v.offset, 0), status: v.status, lang: v.lang, log })
  else if (cmd === 'manga') out = await manga(arg, { log })
  else if (cmd === 'chapters') out = await chapters(arg, { lang: v.lang.split(','), limit: num(v.limit, 50), offset: num(v.offset, 0), order: v.order, log })
  else if (cmd === 'chapter') out = await chapter(arg, { log })
  else out = await latest({ limit: num(v.limit, 10), lang: v.lang.split(','), offset: num(v.offset, 0), log })

  console.log(JSON.stringify(out, null, 2))
} catch (e) {
  console.error('[!]', e.message || e)
  process.exit(1)
}
