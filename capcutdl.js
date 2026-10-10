/**
 * Name : CapCut Template Downloader (link mp4, JSON only)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://www.capcut.com
 * Type : Scraper
 * Function : downloader capcut
 * Note : error fix sendiri.
 */

import { request as httpsReq } from 'node:https'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

const BASE  = 'https://www.capcut.com'
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const TIMEOUT  = 30_000
const RETRIES  = 3

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Request HTTPS native, ikut redirect, retry 429/5xx/timeout. */
async function req(url, { method = 'GET', headers = {}, body, maxRedirect = 5, timeout = TIMEOUT, retries = RETRIES } = {}) {
  let cur = url
  for (let hop = 0; hop <= maxRedirect; hop++) {
    const u = new URL(cur)
    let out = null
    for (let i = 0; i <= retries; i++) {
      out = await new Promise((resolve) => {
        const rq = httpsReq(
          {
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + u.search,
            method,
            servername: u.hostname,
            headers: {
              'User-Agent': UA,
              Accept: '*/*',
              'Accept-Language': 'en-US,en;q=0.9',
              Referer: `${BASE}/`,
              ...headers,
            },
          },
          (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
              resolve({
                status: res.statusCode,
                headers: res.headers,
                text: Buffer.concat(chunks).toString('utf8'),
                finalUrl: cur,
              })
            })
          },
        )
        rq.setTimeout(timeout, () => rq.destroy(new Error('timeout')))
        rq.on('error', (e) => resolve({ status: 0, error: e.message }))
        if (body) rq.write(body)
        rq.end()
      })

      if (out.status === 429 && i < retries) {
        await sleep(Math.min(Number(out.headers?.['retry-after'] || 1) * 1000 || 1200 * (i + 1), 8000))
        continue
      }
      if ((out.status >= 500 || out.status === 0) && i < retries) {
        await sleep(700 * (i + 1))
        continue
      }
      break
    }

    if (!out) throw new Error('request gagal terus-terusan')
    const loc = out.headers?.location
    if (out.status >= 300 && out.status < 400 && loc) {
      cur = new URL(loc, cur).toString()
      continue
    }
    if (out.status === 0) throw new Error(out.error || 'koneksi gagal')
    if (out.status >= 400) {
      const body = out.text || ''
      const detail = /<html/i.test(body) ? (out.status === 404 ? 'halaman tidak ditemukan' : 'respons HTML error') : body.slice(0, 160)
      throw new Error(`HTTP ${out.status} — ${detail}`)
    }
    return out
  }
  throw new Error('terlalu banyak redirect')
}

// ── SSR DATA ──────────────────────────────────────────────
const ROUTER_RE = /<script[^>]*id="__MODERN_ROUTER_DATA__"[^>]*>([\s\S]*?)<\/script>/

function loaderData(html) {
  const m = html.match(ROUTER_RE)
  if (!m) throw new Error('data SSR ga ketemu (__MODERN_ROUTER_DATA__) — halaman berubah/bukan template')
  let d
  try { d = JSON.parse(m[1]) } catch (e) { throw new Error(`JSON SSR korup: ${e.message}`) }
  return d.loaderData || {}
}

/** Cari objek templateDetail di dalam loaderData. */
function findDetail(loader) {
  for (const v of Object.values(loader)) {
    if (v && typeof v === 'object' && v.templateDetail && v.templateDetail.templateId) return v
  }
  return null
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const iso = (ts) => (num(ts) ? new Date(num(ts) * 1000).toISOString() : null)

function cleanTemplate(t = {}) {
  const a = t.author || {}
  return {
    id: t.templateId || null,
    title: t.title || null,
    desc: t.desc || null,
    tagTitle: t.tagTitle || null,
    url: t.templateId ? `${BASE}/template-detail/${t.templateId}` : null,
    canonicalPath: t.canonicalPath || null,
    cover: t.coverUrl || null,
    video: {
      url: t.videoUrl || null,
      ratio: t.videoRatio || null,
      width: num(t.videoWidth),
      height: num(t.videoHeight),
      durationMs: num(t.templateDuration),
      durationSec: num(t.templateDuration) ? Math.round(num(t.templateDuration) / 1000) : null,
    },
    stats: {
      uses: num(t.usageAmount),
      likes: num(t.likeAmount),
      plays: num(t.playAmount),
      comments: num(t.commentAmount),
      segments: num(t.segmentAmount),
    },
    author: a.name ? {
      name: a.name,
      avatar: a.avatarUrl || null,
      profileUrl: a.profileUrl ? `${BASE}${a.profileUrl}` : null,
      secUid: a.secUid || null,
      bio: a.description || null,
    } : null,
    language: t.ugcLang || t.templateLanguage || null,
    capability: t.capabilityName || null,
    createdAt: iso(t.createTime),
    seo: t.structuredData ? {
      name: t.structuredData.name || null,
      description: t.structuredData.description || null,
      thumbnail: t.structuredData.thumbnailUrl || null,
      contentUrl: t.structuredData.contentUrl || null,
      uploadDate: iso(t.structuredData.uploadDate),
      duration: num(t.structuredData.duration),
    } : null,
  }
}

// ── ID DARI MACAM-MACAM LINK ──────────────────────────────
async function resolveInput(input) {
  const s = String(input || '').trim()
  if (!s) throw new Error('butuh link/id template')

  if (/^\d{10,}$/.test(s)) return s

  let url = s
  if (!/^https?:\/\//i.test(s)) {
    if (/capcut:\/\//i.test(s)) url = s
    else if (s.includes('/') || s.includes('.')) url = `https://${s.replace(/^\/+/, '')}`
    else url = s // murni kode / id
  }

  let m = url.match(/template_id=(\d{10,})/) || url.match(/template-detail\/(?:[^/?#]+\/)?(\d{10,})/)
  if (m) return m[1]

  // link singkat macam apa pun (/t/<kode>, /tv2/<kode>, dst) -> ikut redirect, baca id dari URL final
  if (/capcut\.com\//i.test(url) || /^capcut:\/\//i.test(url)) {
    const res = await req(url)
    const final = res.finalUrl || ''
    const m2 = final.match(/template_id=(\d{10,})/) || final.match(/template-detail\/(?:[^/?#]+\/)?(\d{10,})/)
    if (m2 && !/template-detail\/default-tool/i.test(final)) return m2[1]
    throw new Error(`link itu ga nunjuk template (${final || res.status})`)
  }

  // path mentah kayak "Dani-Flow/7637761575813729537"
  m = s.match(/(\d{10,})/)
  if (m) return m[1]

  throw new Error(`bukan link template CapCut: ${input}`)
}

// ── COMMANDS ──────────────────────────────────────────────

/** Ambil data lengkap template (SSR) + info halaman. */
export async function info(input, { log } = {}) {
  const id = await resolveInput(input)
  log?.(`info: ${id}`)
  const res = await req(`${BASE}/template-detail/${id}`)
  const loader = loaderData(res.text)
  const found = findDetail(loader)
  if (!found) throw new Error(`template ${id} ga ketemu (404/region-lock)`)
  const t = cleanTemplate(found.templateDetail)
  return {
    template: t,
    page: {
      url: `${BASE}${found.canonicalPath || `/template-detail/${id}`}`,
      canonicalPath: found.canonicalPath || null,
      isValidRegion: found.templateDetail?.is_valid_template_region ?? null,
      useAvailable: found.templateDetail?.useAvailable ?? null,
      isDefault: found.templateDetail?.isDefault ?? null,
      query: found.query || null,
    },
    relatedCount: (found.recommendList || []).length,
    api: `${BASE}/template-detail/${id}`,
  }
}

/** Link mp4 langsung + ukuran/type (HEAD). Nol file ditulis ke disk. */
export async function download(input, { log } = {}) {
  const infoData = await info(input, { log })
  const t = infoData.template
  const url = t.video.url
  if (!url) throw new Error('template ga punya videoUrl')

  log?.(`cek video: ${url.slice(0, 80)}...`)
  let head = await req(url, { method: 'HEAD' }).catch((e) => ({ status: 0, error: e.message, headers: {} }))
  if (head.status !== 200) {
    // fallback: range 1 byte (CDN kadang nolak HEAD)
    head = await req(url, { headers: { Range: 'bytes=0-0' } }).catch((e) => ({ status: 0, error: e.message, headers: {} }))
    if (head.status === 206) {
      const cr = String(head.headers?.['content-range'] || '').split('/')[1]
      head.headers['content-length'] = cr && cr !== '*' ? cr : head.headers['content-length']
      head.headers['content-type'] = head.headers['content-type'] || 'video/mp4'
    }
  }
  const size = num(head.headers?.['content-length'])
  const type = head.headers?.['content-type'] || null

  return {
    id: t.id,
    title: t.title,
    durationSec: t.video.durationSec,
    ratio: t.video.ratio,
    resolution: t.video.width && t.video.height ? `${t.video.width}x${t.video.height}` : null,
    video: { url, status: head.status, sizeBytes: size, sizeHr: human(size), contentType: type, watermark: 'baked-in (CapCut ID)' },
    cover: t.cover,
    page: infoData.page.url,
    relatedCount: infoData.relatedCount,
  }
}

// ── HELPERS ───────────────────────────────────────────────
const human = (b) => {
  if (!b && b !== 0) return null
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = b
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`
}

// ── CLI (jalan cuma kalo file dipanggil langsung, bukan waktu di-import) ──
const USAGE = `pakai:
  node capcutdl.js <link>        data template + link mp4 langsung -> JSON
contoh:
  node capcutdl.js https://www.capcut.com/tv2/ZSbtXffJ6/
  node capcutdl.js 7637761575813729537
  node capcutdl.js <link> -q     -q: matiin log di stderr (stdout tetap JSON)
catatan: nol file ditulis ke disk — keluaran cuma JSON; videoUrl CDN signed,
         jangan di-cache, ambil ulang tiap mau dipakai. Ada watermark baked-in.`

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const { values: v, positionals } = parseArgs({
    options: { quiet: { type: 'boolean', short: 'q', default: false } },
    allowPositionals: true,
  })
  const log = v.quiet ? null : (m) => console.error('[*]', m)

  try {
    const [first] = positionals

    if (!first || first === 'help' || first === '--help') {
      console.log(USAGE)
      process.exit(0)
    }

    const out = await download(positionals.join(' '), { log })
    console.log(JSON.stringify(out, null, 2))
  } catch (e) {
    console.error('[!]', e.message || e)
    process.exit(1)
  }
}
