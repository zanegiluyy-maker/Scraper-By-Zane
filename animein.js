/**
 * Name : ANIMEIN Scraper (home, jadwal, search, ongoing, latest, detail, episode, stream, komentar)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://animeinweb.com (proxy: /api/proxy -> API internal animein)
 * Type : Scraper
 * Function : home,genres,schedule,search,ongoing,latest,anime,episodes,stream,comments -> output JSON ke layar
 * Note : error fix sendiri. 
 */

import { request as httpsReq } from 'node:https'
import { parseArgs } from 'node:util'

const BASE   = 'https://animeinweb.com'
const PROXY  = `${BASE}/api/proxy`
const SECRET = 'animein-secure-proxy-key-123'
const UA     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const TIMEOUT = 30_000
const RETRIES = 3
const DAYS = ['senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Request HTTPS native, retry untuk 429/5xx/timeout. */
async function req(url, { headers = {}, timeout = TIMEOUT } = {}) {
  const u = new URL(url)
  for (let i = 0; i <= RETRIES; i++) {
    const out = await new Promise((resolve) => {
      const rq = httpsReq(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method: 'GET',
          servername: u.hostname,
          headers: {
            'User-Agent': UA,
            Accept: 'application/json, text/plain, */*',
            Referer: `${BASE}/`,
            Origin: BASE,
            'x-proxy-secret': SECRET,
            ...headers,
          },
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
        },
      )
      rq.setTimeout(timeout, () => rq.destroy(new Error('timeout')))
      rq.on('error', (e) => resolve({ status: 0, error: e.message }))
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
    if (out.status === 403) throw new Error('403 — proxy secret ditolak (x-proxy-secret basi?)')
    if (out.status >= 400) throw new Error(`HTTP ${out.status}${out.text ? ` — ${out.text.slice(0, 160)}` : ' — tidak ada data (id salah?)'}`)
    return out
  }
  throw new Error('request gagal terus-terusan')
}

const qs = (params = {}) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    p.append(k, Array.isArray(v) ? v.join(',') : String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** GET /api/proxy<path> -> data (envelope {status,error,data} dilepas). */
async function api(path, params) {
  const res = await req(`${PROXY}${path}${qs(params)}`)
  let j = null
  try { j = JSON.parse(res.text) } catch { /* body kosong / bukan json */ }
  if (!j) throw new Error(`respons bukan JSON (${res.status}): ${res.text.slice(0, 160)}`)
  if (j.error || j.status !== 200) throw new Error(j.message || `API status ${j.status}`)
  await sleep(250)
  return j.data ?? {}
}

/** URL gambar kadang relatif atau punya slash ganda. */
function abs(u) {
  if (!u || typeof u !== 'string' || !u.trim()) return null
  if (/^https?:\/\//.test(u)) return u.replace(/([^:])\/{2,}/g, '$1/')
  return `${BASE}${u.startsWith('/') ? '' : '/'}${u}`.replace(/([^:])\/{2,}/g, '$1/')
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const split = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean)

// ── NORMALIS ──────────────────────────────────────────────
export const brief = (m = {}) => ({
  id: m.id,
  title: m.title || null,
  url: m.id ? `${BASE}/anime/${m.id}` : null,
  synopsis: m.synopsis || null,
  synonyms: split(m.synonyms),
  genre: split(m.genre),
  type: m.type || null,
  year: num(m.year),
  day: m.day || null,
  status: m.status || null,
  keyStatus: m.keyStatus || m.key_status || null,
  views: num(m.views),
  favorites: num(m.favorites),
  studio: m.studio || null,
  airedStart: m.aired_start || null,
  airedEnd: m.aired_end || null,
  poster: abs(m.image_poster),
  cover: abs(m.image_cover),
})

export const epBrief = (e = {}) => ({
  id: e.id,
  index: num(e.index),
  title: e.title || null,
  views: num(e.views),
  movieId: e.id_movie ?? null,
  keyTime: e.key_time || null,
  image: abs(e.image),
  isNew: e.is_new === '1' || e.is_new === 1,
  isNewest: e.is_new === '1' || e.is_new === 1,
  url: `${BASE}/anime/${e.id_movie}`,
})

const serverBrief = (s = {}) => ({
  id: s.id,
  name: s.name || null,
  quality: s.quality || null,
  type: s.type || null,
  sizeMB: num(s.key_file_size),
  username: s.username || null,
  serverId: s.server_id ?? null,
  domain: s.domain || null,
  link: s.link || null,
  urlYt: s.url_youtube || null,
  thumbnail: abs(s.thumbnail),
})

// ── COMMANDS ──────────────────────────────────────────────

/** Beranda: slider + semua section. day: senin..minggu | random (default hari ini). */
export async function home({ day, limit = 12, log } = {}) {
  const d = day || todayId()
  log?.(`home: day=${d} limit=${limit}`)
  const data = await api('/3/2/home/data', { day: d, limit })
  const cut = (arr) => (Array.isArray(arr) ? arr.slice(0, limit).map(brief) : [])
  return {
    day: d,
    limit,
    sections: {
      slider: {
        label: 'Slider',
        items: (data.slider || []).slice(0, limit).map((s) => ({
          id: s.id, image: abs(s.image), type: s.type || null, link: s.link || null,
        })),
      },
      hot:         { label: '🔥 Sedang Hangat',   items: cut(data.hot) },
      new:         { label: '🏕 Baru Ditambahkan', items: cut(data.new) },
      today:       { label: '📅 Anime Hari Ini',  items: cut(data.today) },
      popular:     { label: '⭐ Populer',    items: cut(data.popular) },
      waiting:     { label: '⏳ Paling Ditunggu',  items: cut(data.waiting) },
      random:      { label: '🎲 Random',     items: cut(data.random) },
      trailer: {
        label: '🎬 Trailer',
        items: (data.trailer || []).slice(0, limit).map((t) => ({
          id: t.id, movieId: t.id_movie ?? null, title: t.title || null, synopsis: t.synopsis || null,
          urlYoutube: t.url_youtube || null, thumbnail: abs(t.thumbnail || t.image), time: t.time || null,
        })),
      },
      fyp:         { label: 'FYP',           items: cut(data.fyp) },
    },
    meta: { setupFypFlag: data.setup_fyp_flag ?? null, setupFypName: data.setup_fyp_name ?? null },
  }
}

/** Jadwal rilis per hari. day: senin..minggu | random | all (7 hari). */
export async function schedule({ day = 'all', log } = {}) {
  const list = String(day).toLowerCase() === 'all' ? [...DAYS] : [String(day).toLowerCase()]
  for (const d of list) if (![...DAYS, 'random'].includes(d)) throw new Error(`hari tidak dikenal: ${d} (pakai ${DAYS.join('|')}|random|all)`)
  log?.(`schedule: ${list.join(',')}`)
  const days = []
  for (const d of list) {
    const data = await api('/3/2/schedule/data', { day: d })
    days.push({ day: d, count: (data.movie || []).length, movies: (data.movie || []).map(brief) })
  }
  return { requested: day, days: list.length === 1 ? days[0] : days, total: days.reduce((a, b) => a + b.count, 0) }
}

/** List genre (dipakai buat filter search --genre 14,16). */
export async function genres({ log } = {}) {
  log?.('genres')
  const data = await api('/3/2/explore/genre')
  const g = data.genre || []
  return {
    count: g.length,
    genres: g.map((x) => ({ id: x.id, name: x.name, group: x.group || null, image: abs(x.image) })),
  }
}

/** Cari / jelajah katalog (60 judul/halaman). sort: views = populer, selain itu A-Z. */
export async function search(keyword = '', { page = 0, pages = 1, sort = 'views', genreIds = [], limit = 0, log } = {}) {
  const kw = String(keyword || '').trim()
  log?.(`search: "${kw}" sort=${sort} genre=${genreIds.join(',') || '-'} pages=${pages}`)
  const out = []
  let fetched = 0
  let p = page
  let hasMore = true
  while (hasMore && p < page + pages) {
    const data = await api('/3/2/explore/movie', { page: p, sort, keyword: kw, ...(genreIds.length ? { genre_in: genreIds } : {}) })
    const chunk = data.movie || []
    fetched += chunk.length
    const room = limit ? Math.max(limit - out.length, 0) : chunk.length
    out.push(...chunk.slice(0, room).map(brief))
    hasMore = chunk.length > 0
    p++
    if (limit && out.length >= limit) hasMore = false
  }
  return {
    keyword: kw,
    sort,
    genreIds,
    pagesRead: p - page,
    fetched,
    count: out.length,
    hasMore,
    results: out,
  }
}

/** Anime terbaru masuk katalog = section "Baru Ditambahkan" di beranda (max 100). */
export async function latest({ limit = 30, day, log } = {}) {
  const d = day || todayId()
  const take = Math.min(Math.max(limit, 1), 100)
  log?.(`latest: ${limit} (beranda ${d})`)
  const data = await api('/3/2/home/data', { day: d, limit: 100 })
  const items = (data.new || []).slice(0, take).map(brief)
  return { source: 'home.new — 🏕 Baru Ditambahkan', day: d, count: items.length, results: items }
}

/** Anime status ONGOING. Sumber: section beranda (new/today) + sweep katalog (--pages, 60 judul/halaman, total ~82 halaman). */
export async function ongoing({ day, pages = 0, sort = 'views', log } = {}) {
  const d = day || todayId()
  log?.(`ongoing: beranda ${d}${pages ? ` + katalog ${pages} halaman` : ''}`)
  const seen = new Map()
  const add = (list, source) => {
    for (const m of list || []) {
      const b = brief(m)
      if (b.status !== 'ONGOING') continue
      if (!seen.has(b.id)) seen.set(b.id, { ...b, source })
      else seen.get(b.id).source = `${seen.get(b.id).source}+${source}`
    }
  }

  const home = await api('/3/2/home/data', { day: d, limit: 100 })
  add(home.new, 'home.new')
  add(home.today, 'home.today')
  add(home.waiting, 'home.waiting')

  let pagesRead = 0
  if (pages > 0) {
    const r = await search('', { pages, sort })
    add(r.results, 'katalog')
    pagesRead = r.pagesRead
  }

  const results = [...seen.values()]
  return {
    day: d,
    katalogPagesRead: pagesRead,
    count: results.length,
    note: 'server tanpa filter status; hasil difilter lokal dari beranda + katalog (--pages buat perluas)',
    results,
  }
}

/** Detail anime + musim/season + episode terbaru + trailer. */
export async function detail(input, { log } = {}) {
  const id = idOf(input)
  log?.(`anime: ${id}`)
  const data = await api(`/3/2/movie/detail/${id}`)
  const movie = data.movie || null
  if (!movie) throw new Error(`anime ${id} tidak ditemukan`)
  const trailer = await api('/data/movie/trailer/list', { id_movie: id }).catch(() => ({ trailer: [] }))
  return {
    anime: brief(movie),
    raw: movie,
    season: (data.season || []).map(brief),
    latestEpisode: data.episode ? epBrief(data.episode) : null,
    trailer: (trailer.trailer || []).map((t) => ({
      id: t.id, name: t.name, urlYoutube: t.url_youtube, thumbnail: abs(t.thumbnail), time: t.time, isNew: !!t.is_new,
    })),
    api: `${BASE}/api/proxy/3/2/movie/detail/${id}`,
  }
}

/** Daftar episode (30/halaman). Pakai --all buat ambil semua. */
export async function episodes(input, { page = 0, pages = 1, all = false, q = '', log } = {}) {
  const id = idOf(input)
  log?.(`episodes: ${id} page=${page}${all ? ' (all)' : ''}${q ? ` q="${q}"` : ''}`)
  const out = []
  let p = page
  let hasMore = !all
  while (all ? p === page || hasMore : p < page + pages) {
    const data = await api(`/3/2/movie/episode/${id}`, { page: p, ...(q ? { search: q } : {}) })
    const chunk = data.episode || []
    out.push(...chunk.map(epBrief))
    hasMore = chunk.length >= 30
    p++
    if (!all && p >= page + pages) break
    if (!hasMore) break
  }
  return { movieId: id, query: q || null, pagesRead: p - page, count: out.length, episodes: out }
}

/** Link tonton: daftar server (direct mp4 / embed) + episode sebelumnya & berikutnya. */
export async function stream(episodeId, { log } = {}) {
  const id = idOf(episodeId, 'episode')
  log?.(`stream: episode ${id}`)
  const data = await api(`/3/2/episode/streamnew/${id}`)
  if (!data.episode) throw new Error(`episode ${id} tidak ditemukan`)
  const servers = (data.server || []).map(serverBrief)
  return {
    episode: epBrief(data.episode),
    next: data.episode_next ? epBrief(data.episode_next) : null,
    count: servers.length,
    direct: servers.filter((s) => s.type === 'direct' && s.link),
    embed: servers.filter((s) => s.type !== 'direct' && s.link),
    servers,
    api: `${BASE}/api/proxy/3/2/episode/streamnew/${id}`,
  }
}

/** Komentar episode (sort: top | new). */
export async function comments(episodeId, { sort = 'top', page = 0, log } = {}) {
  const id = idOf(episodeId, 'episode')
  log?.(`comments: episode ${id} sort=${sort} page=${page}`)
  const data = await api('/3/2/comment/data', { id_episode: id, sort, page })
  const c = data.comment || []
  return {
    episodeId: id,
    sort,
    page,
    movieId: data.id_movie ?? null,
    count: num(data.count) ?? c.length,
    posters: (data.poster || []).map((p) => ({ id: p.id, name: p.name, image: abs(p.image) })),
    comments: c.map((x) => ({
      id: x.id,
      user: x.user_name || null,
      userId: x.user_id ?? null,
      text: x.text || null,
      time: x.time || null,
      timeUpdated: x.time_updated || null,
      like: num(x.like),
      dislike: num(x.dislike),
      score: num(x.score),
      replies: num(x.replay),
      rank: num(x.rank),
      pro: num(x.pro),
    })),
  }
}

// ── HELPERS ───────────────────────────────────────────────
function todayId() {
  const map = ['minggu', 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu']
  return map[new Date().getDay()]
}

/** Terima "1280" atau "https://animeinweb.com/anime/1280". */
function idOf(input, kind = 'anime') {
  const s = String(input || '').trim()
  if (!s) throw new Error(`butuh id ${kind}`)
  const m = s.match(/\/anime\/(\d+)|^(\d+)$|^(\d+)\//)
  const id = m ? (m[1] || m[2] || m[3]) : /^\d+$/.test(s) ? s : null
  if (!id) throw new Error(`bukan id/URL ${kind}: ${input}`)
  return id
}

// ── CLI ───────────────────────────────────────────────────
const { values: v, positionals } = parseArgs({
  options: {
    day:   { type: 'string', short: 'd', default: '' },
    limit: { type: 'string', short: 'l', default: '0' },
    page:  { type: 'string', short: 'p', default: '0' },
    pages: { type: 'string', default: '1' },
    sort:  { type: 'string', short: 's', default: 'views' },
    genre: { type: 'string', short: 'g', default: '' },
    q:     { type: 'string', default: '' },
    all:   { type: 'boolean', default: false },
    quiet: { type: 'boolean', short: 'q', default: false },
  },
  allowPositionals: true,
})

const cmd = positionals[0]
const arg = positionals[1]
const log = v.quiet ? null : (m) => console.error('[*]', m)
const n = (s, d) => (Number.isFinite(Number(s)) && Number(s) > 0 ? Number(s) : d)
const p0 = (s) => (Number.isFinite(Number(s)) && Number(s) >= 0 ? Number(s) : 0)

const USAGE = `pakai: node animeinweb.js <perintah>
  home [day]                     beranda (slider/hot/new/today/popular/waiting/random)
  genres                         daftar genre
  schedule --day senin|all       jadwal rilis
  search "<judul>" --pages 2     katalog + pencarian
  ongoing [--pages N]           status ONGOING (beranda + sweep katalog opsional)
  latest --limit 30             anime terbaru ditambahkan
  anime <id|url>                 detail + season + episode terbaru + trailer
  episodes <id> [--all]          daftar episode (30/halaman)
  stream <episodeId>             server & link tonton
  comments <episodeId>           komentar episode
opsi: -d hari | -l limit | -p halaman | --pages n | -s sort | -g genreId1,2 | --q kata | --all | -q (tanpa log)`

try {
  if (!cmd || cmd === 'help' || !['home', 'genres', 'schedule', 'jadwal', 'search', 'ongoing', 'latest', 'anime', 'detail', 'episodes', 'stream', 'comments'].includes(cmd)) {
    console.log(USAGE)
    process.exit(cmd ? 1 : 0)
  }

  let out
  if (cmd === 'home') {
    out = await home({ day: v.day || undefined, limit: n(v.limit, 12), log })
  } else if (cmd === 'genres') {
    out = await genres({ log })
  } else if (cmd === 'schedule' || cmd === 'jadwal') {
    out = await schedule({ day: v.day || 'all', log })
  } else if (cmd === 'search') {
    // keyword kosong = jelajah katalog (tetap valid, apalagi pas --genre)
    out = await search(arg || v.q, {
      page: p0(v.page), pages: n(v.pages, 1), sort: v.sort,
      genreIds: v.genre ? v.genre.split(',').map((x) => x.trim()).filter(Boolean) : [],
      limit: n(v.limit, 0), log,
    })
  } else if (cmd === 'ongoing') {
    out = await ongoing({ day: v.day || undefined, pages: p0(v.pages), sort: v.sort, log })
  } else if (cmd === 'latest') {
    out = await latest({ limit: n(v.limit, 30), day: v.day || undefined, log })
  } else if (cmd === 'anime' || cmd === 'detail') {
    out = await detail(arg, { log })
  } else if (cmd === 'episodes') {
    out = await episodes(arg, { page: p0(v.page), pages: n(v.pages, 1), all: !!v.all, q: v.q, log })
  } else if (cmd === 'stream') {
    out = await stream(arg, { log })
  } else {
    out = await comments(arg, { sort: v.sort === 'views' ? 'top' : v.sort, page: p0(v.page), log })
  }

  console.log(JSON.stringify(out, null, 2))
} catch (e) {
  console.error('[!]', e.message || e)
  process.exit(1)
}
