/**
 * Name : Pinterest direct search scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://www.pinterest.com
 * Type : Scraper
 * Function : nyari gambar pinterest + download HD
 * Note : API butuh cookie csrftoken (diambil otomatis); 403 = refresh jar sekali
 */

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36'
const HOST = 'https://www.pinterest.com'
const T_PAGE = 20_000, T_API = 20_000, T_DL = 25_000
const MAX_BYTES = 15 * 1024 * 1024
const JAR_TTL = 10 * 60_000

// Jar cookie per proses (csrftoken kedaluwarsa → refresh otomatis saat 403).
let jar = '', csrf = '', jarAt = 0

/** Error typed: BAD_QUERY | NO_RESULT | BLOCKED | HTTP | TIMEOUT | NETWORK | BAD_IMAGE */
export class Pin4Error extends Error {
  /** @param {string} code @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message); this.name = 'Pin4Error'; this.code = code; Object.assign(this, extra)
  }
}

/** fetch + timeout; timer dibersihkan di finally. */
async function fetchT(url, headers, ms) {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  try {
    return await fetch(url, { headers, signal: c.signal, redirect: 'follow' })
  } finally { clearTimeout(t) }
}

/** Ambil/refresh cookie jar (homepage). */
async function getJar(force = false) {
  if (!force && jar && Date.now() - jarAt < JAR_TTL) return { jar, csrf }
  const r = await fetchT(HOST + '/', { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8' }, T_PAGE)
  await r.arrayBuffer().catch(() => {})
  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []
  jar = sc.map((x) => x.split(';')[0]).join('; ')
  csrf = (jar.match(/csrftoken=([^;]+)/) || [])[1] || ''
  if (!csrf) throw new Pin4Error('BLOCKED', 'Gagal ambil sesi Pinterest.')
  jarAt = Date.now()
  return { jar, csrf }
}

/** Normalisasi 1 pin → {id,title,image,board,username,source}. */
function normPin(p) {
  const images = p?.images || {}
  const image = images['736x']?.url || images['474x']?.url || images['236x']?.url || images.orig?.url || null
  if (!image) return null
  return {
    id: p?.id, title: p?.seo_alt_text || p?.title || 'No Title', image,
    board: p?.board?.name || '-', username: p?.pinner?.username || '-',
    source: p?.id ? `https://www.pinterest.com/pin/${p.id}/` : null,
  }
}

/** 1 halaman hasil (dengan bookmark opsional untuk halaman berikut). */
async function fetchPage(query, searchPath, bookmark) {
  const { jar: j, csrf: c } = await getJar()
  const payload = { options: { query, rs: 'rs', scope: 'pins', redux_normalize_feed: true, source_url: searchPath }, context: {} };
  const data = { ...payload }
  if (bookmark) data.options.bookmark = bookmark
  const url = HOST + '/resource/BaseSearchResource/get/?source_url=' + encodeURIComponent(searchPath) + '&rs=rs&data=' + encodeURIComponent(JSON.stringify(data))
  const r = await fetchT(url, {
    accept: 'application/json, text/javascript, */*; q=0.01',
    'x-pinterest-appstate': 'active', 'x-pinterest-pws-handler': 'www/search/[scope].js',
    'x-requested-with': 'XMLHttpRequest', 'user-agent': UA, referer: HOST + '/',
    'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    ...(c ? { 'x-csrftoken': c } : {}), Cookie: j,
  }, T_API)
  if (r.status === 403) return { blocked: true, items: [], bookmark: null }
  if (!r.ok) throw new Pin4Error('HTTP', 'Pinterest HTTP ' + r.status + '.', { status: r.status })
  const j2 = await r.json().catch(() => null)
  const items = (j2?.resource_response?.data?.results || []).map(normPin).filter(Boolean)
  return { blocked: false, items, bookmark: j2?.resource_response?.bookmark || null }
}

/**
 * Cari gambar.
 * @param {string} query kata kunci (maks 100 karakter)
 * @param {object} [opts] @param {number} [opts.limit=10] maks hasil
 * @returns {Promise<Array<{id,title,image,board,username,source}>>}
 */
export async function searchPins(query, opts = {}) {
  const q = String(query || '').trim().slice(0, 100)
  if (!q) throw new Pin4Error('BAD_QUERY', 'Query kosong.')
  const limit = Math.min(30, Math.max(1, Number(opts.limit) || 10))
  const searchPath = '/search/pins/?q=' + encodeURIComponent(q) + '&rs=rs'
  const out = []
  let bookmark = null, pages = 0
  for (;;) {
    let r
    try {
      r = await fetchPage(q, searchPath, bookmark)
    } catch (e) {
      if (e?.name === 'AbortError') throw new Pin4Error('TIMEOUT', 'Pinterest timeout.')
      throw new Pin4Error('NETWORK', 'Gagal koneksi Pinterest.')
    }
    if (r.blocked) { // sesi basi → refresh jar sekali, coba lagi sekali
      await getJar(true)
      r = await fetchPage(q, searchPath, bookmark).catch(() => null)
      if (!r || r.blocked) throw new Pin4Error('BLOCKED', 'Pinterest menolak request (403).')
    }
    out.push(...r.items)
    bookmark = r.bookmark
    if (out.length >= limit || !bookmark || ++pages >= 2) break
  }
  if (!out.length) throw new Pin4Error('NO_RESULT', `Tidak ketemu hasil untuk "${q}".`)
  return out.slice(0, limit)
}

/** Cek magic byte gambar (JPEG/PNG/GIF/WEBP). */
export function isImage(b) {
  if (!b || b.length < 4) return false
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true
  return b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'
}

/**
 * Download 1 gambar + validasi betulan gambar.
 * @param {string} url URL langsung (i.pinimg.com)
 * @returns {Promise<Buffer>}
 */
export async function downloadImage(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Pin4Error('BAD_IMAGE', 'URL gambar tidak valid.')
  let res
  try {
    res = await fetchT(url, { 'User-Agent': UA, Referer: HOST + '/', Accept: 'image/*,*/*;q=0.8' }, T_DL)
  } catch (e) {
    if (e?.name === 'AbortError') throw new Pin4Error('TIMEOUT', 'Download gambar timeout.')
    throw new Pin4Error('NETWORK', 'Download gagal koneksi.')
  }
  if (!res.ok) throw new Pin4Error('BAD_IMAGE', 'Download HTTP ' + res.status + '.')
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Pin4Error('BAD_IMAGE', 'Gambar kosong.')
  if (buf.length > MAX_BYTES) throw new Pin4Error('BAD_IMAGE', 'Gambar >15MB.')
  if (!isImage(buf)) throw new Pin4Error('BAD_IMAGE', 'Bukan file gambar valid.')
  return buf
}

export const _internal = { HOST, T_API, MAX_BYTES }
