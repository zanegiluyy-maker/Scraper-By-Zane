import axios from 'axios'

const API_URL = 'https://igexport.com/api/ig-photo/'
const FETCH_TIMEOUT_MS = 30000

/**
 * Ambil media Instagram (image/video, single/carousel).
 * @param {string} url - URL postingan Instagram
 * @returns {Promise<{ok, source, media: {shortcode, items: Array<{type, url, filename}>}}>}
 */
export async function igPhoto(url) {
  if (!url) throw new Error('URL Instagram wajib diisi')

  const { data } = await axios.get(API_URL, {
    params: { url },
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://igexport.com/',
    },
    timeout: FETCH_TIMEOUT_MS,
  })

  if (!data?.ok || !data?.media?.items) {
    throw new Error(data?.message || 'Media Instagram tidak ditemukan')
  }

  return data
}
