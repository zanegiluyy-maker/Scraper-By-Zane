/**
 * Name : Spotify Partner API Scraper (Search, Track, Album, Artist, Audio Preview)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://open.spotify.com
 * Type : Scraper
 * Function : search,full album, metadata, dl, dll lengkap
 * Note : error fix sendiri.
 */

import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const BASE        = 'https://open.spotify.com'
const EMBED_BASE  = 'https://embed.spotify.com/embed'
const TOKEN_API   = 'https://clienttoken.spotify.com/v1/clienttoken'
const PARTNER_API = 'https://api-partner.spotify.com/pathfinder/v1/query'
const TIMEOUT     = 20_000
const RETRIES     = 3
const RETRYABLE   = new Set([403, 408, 425, 429, 500, 502, 503, 504])

/** Track id fallback buat bootstrap token (lagu umum yang pasti ada). */
const BOOTSTRAP_TRACK = '4cOdK2wGLETKBW3PvgPWqT'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
]
const ua = (i) => UAS[i % UAS.length]

/** Helper request minimal dengan timeout, retry (lihat RETRYABLE), dan rotasi User-Agent
 * dipakai semua fetch halaman + API publik.
 */
async function req(url, { headers = {}, method = 'GET', body, log } = {}) {
  let lastErr
  for (let i = 0; i <= RETRIES; i++) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), TIMEOUT)
    try {
      const res = await fetch(url, {
        method, headers: { 'User-Agent': ua(i), Accept: '*/*', ...headers },
        body, signal: ac.signal, redirect: 'follow',
      })
      const txt = await res.text()
      log?.(`[${res.status}] ${method} ${url.slice(0, 90)} (try ${i + 1})`)
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

// ── TOKEN: diambil dari HTML embed, di-cache ────────────────────────
let sessionCache = null
/** Ambil anonymous accessToken + expiry dari HTML halaman embed Spotify
 * (parse `__NEXT_DATA__`), di-cache sampai hampir expired.
 */
async function getSession({ log, force = false } = {}) {
  if (!force && sessionCache && Date.now() < sessionCache.expiryMs - 60_000) return sessionCache
  const { txt } = await req(`${EMBED_BASE}/track/${BOOTSTRAP_TRACK}`, { log })
  const m = txt.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) throw new Error('Session bootstrap gagal: __NEXT_DATA__ tidak ditemukan.')
  const data = JSON.parse(m[1])
  const sess = data?.props?.pageProps?.state?.settings?.session
  if (!sess?.accessToken) throw new Error('Session bootstrap gagal: token tidak ditemukan.')
  sessionCache = { accessToken: sess.accessToken, expiryMs: sess.accessTokenExpirationTimestampMs, isAnonymous: sess.isAnonymous }
  return sessionCache
}

let clientTokenCache = null
/** Ambil client-token dari https://clienttoken.spotify.com/v1/clienttoken,
 * di-cache juga.
 */
async function getClientToken({ log, force = false } = {}) {
  if (!force && clientTokenCache && Date.now() < clientTokenCache.expiryMs - 60_000) return clientTokenCache
  const payload = {
    client_data: {
      client_version: '1.2.57.409.g175f186c', client_id: 'f6a40776580943a7bc5173125a1e8832',
      js_sdk_data: { device_brand: 'Chrome', device_model: 'Windows', os: 'Windows', os_version: '10', container_version: '0.0.0', device_id: '', device_type: 'computer', platform_identifier: 'web_player' },
    },
  }
  const { txt } = await req(TOKEN_API, {
    method: 'POST', log,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  const d = JSON.parse(txt)
  if (!d.granted_token?.token) throw new Error('Client token gagal diambil.')
  clientTokenCache = { token: d.granted_token.token, expiryMs: Date.now() + (d.granted_token.refresh_after_seconds ?? 3600) * 1000 }
  return clientTokenCache
}

const HASH_OK = new Set()   // hash yang terbukti valid untuk operasi saat ini
const SEARCH_HASHES = [
  'eff59fa0a3d026b88b56fddbcf4bdfa16a186b8175a5c1a358c072e053c2e5b0',
  '21b3fe49546912ba782db5c47e9ef5a7dbd20329520ba0c7d0fcfadee671d24e',
  '3c9d3f60dac5dea3876b6db3f534192b1c1d90032c4233c1bbaba526db41eb31',
]
const META_HASHES = {
  getTrack: ['612585ae06ba435ad26369870deaae23b5c8800a256cd8a57e08eddc25a37294'],
}

/** Wrapper: kirim persisted GraphQL query ke api-partner.spotify.com/pathfinder/v1/query.
 * Otomatis refresh token jika 401, dan coba kandidat hash berurutan jika 400 (rotasi hash).
 */
async function pathfinder(operationName, variables, hashCandidates, { log } = {}) {
  const session = await getSession({ log })
  const client = await getClientToken({ log })
  // percobaan per kandidat hash, refresh token saat 401, retry hash berikutnya saat 400 unknown query
  const ordered = hashCandidates.slice()
  hashCandidates.forEach((h) => { /* keep order; valid hashes first */ if (HASH_OK.has(h)) { ordered.splice(ordered.indexOf(h), 1); ordered.unshift(h) } })
  let lastErr = null
  for (const hash of ordered) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const params = new URLSearchParams({
        operationName,
        variables: JSON.stringify(variables),
        extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
      })
      try {
        const { res, txt } = await req(`${PARTNER_API}?${params}`, {
          headers: {
            Authorization: `Bearer ${session.accessToken}`,
            'Client-Token': client.token,
            Accept: 'application/json', 'Content-Type': 'application/json',
            Origin: BASE, Referer: `${BASE}/`, 'Spotify-App-Platform': 'WebPlayer',
          },
          log,
        })
        if (res.status === 401 || /token has expired/i.test(txt)) {
          await getSession({ log, force: true })
          session.accessToken = sessionCache.accessToken
          continue
        }
        if (res.status === 400 && /unknown|not found|not supported|hash/i.test(txt)) { lastErr = new Error(`Hash ${hash.slice(0, 8)}.. gagal`); break }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 140)}`)
        HASH_OK.add(hash)
        return JSON.parse(txt)
      } catch (e) {
        lastErr = e
        if (/Hash /.test(e.message)) break   // coba hash berikutnya
        if (attempt === 1) throw e
      }
    }
  }
  throw lastErr || new Error(`Semua kandidat hash gagal untuk operation ${operationName}.`)
}

// ── PARSE HASIL EMBED / NEXT_DATA ───────────────────────────
/** Parse entity JSON dari script tag `__NEXT_DATA__` di HTML embed.
 */
function parseEmbed(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) throw new Error('__NEXT_DATA__ tidak ditemukan.')
  const data = JSON.parse(m[1])
  const entity = data?.props?.pageProps?.state?.data?.entity
  if (!entity) throw new Error('Entity tidak ditemukan di embed page.')
  return entity
}

const embedEntity = async (type, id, { log } = {}) => {
  const { txt } = await req(`${EMBED_BASE}/${type}/${id}`, { log })
  return parseEmbed(txt)
}

const mapTrack = (t) => ({
  id: (t.uri || '').split(':').pop() || null,
  spotifyUri: t.uri || null,
  url: t.uri ? `https://open.spotify.com/track/${t.uri.split(':').pop()}` : null,
  title: t.title || t.name || null,
  artists: (t.artists?.items || (Array.isArray(t.artists) ? t.artists : [])).map((a) => a.name || a.profile?.name).filter(Boolean),
  album: t.album?.name || null,
  albumId: (t.album?.uri || '').split(':').pop() || null,
  albumCover: t.album?.coverArt?.sources?.[0]?.url || t.visualIdentity?.image?.sources?.[0]?.url || null,
  isExplicit: !!t.isExplicit,
  durationMs: typeof t.duration === 'number' ? t.duration : t.duration?.totalMilliseconds ?? null,
  isPlayable: t.isPlayable !== false,
  playabilityReason: t.playabilityReason || null,
  audioPreviewUrl: t.audioPreview?.url || null,
})

// ── PUBLIK API ─────────────────────────────────────────────
/** Cari lewat searchDesktop (api-partner). Balikkan tracks/albums/artists/top lengkap
 * jadi objek metadata bersih yang siap JSON.
 */
export async function search(term, { limit = 10, offset = 0, log } = {}) {
  if (!term?.trim()) throw new Error('Kata kunci wajib diisi.')
  const variables = {
    searchTerm: term, offset, limit, numberOfTopResults: 5,
    includeAudiobooks: false, includePreReleases: true, includeAlbumPreReleases: false,
    includeAuthors: false, includeEpisodeContentRatingsV2: false,
  }
  const data = await pathfinder('searchDesktop', variables, SEARCH_HASHES, { log })
  const search = data?.data?.searchV2 || data?.data?.search
  if (!search) throw new Error('Format respons search tidak dikenal.')
  const extract = (x) => x?.item?.data || x?.track || x?.data || x
  const tracks = (search.tracksV2?.items || search.tracks?.items || []).map((x) => mapTrack(((x) => ({ ...(x.item?.data || x.track || x.data || x), album: (x.item?.data || x.track || x.data || x)?.album || (x.item?.data || x.track || x)?.albumOfTrack }))(x)))
  const albums = (search.albumsV2?.items || search.albums?.items || []).map((x) => extract(x))
    .filter((x) => x && x.uri).map((x) => ({
      id: x.uri.split(':').pop(), name: x.name || x.title, artists: (x.artists?.items || []).map((a) => a.profile?.name || a.name).filter(Boolean),
      coverArt: x.coverArt?.sources?.[0]?.url || null, year: x.date?.year || null, uri: x.uri,
    }))
  const artists = (search.artistsV2?.items || search.artists?.items || []).map((x) => extract(x))
    .filter((x) => x && x.uri).map((x) => ({ id: x.uri.split(':').pop(), name: x.profile?.name || x.name, uri: x.uri, avatar: x.visuals?.avatarImage?.sources?.[0]?.url || null }))
  const top = (search.topResults?.items || []).map((x) => {
    const raw = extract(x) || x
    return raw?.uri?.includes(':track:') ? mapTrack({ ...raw, album: raw.albumOfTrack || raw.album }) : raw
  })
  return { term, totalTracks: (search.tracksV2 || search.tracks)?.totalCount ?? tracks.length, tracks, albums, artists, top, raw_meta: data?.extensions || null }
}

/** Metadata lengkap satu track via halaman embed track.
 */
export async function track(idOrUri, { log } = {}) {
  const id = String(idOrUri || '').replace(/^spotify:track:/, '').replace(/^.*\/track\//, '').split('?')[0]
  if (!id) throw new Error('--id wajib diisi.')
  // preview URL biasanya hanya ada di embed page
  const embed = await embedEntity('track', id, { log })
  return mapTrack(embed)
}

/** Metadata album + daftar track via halaman embed album (trackList).
 */
export async function album(idOrUri, { log } = {}) {
  const id = String(idOrUri || '').replace(/^spotify:album:/, '').replace(/^.*\/album\//, '').split('?')[0]
  if (!id) throw new Error('--id wajib diisi.')
  const e = await embedEntity('album', id, { log })
    const coverUrl = e.visualIdentity?.image?.sources?.[0]?.url || null
    return {
    id, name: e.name || e.title, artists: (e.artists || []).map((a) => a.name).filter(Boolean),
    releaseDate: e.releaseDate?.isoString || null, totalTracks: (e.trackList || []).length,
    tracks: (e.trackList || []).map((t) => mapTrack({ ...t, album: { name: e.name, uri: e.uri, coverArt: { sources: coverUrl ? [{ url: coverUrl }] : [] } } })),
  }
}

/** Metadata artist via halaman embed artist.
 */
export async function artist(idOrUri, { log } = {}) {
  const id = String(idOrUri || '').replace(/^spotify:artist:/, '').replace(/^.*\/artist\//, '').split('?')[0]
  if (!id) throw new Error('--id wajib diisi.')
  const e = await embedEntity('artist', id, { log })
  return { id, name: e.name || e.title, subtitle: e.subtitle || null, relatedEntityUri: e.relatedEntityUri || null, tracks: (e.trackList || []).map((t) => mapTrack(t)) }
}


// ── SPOTIDOWN (full MP3 JSON) ──────────────────────────────
const SDIDR_BASE = 'https://spotidown.net/en'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const sdJar = new Map()  // PHPSESSID
const sdAddCookies = (res) => {
  const getSet = res.headers.getSetCookie?.() ?? []
  for (const c of getSet) { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) sdJar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()) }
}
const sdCk = () => [...sdJar].map(([k, v]) => `${k}=${v}`).join('; ')
const sdHdrs = () => ({ 'User-Agent': UA, Accept: '*/*', Cookie: sdCk() })

/** Request untuk spotidown.net: simpan PHPSESSID cookie jar sendiri,
 * retry untuk 403/429/5xx.
 */
async function sdReq(url, { method = 'GET', body, headers = {}, raw = false, log } = {}) {
  let lastErr
  for (let i = 0; i <= RETRIES; i++) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), TIMEOUT)
    try {
      const res = await fetch(url, { method, headers: { ...sdHdrs(), ...headers }, body, signal: ac.signal, redirect: 'follow' })
      sdAddCookies(res)
      log?.(`[${res.status}] ${method} ${url.slice(0, 90)}`)
      if (RETRYABLE.has(res.status) && i < RETRIES) { lastErr = new Error(`HTTP ${res.status}`); await sleep(Math.min(1000 * 2 ** i, 8000)); continue }
      return { res, txt: raw ? null : await res.text() }
    } catch (e) {
      lastErr = e
      if (e.name !== 'AbortError' && !(e instanceof TypeError)) break
    } finally { clearTimeout(t) }
  }
  throw lastErr || new Error(`Fetch gagal: ${url}`)
}

/** Ambil nonce Elementor dari halaman en/ saat pertama dipanggil. */
let nonce = null
/** Ambil nonce form Elementor dari homepage en/ spotidown.net.
 */
async function sdGetNonce({ log } = {}) {
  if (nonce) return nonce
  const { txt } = await sdReq(`${SDIDR_BASE}/`, { log })
  nonce = txt.match(/"nonce":"([a-f0-9]+)"/)?.[1] || txt.match(/ID, forms[^>]*nonce[^"']*['"]([a-f0-9]+)/)?.[1]
  if (!nonce) throw new Error('Nonce form tidak ditemukan di halaman awal spotidown.net.')
  return nonce
}

/** Mulai download & dapatkan redirect_url → unduh HTML yang memuat smdDownloadData. */
/** Submit form Elementor (action=elementor_pro_forms_send_form) dengan URL Spotify,
 * ambil redirect_url, parse halaman download yang memuat `smdDownloadData`.
 */
async function sdStartDownload(spotifyUrl, { log } = {}) {
  const n = await sdGetNonce({ log })
  const { res, txt } = await sdReq(`${SDIDR_BASE}/wp-admin/admin-ajax.php`, {
    method: 'POST', log,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${SDIDR_BASE}/`, Origin: 'https://spotidown.net' },
    body: new URLSearchParams({
      action: 'elementor_pro_forms_send_form', 'form_id': '394636d', 'post_id': '2', 'queried_id': '2', 'elementor_ajax': '1',
      'form_fields[music_url]': spotifyUrl, referrer: `${SDIDR_BASE}/`, nonce: n,
    }).toString(),
  })
  let json
  try { json = JSON.parse(txt) } catch { throw new Error(`Send-form bukan JSON (${res.status}).`) }
  const redirect = json?.data?.data?.['1']?.redirect_url
  if (!redirect) throw new Error(`redirect_url kosong (form rejected).`)
  const resolved = redirect.startsWith('http') ? redirect.replace('http://', 'https://') : `https://spotidown.net${redirect.replace('/en/?', '/en/').replace('/en//', '/en/')}`
  const page = await sdReq(resolved, { log })
  const start = page.txt.indexOf('smdDownloadData')
  let output = null
  if (start !== -1) {
    const eq = page.txt.indexOf('=', start)
    const brace = page.txt.indexOf('{', eq)
    if (brace !== -1) {
      let depth = 0, end = -1
      for (let i = brace; i < page.txt.length; i++) {
        if (page.txt[i] === '{') depth++
        else if (page.txt[i] === '}' && --depth === 0) { end = i; break }
      }
      if (end > brace) output = JSON.parse(page.txt.slice(brace, end + 1)).output
    }
  }
  if (!output) throw new Error(`smdDownloadData tidak ada (sdJar: ${[...sdJar.keys()].join(',')}) URL: ${resolved}`)
  return output
}

/** Ambil download_id dari check → poll get → kembalikan full URL download. */
/** Base64 encode {song_name, artist, link} → action=check_download_status →
 * poll action=get_download_status hingga `ready` lalu kembalikan download_url MP3.
 */
async function sdResolveMp3(item, { log, attempts = 25 } = {}) {
  const name = item.name || item.song_name
  const artists = (item.artists || []).map((a) => a.name).filter(Boolean).join(', ')
  const link = item.external_urls?.spotify || item.link
  const b64 = Buffer.from(encodeURIComponent(JSON.stringify({ song_name: name, artist: artists, link }))).toString('base64')
  const start = await sdReq(`${SDIDR_BASE}/wp-admin/admin-ajax.php?action=check_download_status&data=${encodeURIComponent(b64)}`, { log })
  let s
  try { s = JSON.parse(start.txt) } catch { throw new Error(`check_download_status bukan JSON.`) }
  if (!s?.success || !s?.data?.download_id) throw new Error('check_download_status gagal.')
  const did = s.data.download_id
  for (let i = 0; i < attempts; i++) {
    await sleep(1500)
    const { txt } = await sdReq(`${SDIDR_BASE}/wp-admin/admin-ajax.php?action=get_download_status&download_id=${encodeURIComponent(did)}`, { log })
    try {
      const d = JSON.parse(txt)
      log?.(`  poll ${i + 1}: ${d?.data?.status}`)
      if (d?.data?.status === 'ready' && d?.data?.download_url) {
        return { downloadUrl: d.data.download_url, title: d.data.title || name, thumbnail: d.data.thumbnail || null, track: item }
      }
      if (d?.data?.status === 'failed' || d?.data?.status === 'error') throw new Error(`Download gagal di server: ${d?.data?.message || 'unknown'}`)
    } catch (e) { if (/gagal di server/.test(e.message)) throw e }
  }
  throw new Error('Timeout: server belum siap memberi download_url.')
}

/** Resolve MP3 penuh untuk satu item track, TANPA simpan file → hasil JSON. */
/** Alur utama download MP3 penuh via spotidown.net: kirim URL → startDownload → resolveMp3
 * → return JSON berisi fullMp3Url + metadata + cookieHeader.
 */
export async function sdDownloadTrack(spotifyUrl, { log } = {}) {
  const output = await sdStartDownload(spotifyUrl, { log })
  let items = output.artist_tracks?.length ? output.artist_tracks : []
  if (!items.length && Array.isArray(output.tracks?.items)) {
    items = output.tracks.items.map((i) => ({ ...i, album: i.album || { images: output.images }, external_urls: i.external_urls || { spotify: `https://open.spotify.com/track/${i.id}` } }))
  }
  if (!items.length) items = [output]
  const saved = []
  for (const item of items) {
    const mp3 = await sdResolveMp3(item, { log })
    saved.push({
      title: mp3.title,
      artist: (item.artists || []).map((a) => a.name).join(', '),
      duration: item.duration || null,
      spotifyId: item.id || (mp3.track?.id) || null,
      spotifyUrl,
      cover: item.album?.images?.[0]?.url || null,
      thumbnail: mp3.thumbnail || null,
      previewUrl: item.preview_url || null,
      fullMp3Url: mp3.downloadUrl,
    })
    log?.(`  ✅ track: ${mp3.title}`)
  }
  return { type: output.type, total: saved.length, tracks: saved, cookieHeader: sdCk() }
}

// ── CLI ────────────────────────────────────────────────────
async function main() {
  const { values: v, positionals: [cmd, arg] } = parseArgs({
    args: process.argv.slice(2),
    options: {
      limit: { type: 'string', default: '10' }, offset: { type: 'string', default: '0' },
      out: { type: 'string' }, verbose: { type: 'boolean', short: 'v', default: false },
    }, allowPositionals: true,
  })
  const log = v.verbose ? (s) => process.stderr.write(s + '\n') : () => {}
  try {
    let out
    if (cmd === 'search') out = await search(arg, { limit: parseInt(v.limit, 10) || 10, offset: parseInt(v.offset, 10) || 0, log })
    else if (cmd === 'track') out = await track(arg, { log })
    else if (cmd === 'album') out = await album(arg, { log })
    else if (cmd === 'artist') out = await artist(arg, { log })
    else if (cmd === 'dl') {
      let url = arg
      if (!/^(https?:\/\/|spotify:)/.test(url || '')) {
        const r = await search(url, { limit: 1, log })
        url = r.tracks[0]?.url
        if (!url) throw new Error('Search tidak ada hasil.')
        console.error(`🎯 Hasil pertama: ${r.tracks[0].title} — ${r.tracks[0].artists?.join(', ')}`)
      }
      if (!url) throw new Error('<url|query> wajib.')
      out = await sdDownloadTrack(url, { log })
      if (v.limit && parseInt(v.limit, 10) > 0 && arg) out = out
    }
    else {
      console.log(`Usage:
  node spotify.js search <term> [--limit 10] [--offset 0]
  node spotify.js track <id|uri>
  node spotify.js album <id|uri>
  node spotify.js artist <id|uri>
Opsi: --verbose --out`); return
    }
    if (v.out) { await writeFile(v.out, JSON.stringify(out, null, 2), 'utf8').catch(() => {}); console.log(`💾 ${v.out}`) }
    console.log(JSON.stringify(out, null, 2))
  } catch (e) { console.error(`❌ ${e.message}`); process.exit(1) }
}

export default { search, track, album, artist, sdDownloadTrack }
if (import.meta.url === `file://${process.argv[1]}`) main()
      
