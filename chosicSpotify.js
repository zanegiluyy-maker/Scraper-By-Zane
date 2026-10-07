/**
 * Name : Chanzx Playlist Exporter Scraper (Spotify Playlist -> list track otomatis)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://www.chosic.com/spotify-playlist-exporter/
 * Type : Scraper
 * Function : ambil tracklist playlist public via token chosic + export txt/csv/m3u/json
 * Note : error fix sendiri.
 */

import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const CHOSIC = 'https://www.chosic.com'
const TOKEN  = `${CHOSIC}/api/tools/t/`
const SPOT   = 'https://api.spotify.com/v1'
const TIMEOUT  = 20_000
const RETRIES  = 3
const RETRYABLE = new Set([403, 408, 425, 429, 500, 502, 503, 504])

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
]
const ua = (i) => UAS[i % UAS.length]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function req(url, { headers = {}, method = 'GET', body, log } = {}) {
  let lastErr
  for (let i = 0; i <= RETRIES; i++) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), TIMEOUT)
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': ua(i), ...headers },
        body,
        redirect: 'follow',
        signal: ac.signal,
      })
      if (RETRYABLE.has(res.status) && i < RETRIES) {
        lastErr = new Error(`HTTP ${res.status} ${url}`)
        const wait = Math.min(2 ** i * 1000, 8000)
        log?.(`retry ${i + 1} (${res.status}) tunggu ${wait}ms`)
        await sleep(wait)
        continue
      }
      return res
    } catch (e) {
      lastErr = e
      if (i === RETRIES) break
      const wait = Math.min(2 ** i * 1000, 8000)
      log?.(`retry ${i + 1} (${e.name}) tunggu ${wait}ms`)
      await sleep(wait)
    } finally {
      clearTimeout(t)
    }
  }
  throw lastErr
}

const sleepMin = (ms) => (ms > 0 ? ms : 0)

/** Ambil token Spotify gratis milik chosic (butuh header browser biar lolos Cloudflare) */
export async function getToken({ log } = {}) {
  const res = await req(TOKEN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${CHOSIC}/spotify-playlist-analyzer/`,
      Origin: CHOSIC,
      Accept: '*/*',
    },
    body: new URLSearchParams({ app: 'playlist_analyzer' }).toString(),
    log,
  })
  if (!res.ok) throw new Error(`token gagal: HTTP ${res.status}`)
  const raw = await res.json()
  const data = JSON.parse(raw)
  if (!data.token) throw new Error('token kosong dari chosic')
  log?.(`token ok (${Math.round(data.time || 0)}s)`)
  return data.token
}

/** Ambil ID playlist dari URL apa pun */
export function playlistId(input) {
  const m = String(input).match(/playlist\/([A-Za-z0-9]{22})/)
  if (!m) throw new Error(`bukan link playlist: ${input}`)
  return m[1]
}

/** Info playlist (nama, owner, jumlah track) */
export async function playlistInfo(input, token, { log, market = 'US' } = {}) {
  const id = playlistId(input)
  const url = `${SPOT}/playlists/${id}?fields=name,description,owner(display_name,external_urls),followers(total),images,tracks(total),external_urls,public&market=${market}`
  const res = await req(url, { headers: { Authorization: `Bearer ${token}` }, log })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error?.message || `playlist ${res.status}`)
  return {
    id,
    name: data.name,
    description: data.description || '',
    owner: data.owner?.display_name || '',
    followers: data.followers?.total ?? null,
    image: data.images?.[0]?.url || '',
    total: data.tracks?.total ?? 0,
    url: data.external_urls?.spotify || `https://open.spotify.com/playlist/${id}`,
  }
}

/** Ambil semua track playlist (paging otomatis, 100 per halaman) */
export async function tracks(input, token, { log, market = 'US', limit = 100 } = {}) {
  const id = playlistId(input)
  const out = []
  let offset = 0
  let total = null
  do {
    const url = `${SPOT}/playlists/${id}/tracks?limit=${limit}&offset=${offset}&market=${market}`
    const res = await req(url, { headers: { Authorization: `Bearer ${token}` }, log })
    const data = await res.json()
    if (!res.ok) throw new Error(data?.error?.message || `tracks ${res.status}`)
    total = data.total
    for (const row of data.items || []) {
      const t = row.track
      if (!t || t.is_local) continue
      out.push({
        n: out.length + 1,
        title: t.name,
        artists: (t.artists || []).map((a) => a.name).join(', '),
        album: t.album?.name || '',
        duration: fmtDur(t.duration_ms),
        ms: t.duration_ms ?? 0,
        uri: t.uri,
        url: t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`,
        explicit: !!t.explicit,
        added: row.added_at || '',
      })
    }
    offset += limit
    log?.(`track ${out.length}/${total}`)
    if (offset < total) await sleep(sleepMin(250))
  } while (offset < total)
  return out
}

const fmtDur = (ms = 0) => {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`

/** Format export: txt / csv / m3u / json */
export function format(rows, fmt, meta = {}) {
  if (fmt === 'json') return JSON.stringify({ playlist: meta, tracks: rows }, null, 2)
  if (fmt === 'csv') {
    const head = 'no,title,artists,album,duration,url'
    return [head, ...rows.map((r) => [r.n, esc(r.title), esc(r.artists), esc(r.album), r.duration, r.url].join(','))].join('\n')
  }
  if (fmt === 'm3u') {
    return ['#EXTM3U', `#PLAYLIST:${meta.name || ''}`, ...rows.flatMap((r) => [`#EXTINF:${Math.round(r.ms / 1000)},${r.artists} - ${r.title}`, r.url])].join('\n')
  }
  return rows.map((r) => `${r.n}. ${r.artists} - ${r.title} [${r.duration}] ${r.url}`).join('\n')
}

/** Flow lengkap: token -> info -> semua track */
export async function exportPlaylist(input, { fmt = 'txt', out, market = 'US', log } = {}) {
  const token = await getToken({ log })
  const meta = await playlistInfo(input, token, { log, market })
  const rows = await tracks(input, token, { log, market })
  const text = format(rows, fmt, meta)
  if (out) {
    await writeFile(out, text, 'utf8')
    log?.(`saved ${out}`)
  }
  return { meta, rows, text }
}

const { values: v, positionals } = parseArgs({
  options: {
    fmt:   { type: 'string', short: 'f', default: 'json' },
    out:   { type: 'string', short: 'o' },
    market:{ type: 'string', short: 'm', default: 'US' },
    quiet: { type: 'boolean', short: 'q', default: false },
  },
  allowPositionals: true,
})

const url = positionals[0] || process.env.SPOTIFY_PLAYLIST
if (!url) {
  console.log('pakai: node chosicplaylist.js <url-playlist> [-f json|txt|m3u|csv] [-o out.json]')
  console.log('contoh: node chosicplaylist.js https://open.spotify.com/playlist/4dWDoT3WBviqWbXK2aX8Rr')
  process.exit(1)
}

const log = v.quiet ? null : (m) => console.error('[*]', m)
try {
  const { meta, rows, text } = await exportPlaylist(url, { fmt: v.fmt, out: v.out, market: v.market, log })
  if (v.out) console.log(`done: ${meta.name} — ${rows.length} track -> ${v.out}`)
  else console.log(text)
} catch (e) {
  console.error('[!]', e.message || e)
  process.exit(1)
}
