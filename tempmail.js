/**
 * Name : Emailnator temp mail scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://www.emailnator.com
 * Type : Scraper
 * Function : generate alamat email sementara (domain / plusGmail / dotGmail), list & baca isi inbox
 * Note : tanpa API key; extend-email cuma jalan utk tipe `domain` (alamat Gmail di-pakai apa adanya)
 */

const BASE = 'https://www.emailnator.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const TIMEOUT_MS = 20_000

/** Tipe alamat: 1 = domain emailnator, 2 = gmail+alias, 3 = gmail titik. */
export const EMAIL_TYPES = { domain: 1, plusGmail: 2, dotGmail: 3 }

let cookieJar = ''

/** Flatten Set-Cookie jadi string "k=v; k2=v2" sesuai format header Cookie. */
function collectCookies(headers) {
  const raw = headers.getSetCookie ? headers.getSetCookie() : []
  return raw.map((c) => c.split(';')[0]).join('; ')
}

/** Panggil API emailnator. Cookie sesi disimpan antar-panggilan. */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': UA,
      Referer: `${BASE}/`,
      ...(cookieJar ? { Cookie: cookieJar } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  const fresh = collectCookies(res.headers)
  if (fresh) cookieJar = cookieJar ? `${cookieJar}; ${fresh}` : fresh

  let data = null
  try {
    data = await res.json()
  } catch {
    /* body bukan JSON — pesan di bawah sudah cukup jelas */
  }
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `HTTP ${res.status}`)
  }
  return data
}

/**
 * Buat satu email sementara.
 * @param {number[]} [ids] Gabungan EMAIL_TYPES (default plusGmail + dotGmail)
 * @returns {Promise<{email: string, type: string, email_type_id: number}>}
 */
export function generateEmail(ids = [EMAIL_TYPES.plusGmail, EMAIL_TYPES.dotGmail]) {
  return api('/api/generate-email', { method: 'POST', body: { ids } })
}

/**
 * Buat banyak email sekaligus.
 * @param {number} count
 * @param {number[]} [ids]
 * @returns {Promise<Array<{email: string}>>}
 */
export function generateBulk(count, ids = [EMAIL_TYPES.plusGmail, EMAIL_TYPES.dotGmail]) {
  return api('/api/generate-bulk-email', { method: 'POST', body: { ids, count } })
    .then((r) => r?.results || [])
}

/**
 * Daftar pesan di inbox.
 * @param {string} email
 * @param {number} [limit]
 * @returns {Promise<{messages: Array, message_count: number, message_limit: number}>}
 */
export function messageList(email, limit = 20) {
  return api('/api/message-list', { method: 'POST', body: { email, limit } })
}

/**
 * Isi lengkap satu pesan (`content` = HTML mentah dari pengirim).
 * @param {string} id
 */
export function getMessage(id) {
  return api(`/api/message/${encodeURIComponent(id)}`)
}

/** Hapus satu pesan dari inbox. */
export function deleteMessage(id) {
  return api(`/api/delete-message/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/**
 * Perpanjang umur email. HANYA berhasil untuk tipe `domain` — alamat
 * plusGmail/dotGmail milik Gmail dan tidak terdaftar di DB emailnator
 * (server balas 404 "Address not found").
 * @param {string} email
 */
export function extendEmail(email) {
  return api('/api/extend-email', { method: 'POST', body: { email } })
}
