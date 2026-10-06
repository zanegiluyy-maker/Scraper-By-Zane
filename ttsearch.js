/**
 * Name : TikTok Search via GetDL (Search video keyword, playUrl direct MP4, stats, author, music)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://www.tiktok.com
 * Type : Scraper
 * Function : Ambil post via https://getdl.space/id/search/tiktok → POST /api/session (cookie getdl_sid) →
 *            POST /api/search/tiktok → JSON lengkap (playUrl langsung viewable/downlod).
 * Note : error fix sendiri.
 *        Region opsional: id|us|br|jp|cn|...  SortType: 0=relevance,1? default 0.
 *        Rate limited: tinggal tunggu beberapa detik lalu ulang (script sudah handle RATE_LIMITED 1x).
 *        Usage:
 *          node tiktok.js search "kucing" --limit 5
 *          node tiktok.js search "indah alhambra" --region us --cursor 10
 */

import { parseArgs } from 'node:util'

const BASE    = 'https://getdl.space'
const SESSION = `${BASE}/api/session`
const SEARCH  = `${BASE}/api/search/tiktok`
const TIMEOUT = 25_000
const RETRIES = 3
const RETRYABLE = new Set([403, 408, 425, 429, 500, 502, 503, 504])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const jar = new Map()

const ck = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
const store = (res) => {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [p] = c.split(';')
    const i = p.indexOf('=')
    if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim())
  }
}

async function req(url, { method = 'GET', body, headers = {}, log } = {}) {
  let lastErr
  for (let i = 0; i <= RETRIES; i++) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), TIMEOUT)
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': UA, Accept: 'application/json, text/html', Referer: `${BASE}/id/search/tiktok`, Cookie: ck(), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: ac.signal, redirect: 'follow',
      })
      store(res)
      let txt = await res.text()
      let data
      try { data = JSON.parse(txt) } catch {}
      log?.(`[${res.status}] ${method} ${url.slice(0, 90)}`)
      if (data?.code === 'RATE_LIMITED') {
        if (i < RETRIES) { lastErr = new Error('RATE_LIMITED'); await sleep(5000 * (i + 1)); continue }
        throw new Error('Terlalu banyak request, tunggu lalu coba lagi.')
      }
      if (RETRYABLE.has(res.status) && i < RETRIES) { lastErr = new Error(`HTTP ${res.status}`); await sleep(Math.min(1000 * 2 ** i, 8000)); continue }
      if (!data) throw new Error(`Bukan JSON (${res.status}): ${txt.slice(0, 120)}`)
      return data
    } catch (e) {
      lastErr = e
      if (e.name !== 'AbortError' && !(e instanceof TypeError)) break
      await sleep(Math.min(1000 * 2 ** i, 8000))
    } finally { clearTimeout(t) }
  }
  throw lastErr || new Error('Request gagal')
}

let sessionId = null
async function ensureSession({ log } = {}) {
  if (sessionId) return sessionId
  const data = await req(SESSION, { log })
  if (!data?.success || !data?.sessionId) throw new Error('Gagal membuat session GetDL.')
  sessionId = data.sessionId
  return sessionId
}

export async function searchVideos(keyword, { limit = 10, cursor = 0, region = 'id', sortType = 0, log } = {}) {
  if (!keyword?.trim()) throw new Error('Kata kunci wajib.')
  const sid = await ensureSession({ log })
  const data = await req(SEARCH, {
    method: 'POST', log,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: { query: keyword, count: limit, cursor, region, sortType, sessionId: sid },
  })
  if (!data?.success || !data?.data) throw new Error(data?.error || 'Gagal search GetDL.')
  const videos = (data.data.videos || []).map((v) => ({
    id: v.videoId, awemeId: v.awemeId,
    title: v.title,
    duration: v.duration,
    region: v.region,
    cover: v.cover || v.originCover || null,
    playUrl: v.playUrl || null,
    wmPlayUrl: v.wmPlayUrl || null,
    stats: v.stats || null,
    author: v.author ? { id: v.author.id, username: v.author.username, nickname: v.author.nickname, avatar: v.author.avatar } : null,
    music: v.music ? { id: v.music.id, title: v.music.title, author: v.music.author, duration: v.music.duration, playUrl: v.music.play || null, cover: v.music.cover } : null,
    createdAt: v.createdAt ? new Date(v.createdAt * 1000).toISOString() : null,
  }))
  return { keyword, count: videos.length, cursor: data.data.cursor, hasMore: data.data.hasMore, region: data.data.region, videos }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: v, positionals: [cmd, arg] } = parseArgs({
    args: process.argv.slice(2),
    options: { limit: { type: 'string', default: '10' }, cursor: { type: 'string', default: '0' }, region: { type: 'string', default: 'id' }, sortType: { type: 'string', default: '0' }, verbose: { type: 'boolean', short: 'v', default: false } }, allowPositionals: true,
  })
  const log = v.verbose ? (s) => process.stderr.write(s + '\n') : () => {}
  try {
    if (cmd !== 'search' || !arg) { console.log('Usage:\n  node tiktok.js search <keyword> [--limit 10] [--cursor 0] [--region id|us] [--sortType 0]'); process.exit(0) }
    const out = await searchVideos(arg, { limit: parseInt(v.limit, 10) || 10, cursor: parseInt(v.cursor, 10) || 0, region: v.region, sortType: parseInt(v.sortType, 10) || 0, log })
    console.log(JSON.stringify(out, null, 2))
  } catch (e) { console.error(`❌ ${e.message}`); process.exit(1) }
}

export default { searchVideos }
    
