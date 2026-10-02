/**
 * Name : 8daudio Full Scraper (Track Catalog + Detail + Play)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://8daudio.vercel.app
 * Type : Scraper
 * Function : Ambil katalog lagu, detail per track, dan increment play count via API JSON publik.
 * Note : Ini SPA React (Vite); semua data mengalir lewat endpoint JSON `/api/audio`.
 *        Native fetch (Node 18+), retry + exponential backoff + jitter, tanpa dependency tambahan.
 *        Usage:
 *          node eightdaudio.js library --status PUBLIC --out 8d-library.json
 *          node eightdaudio.js search --search "lofi" --genre Lo-Fi
 *          node eightdaudio.js track --id track-xxxx-xxxx
 *          node eightdaudio.js play --id track-xxxx-xxxx
 */

import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const BASE    = 'https://8daudio.vercel.app'
const TIMEOUT = 20_000
const RETRIES = 4
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

async function req(path, { method = 'GET', body, log } = {}) {
  const url = `${BASE}${path}`
  let lastErr
  for (let i = 0; i <= RETRIES; i++) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), TIMEOUT)
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': UA, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ac.signal, redirect: 'follow',
      })
      const txt = await res.text()
      log?.(`[${res.status}] ${method} ${url.slice(0, 90)} (try ${i + 1})`)
      if (RETRYABLE.has(res.status) && i < RETRIES) {
        const ra = Number(res.headers.get('retry-after'))
        await sleep(ra > 0 ? ra * 1000 : Math.min(1000 * 2 ** i, 12000) + Math.random() * 400)
        lastErr = new Error(`HTTP ${res.status}`); continue
      }
      let data
      try { data = JSON.parse(txt) } catch { throw new Error(`Bukan JSON (${res.status}): ${txt.slice(0, 120)}`) }
      if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`)
      return data
    } catch (e) {
      lastErr = e
      if (e.name !== 'AbortError' && !(e instanceof TypeError)) break
      await sleep(Math.min(1000 * 2 ** i, 12000))
    } finally { clearTimeout(t) }
  }
  throw lastErr || new Error(`Fetch gagal: ${url}`)
}

function normalizeTrack(t = {}) {
  return {
    id: t.id || null,
    title: typeof t.title === 'string' ? t.title.trim() : null,
    artist: typeof t.artist === 'string' ? t.artist.trim() : null,
    genre: typeof t.genre === 'string' ? t.genre.trim() : null,
    description: typeof t.description === 'string' ? t.description : '',
    duration: Number.isFinite(t.duration) ? t.duration : null,
    plays: Number.isFinite(t.plays) ? t.plays : 0,
    status: typeof t.status === 'string' ? t.status : null,
    audio_url: t.audio_url || null,
    cover_url: t.cover_url || null,
    created_at: t.created_at || null,
    updated_at: t.updated_at || null,
  }
}

/** Ambil daftar track. Filter opsional: status, search, genre. */
export async function fetchLibrary({ status, search, genre, log } = {}) {
  const p = new URLSearchParams()
  if (status) p.set('status', status)
  if (search) p.set('search', search)
  if (genre && genre !== 'Semua') p.set('genre', genre)
  const data = await req(`/api/audio?${p}`, { log })
  if (!Array.isArray(data)) throw new Error('Respons katalog bukan array.')
  return data.map(normalizeTrack)
}

/** Detail satu track by id. */
export async function fetchTrack(id, { log } = {}) {
  if (!id) throw new Error('--id wajib diisi')
  const t = await req(`/api/audio/${encodeURIComponent(id)}`, { log })
  return normalizeTrack(t)
}

/** Increment play count (POST /api/audio/:id/play). */
export async function registerPlay(id, { log } = {}) {
  if (!id) throw new Error('--id wajib diisi')
  return req(`/api/audio/${encodeURIComponent(id)}/play`, { method: 'POST', log })
}

async function main() {
  const { values: v, positionals: [cmd] } = parseArgs({
    args: process.argv.slice(2),
    options: {
      id: { type: 'string' }, status: { type: 'string' }, search: { type: 'string' },
      genre: { type: 'string' }, out: { type: 'string', default: '8d-audio.json' },
      verbose: { type: 'boolean', short: 'v', default: false },
    }, allowPositionals: true,
  })
  const log = v.verbose ? (s) => process.stderr.write(s + '\n') : () => {}
  try {
    if (cmd === 'library' || cmd === 'search') {
      const items = await fetchLibrary({ status: v.status, search: v.search, genre: v.genre, log })
      const out = { scrapedAt: new Date().toISOString(), base: BASE, total: items.length, filters: { status: v.status ?? null, search: v.search ?? null, genre: v.genre ?? null }, items }
      await writeFile(v.out, JSON.stringify(out, null, 2), 'utf8')
      console.log(`✅ ${items.length} track → ${v.out}`)
      return
    }
    if (cmd === 'track') {
      console.log(JSON.stringify(await fetchTrack(v.id, { log }), null, 2)); return
    }
    if (cmd === 'play') {
      console.log(JSON.stringify(await registerPlay(v.id, { log }), null, 2)); return
    }
    console.log(`Usage:
  node eightdaudio.js library [--status PUBLIC] [--genre Genre] [--out lib.json]
  node eightdaudio.js search --search <q> [--genre <g>]
  node eightdaudio.js track --id <trackId>
  node eightdaudio.js play --id <trackId>
Opsi: --verbose`)
  } catch (e) {
    console.error(`❌ ${e.message}`)
    process.exit(1)
  }
}

export default { fetchLibrary, fetchTrack, registerPlay }
if (import.meta.url === `file://${process.argv[1]}`) main()
