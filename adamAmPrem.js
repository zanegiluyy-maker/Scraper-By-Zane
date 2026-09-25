Name : Amprem lagi
Owner : Zane
Base Web : adanurs(.)my(.)id
Note : Kata owner nya bebas skrep :v. *Error Fix Sendiri*

// Amprem bau
// Scrape By Zane
// https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F

import axios from 'axios'
import crypto from 'node:crypto'

const BASE = 'https://adamnurs.my.id'
const TIMEOUT = 30000
const MAX_RETRY = 3

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
]

const dip = () => [crypto.randomInt(1, 255), crypto.randomInt(0, 255), crypto.randomInt(0, 255), crypto.randomInt(1, 255)].join('.')

function headers() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': UAS[crypto.randomInt(0, UAS.length)],
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    Referer: BASE + '/',
    Origin: BASE,
    'x-forwarded-for': dip(),
    'x-real-ip': dip(),
    'client-ip': dip(),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function errMsg(e) {
  const d = e.response?.data
  if (d) {
    if (typeof d.message === 'string' && d.message) return d.message
    return typeof d === 'object' ? JSON.stringify(d).substring(0, 200) : String(d)
  }
  return e.message
}

// POST dgn retry (403/5xx/network error dicoba ulang, backoff 1s×attempt).
async function postRetry(path, body) {
  let last = null
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const { data } = await axios.post(BASE + path, body, {
        headers: headers(),
        timeout: TIMEOUT,
        validateStatus: () => true,
      })
      // 403/429/5xx → retry; 200/400 final (400 = respons logis, mis. kode invalid)
      if (data && typeof data === 'object') return data
      last = new Error('Respons kosong dari server')
    } catch (e) {
      last = e
    }
    if (attempt < MAX_RETRY) await sleep(1000 * attempt)
  }
  throw last || new Error('Gagal menghubungi server')
}

export async function sendLink(email) {
  if (!email || !String(email).includes('@')) return { ok: false, why: 'Email tidak valid' }
  try {
    const data = await postRetry('/api/send-link', { email: String(email).trim() })
    if (data?.success) return { ok: true, email: data.email || email, message: data.message }
    return { ok: false, why: data?.message || 'Gagal mengirim link' }
  } catch (e) {
    return { ok: false, why: errMsg(e) }
  }
}

export async function verifyLink(email, magicLink) {
  if (!email || !magicLink) return { ok: false, why: 'Email & magic link wajib diisi' }
  try {
    const data = await postRetry('/api/verify-link', { email: String(email).trim(), magicLink: String(magicLink).trim() })
    if (data?.success && data?.data) {
      const d = data.data
      return {
        ok: true,
        email: d.email || email,
        uid: d.uid || '-',
        orderId: d.orderId || '-',
        idToken: d.idToken || '',
        stats: d.stats || null,
      }
    }
    return { ok: false, why: data?.message || 'Verifikasi gagal' }
  } catch (e) {
    return { ok: false, why: errMsg(e) }
  }
}

export async function getStats() {
  try {
    const { data } = await axios.get(BASE + '/api/stats', { headers: headers(), timeout: TIMEOUT })
    if (data?.success) return { ok: true, total: data.total || 0, today: data.today || 0 }
    return { ok: false, why: 'Gagal ambil statistik' }
  } catch (e) {
    return { ok: false, why: errMsg(e) }
  }
}

export const sessions = new Map()

export default { sendLink, verifyLink, getStats, sessions }
