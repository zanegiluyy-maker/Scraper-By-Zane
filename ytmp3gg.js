/**
 * Name : media.ytmp3.gg YouTube MP3 scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://media.ytmp3.gg
 * Type : Scraper
 * Function : YouTube → MP3 (128/192/320k) via engine convert1s — POST /api/download → poll statusUrl → downloadUrl
 * Note : TANPA key/login/captcha (API publik); endpoint hasil = hub.convert1s.com, bukan domain situs; link BERTOKEN & kedaluwarsa (expires) jadi harus langsung diunduh; consent-checkbox situs murni gate UI tidak relevan untuk API
 */

import axios from 'axios'

const HUB = 'https://hub.convert1s.com'
const TIMEOUT = 30_000
const POLL_MS = 3000
const POLL_MAX = 40 // ~2 menit
const MAX_RETRY = 2

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
const REFERER = 'https://media.ytmp3.gg/'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function headers() {
  return {
    'User-Agent': UA,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Referer: REFERER,
    Origin: 'https://media.ytmp3.gg',
  }
}

/** Ekstrak 11-char video ID dari URL YouTube apapun. Null bila bukan URL valid. */
export function extractVideoId(input) {
  const s = String(input || '').trim()
  let m = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(s)
  if (m) return m[1]
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s
  return null
}

/** POST /api/download → { title, duration, statusUrl } (statusUrl sudah signed). */
async function createJob(videoId, bitrate = '128k') {
  let last = null
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const { data } = await axios.post(
        `${HUB}/api/download`,
        {
          url: `https://www.youtube.com/watch?v=${videoId}`,
          os: 'windows',
          output: { type: 'audio', format: 'mp3' },
          audio: { bitrate },
        },
        { headers: headers(), timeout: TIMEOUT, validateStatus: () => true }
      )
      if (data && data.statusUrl && data.title) return data
      last = new Error(data?.message || data?.error || 'Server tidak mengembalikan statusUrl.')
    } catch (e) {
      last = e
    }
    if (attempt < MAX_RETRY) await sleep(1500 * attempt)
  }
  throw last || new Error('Gagal membuat job konversi.')
}

/** Poll statusUrl → downloadUrl. */
async function pollJob(statusUrl) {
  for (let i = 0; i < POLL_MAX; i++) {
    let data = null
    try {
      const { data: d } = await axios.get(statusUrl, {
        headers: { 'User-Agent': UA, Accept: 'application/json', Referer: REFERER },
        timeout: TIMEOUT,
        validateStatus: () => true,
      })
      data = d
    } catch {
      // transient — poll lagi
    }
    if (data?.downloadUrl) return data
    if (data?.status === 'error') {
      throw new Error(data.jobError || data.error || 'Konversi gagal di server.')
    }
    await sleep(POLL_MS)
  }
  throw new Error('Timeout menunggu konversi (2 menit).')
}

/**
 * Minta link MP3 untuk satu video YouTube.
 * @param {string} videoId 11-char ID
 * @param {string} [bitrate] '128k' | '192k' | '320k'
 * @returns {Promise<{ok:true, title, link, duration} | {ok:false, why:string}>}
 */
export async function requestMp3(videoId, bitrate = '128k') {
  try {
    const job = await createJob(videoId, bitrate)
    const done = await pollJob(job.statusUrl)
    return {
      ok: true,
      title: done.title || job.title || '',
      link: done.downloadUrl,
      duration: done.duration || job.duration || null,
    }
  } catch (e) {
    return { ok: false, why: e.message || String(e) }
  }
}

/**
 * Unduh file MP3 dari link bertoken → Buffer. Headroom 15MB.
 * @returns {Promise<Buffer>}
 */
export async function downloadMp3(link, maxBytes = 15 * 1024 * 1024) {
  const res = await axios.get(link, {
    responseType: 'arraybuffer',
    timeout: 90_000,
    maxRedirects: 5,
    maxContentLength: maxBytes,
    headers: { 'User-Agent': UA, Referer: REFERER },
    validateStatus: () => true,
  })
  if (res.status !== 200) throw new Error(`Unduhan gagal (HTTP ${res.status}).`)
  const buf = Buffer.from(res.data)
  if (!buf.length) throw new Error('File audio kosong.')
  if (buf.length > maxBytes) throw new Error('Audio melebihi batas 15MB.')
  return buf
}

export default { extractVideoId, requestMp3, downloadMp3 }