/**
 * Name : TTDL.zone.id TikTok scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://ttdl.zone.id
 * Type : Scraper
 * Function : info + video no-watermark + foto slideshow + audio MP3 dari link TikTok
 * Note : TANPA key/captcha; URL mati/dihapus diverifikasi silang via oEmbed resmi TikTok (situs balas ok:true + konten acak utk URL invalid)
 */

const API = 'https://ttdl.zone.id/api/tiktok'
const OEMBED = 'https://www.tiktok.com/oembed'
const TIMEOUT_MS = 25_000
const MAX_BYTES = 50 * 1024 * 1024

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
]

function apiHeaders(i) {
  return {
    'User-Agent': UAS[i % UAS.length],
    Accept: 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://ttdl.zone.id/',
  }
}

/** Validasi format link TikTok (terima vt.tiktok.com short link). */
export function parseTiktokUrl(input) {
  const s = String(input || '').trim()
  if (!/^(https?:\/\/)?([\w-]+\.)?tiktok\.com\//i.test(s)) {
    throw new Error('Bukan link TikTok. Contoh: https://vt.tiktok.com/ZSbM4DXTu/')
  }
  return s.startsWith('http') ? s : `https://${s}`
}

/**
 * Ground truth dari oEmbed resmi TikTok (gratis, tanpa key).
 * @returns {{id: string|null, username: string|null, title: string}}
 */
async function oembedTruth(url) {
  const res = await fetch(`${OEMBED}?url=${encodeURIComponent(url)}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': UAS[0], Accept: 'application/json', Referer: 'https://www.tiktok.com/' },
  })
  if (!res.ok) throw new Error('Video tidak ditemukan atau sudah dihapus.')
  const j = await res.json().catch(() => null)
  const html = String(j?.html || '')
  return {
    id: html.match(/data-video-id="(\d+)"/)?.[1] || null,
    username: (j?.author_url?.match(/@([^/]+)/)?.[1] || '').toLowerCase() || null,
    title: j?.title || '',
  }
}

/**
 * Info + link download. Divalidasi silang: author/id hasil API harus
 * cocok dengan oEmbed, kalau tidak = URL mati (API balas konten acak).
 */
export async function getTiktokInfo(input) {
  const url = parseTiktokUrl(input)
  const truth = await oembedTruth(url)

  let res = await fetch(`${API}?url=${encodeURIComponent(url)}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: apiHeaders(0),
  })
  if (!res.ok && (res.status === 403 || res.status === 429)) {
    res = await fetch(`${API}?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: apiHeaders(1),
    })
  }
  if (!res.ok) throw new Error(`Server downloader sibuk (HTTP ${res.status}).`)
  const body = await res.json().catch(() => null)
  if (!body?.ok || !body?.data) throw new Error(body?.error || 'Gagal mengambil data.')

  const d = body.data
  const gotUser = String(d.author?.username || '').toLowerCase()
  const gotId = String(d.video?.id || d.photo?.id || '')
  if ((truth.username && gotUser && gotUser !== truth.username) || (truth.id && gotId && gotId !== truth.id)) {
    throw new Error('Video tidak ditemukan atau sudah dihapus.')
  }

  return {
    type: d.type,
    id: gotId || truth.id,
    username: d.author?.username || truth.username,
    nickname: d.author?.nickname || '',
    desc: d.video?.desc ?? d.photo?.desc ?? truth.title ?? '',
    stats: d.statistics || {},
    video: d.video
      ? { duration: d.video.duration, size: d.video.size, cover: d.video.thumbnail, nowm: d.video.download_nowm, wm: d.video.download_wm, stream: d.video.stream }
      : null,
    photos: Array.isArray(d.photo?.images)
      ? d.photo.images.filter((p) => p?.download).map((p) => ({ view: p.view, download: p.download }))
      : [],
    music: d.music?.download ? { title: d.music.title || '', author: d.music.author || '', download: d.music.download } : null,
  }
}

/**
 * Unduh file via proxy /dl/ situs (hanya host itu yang diizinkan).
 * @returns Buffer
 */
export async function downloadFile(fileUrl, { maxBytes = MAX_BYTES, timeoutMs = 120_000 } = {}) {
  let u
  try {
    u = new URL(String(fileUrl || ''))
  } catch {
    throw new Error('URL file tidak valid.')
  }
  if (u.host !== 'ttdl.zone.id' || !u.pathname.startsWith('/dl/')) {
    throw new Error('Host file tidak diizinkan.')
  }
  const res = await fetch(u.toString(), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': UAS[0], Referer: 'https://ttdl.zone.id/' },
  })
  if (!res.ok) throw new Error(`Unduhan gagal (HTTP ${res.status}).`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('File kosong.')
  if (buf.length > maxBytes) throw new Error('File melebihi 50MB.')
  return buf
}
