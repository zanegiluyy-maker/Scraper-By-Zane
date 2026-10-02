/**
 * Name : Donghive Full Scraper (Katalog + Series + Episode + Stream URL)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://donghive.vip
 * Type : Scraper
 * Function : Scrape katalog anime/donghua + metadata series + daftar episode + embed Dailymotion
 *            dan resolve stream m3u8 (signed) dari halaman video Dailymotion.
 * Note : Pakai cheerio (ada di node_modules) + native fetch (Node 18+). Retry + exponential backoff + jitter.
 *        robots.txt: semua diizinkan, sitemap Yoast tersedia.
 *        Usage:
 *          node donghive.js catalog --pages 3 --out donghive-catalog.json
 *          node donghive.js series --url https://donghive.vip/against-the-gods/
 *          node donghive.js episode --url https://donghive.vip/against-the-gods-episode-57-subtitle-indonesia/ --stream
 *          node donghive.js all --pages 1 --limit 5 --resolve --out donghive-full.json
 */

import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import * as cheerio from 'cheerio'

const BASE    = 'https://donghive.vip'
const TIMEOUT = 30_000
const RETRIES = 4
const RETRYABLE = new Set([403, 408, 425, 429, 500, 502, 503, 504, 520, 522, 524])

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hdrs = (i, extra = {}) => ({
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  'User-Agent': UAS[i % UAS.length],
  ...extra,
})

async function req(url, { headers = {}, method = 'GET', referer, log } = {}) {
  let lastErr
  for (let i = 0; i <= RETRIES; i++) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), TIMEOUT)
    try {
      const res = await fetch(url, {
        method,
        headers: hdrs(i, { ...(referer ? { Referer: referer } : {}), ...headers }),
        signal: ac.signal, redirect: 'follow',
      })
      const txt = await res.text()
      log?.(`[${res.status}] ${method} ${url.slice(0, 90)} (try ${i + 1})`)
      if (RETRYABLE.has(res.status) && i < RETRIES) {
        const ra = Number(res.headers.get('retry-after'))
        await sleep(ra > 0 ? ra * 1000 : Math.min(1500 * 2 ** i, 15000) + Math.random() * 500)
        lastErr = new Error(`HTTP ${res.status}`); continue
      }
      return { res, txt }
    } catch (e) {
      lastErr = e
      if (e.name !== 'AbortError' && !(e instanceof TypeError)) break
      await sleep(Math.min(1500 * 2 ** i, 15000))
    } finally { clearTimeout(t) }
  }
  throw lastErr || new Error(`Fetch gagal: ${url}`)
}

async function fetchHtml(url, opts = {}) {
  const { res, txt } = await req(url, opts)
  if (!res.ok) throw new Error(`HTTP ${res.status} untuk ${url}`)
  return txt
}

const abs = (u) => (u?.startsWith('http') ? u : new URL(u || '', BASE).href)
const absUrl = (u) => { try { return new URL(u, BASE).href } catch { return u || null } }

// ── KATALOG ────────────────────────────────────────────────
function parseCard($card) {
  const $a = $card.find('.bsx a[href], a.tip[href]').first()
  const link = absUrl($a.attr('href'))
  if (!link) return null
  const title = ($a.attr('title') || $card.find('.tt h2, h2').first().text() || '').trim()
  const poster = $card.find('img').first().attr('data-src') || $card.find('img').first().attr('src') || null
  return {
    title: title || null,
    url: link,
    slug: link.replace(/\/$/, '').split('/').pop(),
    poster: poster ? abs(poster) : null,
    type: ($card.find('.typez').first().text() || $card.find('.epx').first().text() || '').trim().toLowerCase() || null,
    sub: $card.find('.sb').first().text().trim() || null,
    hot: $card.find('.hotbadge').length > 0,
  }
}

async function scrapeListPage(url, { log } = {}) {
  const html = await fetchHtml(url, { log })
  const $ = cheerio.load(html)
  const items = []
  $('article.bs').each((_, el) => {
    const it = parseCard($(el))
    if (it) items.push(it)
  })
  const next = $(`a[href*="/page/"]`).filter((_, el) => /page\/\d+/.test($(el).attr('href') || ''))
    .toArray()
    .map((el) => absUrl($(el).attr('href')))
    .find((u, i, arr) => u && arr.indexOf(u) === i)
  return { items, next }
}

/** Scrape katalog utama (/anime/) beberapa halaman. */
export async function scrapeCatalog({ maxPages = 3, log } = {}) {
  const seen = new Set()
  const out = []
  let url = `${BASE}/anime/?status=&type=&order=update`
  for (let page = 1; page <= maxPages && url; page++) {
    log?.(`📄 ${url}`)
    let parsed
    try { parsed = await scrapeListPage(url, { log }) } catch (e) { log?.(`  ⚠ ${e.message}`); break }
    for (const it of parsed.items) {
      if (!seen.has(it.url)) { seen.add(it.url); out.push(it) }
    }
    url = page < maxPages ? parsed.next : null
  }
  return out
}

/** Ambil semua episode dari sebuah URL genre/network/list apapun. */
export async function scrapeListUrl(url, { maxPages = 3, log } = {}) {
  const seen = new Set(); const out = []
  let cur = url
  for (let p = 1; p <= maxPages && cur; p++) {
    const { items, next } = await scrapeListPage(cur, { log })
    for (const it of items) if (!seen.has(it.url)) { seen.add(it.url); out.push(it) }
    cur = next
  }
  return out
}

// ── SERIES ─────────────────────────────────────────────────
export async function scrapeSeries(url, { log } = {}) {
  const html = await fetchHtml(url, { log, referer: `${BASE}/` })
  const $ = cheerio.load(html)
  const title = $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content')?.replace(/\s*-\s*Donghive$/, '')
  const poster = $('meta[property="og:image"]').attr('content')
    || $('.imgseries img, .seriesinfo img, .infox img').first().attr('src') || null
  const synopsis = ($('.entry-content, .synopsis, .desc').first().text() || $('meta[property="og:description"]').attr('content') || '').trim()
  const genres = []
  $('a[rel="tag"][href*="/genres/"]').each((_, el) => genres.push($(el).text().trim()))
  const status = $('.spe').first().text().match(/Status:\s*([^\t\n]+)/)?.[1]?.trim() || null
  const network = $('a[href*="/network/"]').first().text().trim() || null
  const episodes = []
  $('li[data-index] a[href]').each((_, el) => {
    const href = absUrl($(el).attr('href'))
    const num = $(el).find('.epl-num').text().trim()
    const t = $(el).find('.epl-title').text().trim()
    const date = $(el).find('.epl-date').text().trim()
    if (href) episodes.push({ number: num ? Number(num) : null, title: t || null, url: href, date: date || null })
  })
  return { title, url, poster: poster ? abs(poster) : null, synopsis, genres: [...new Set(genres)], status, network, totalEpisodes: episodes.length, episodes }
}

// ── EPISODE + STREAM ───────────────────────────────────────
export async function scrapeEpisode(url, { log } = {}) {
  const html = await fetchHtml(url, { log, referer: `${BASE}/` })
  const $ = cheerio.load(html)
  const title = $('h1.entry-title').first().text().trim() || $('title').text().trim()
  const iframe = $('#pembed iframe, .player-embed iframe, .video-content iframe').first().attr('src') || null
  const embedUrl = iframe ? iframe.replace(/&amp;/g, '&') : null
  const videoId = embedUrl?.match(/[?&]video=([A-Za-z0-9_-]+)/)?.[1] || null
  const slug = url.replace(/\/$/, '').split('/').pop() || ''
  const seriesSlug = slug.match(/^(.+?)-(?:episode|movie|chapter|ova|special|preview)-/i)?.[1] || null
  const seriesUrl = seriesSlug ? `${BASE}/${seriesSlug}/` : null
  return { title, url, seriesUrl, embedUrl, videoId, provider: videoId ? 'Dailymotion' : null }
}

/** Ambil m3u8 (signed manifest) dari halaman video Dailymotion. */
export async function resolveDailymotionStream(videoId, { embedUrl, log } = {}) {
  if (!videoId) throw new Error('videoId wajib diisi')
  // Primary: halaman embed player (geo.dailymotion.com) juga menyimpan manifest m3u8 ber-token.
  const pageUrls = [
    ...(embedUrl ? [embedUrl] : []),
    `https://www.dailymotion.com/video/${videoId}`,
  ]
  let m3u8
  for (const pageUrl of pageUrls) {
    try {
      const { txt: html } = await req(pageUrl, { log, referer: 'https://www.dailymotion.com/' })
      m3u8 = html.match(/https?:\/\/cdndirector\.dailymotion\.com\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i)?.[0]
        || html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i)?.[0]
      if (m3u8) break
    } catch (e) { log?.(`  ⚠ ${pageUrl.slice(0, 60)}: ${e.message}`) }
  }
  if (!m3u8) throw new Error('Manifest m3u8 tidak ditemukan di halaman/embed Dailymotion.')
  let info = {}
  try {
    const { txt } = await req(`https://api.dailymotion.com/video/${videoId}?fields=id,title,duration,thumbnail_720_url`, { log })
    info = JSON.parse(txt)
  } catch { /* metadata opsional */ }
  return {
    provider: 'Dailymotion',
    videoId,
    pageUrl: `https://www.dailymotion.com/video/${info.id || videoId}`,
    streamType: 'hls',
    streamUrl: m3u8.replace(/&amp;/g, '&'),
    ...info,
  }
}

/** Gabungan: episode -> embed -> stream. */
export async function resolveStreamForEpisode(url, { log } = {}) {
  const ep = await scrapeEpisode(url, { log })
  if (!ep.videoId) return { ...ep, stream: null, error: 'Embed Dailymotion tidak ditemukan.' }
  try {
    const stream = await resolveDailymotionStream(ep.videoId, { embedUrl: ep.embedUrl, log })
    return { ...ep, stream, error: null }
  } catch (e) {
    return { ...ep, stream: null, error: e.message }
  }
}

// ── CLI ────────────────────────────────────────────────────
async function main() {
  const { values: v, positionals: [cmd] } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: 'string' }, pages: { type: 'string', default: '3' },
      limit: { type: 'string', default: '0' }, out: { type: 'string', default: 'donghive.json' },
      resolve: { type: 'boolean', default: false }, stream: { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
    }, allowPositionals: true,
  })
  const log = v.verbose ? (s) => process.stderr.write(s + '\n') : () => {}
  try {
    if (cmd === 'catalog') {
      const items = await scrapeCatalog({ maxPages: parseInt(v.pages, 10) || 3, log })
      console.log(JSON.stringify({ scrapedAt: new Date().toISOString(), base: BASE, total: items.length, items }, null, 2))
      return
    }
    if (cmd === 'series') {
      if (!v.url) throw new Error('--url wajib (URL series Donghive).')
      console.log(JSON.stringify(await scrapeSeries(v.url, { log }), null, 2)); return
    }
    if (cmd === 'episode') {
      if (!v.url) throw new Error('--url wajib (URL episode Donghive).')
      const out = v.stream ? await resolveStreamForEpisode(v.url, { log }) : await scrapeEpisode(v.url, { log })
      console.log(JSON.stringify(out, null, 2)); return
    }
    if (cmd === 'all') {
      const items = await scrapeCatalog({ maxPages: parseInt(v.pages, 10) || 3, log })
      let result = { scrapedAt: new Date().toISOString(), base: BASE, total: items.length, items }
      if (v.resolve) {
        const limit = parseInt(v.limit, 10) || 0
        console.log(`⚠ --resolve pada mode all: gunakan 'episode --url <url> --stream' per episode.`)
        console.log(`  Tips: extrak URL episode dari output 'series --url ...' lalu loop dengan 'episode --stream'.`)
      }
      await writeFile(v.out, JSON.stringify(result, null, 2), 'utf8')
      console.log(`💾 Disimpan: ${v.out} (${items.length} item)`); return
    }
    console.log(`Usage:
  node donghive.js catalog [--pages 3] [--out catalog.json]
  node donghive.js series --url <url-series>
  node donghive.js episode --url <url-episode> [--stream]
  node donghive.js all --pages 3 --out donghive.json
Opsi: --verbose`)
  } catch (e) {
    console.error(`❌ ${e.message}`)
    process.exit(1)
  }
}

export default { scrapeCatalog, scrapeListUrl, scrapeSeries, scrapeEpisode, resolveDailymotionStream, resolveStreamForEpisode }
if (import.meta.url === `file://${process.argv[1]}`) main()
