import crypto from 'node:crypto'
import FormData from 'form-data'
import axios from 'axios'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const PAGE_URL = 'https://www.iloveimg.com/upscale-image'

/** Pool server yang diiklankan halaman. */
const SERVERS = [
  'api1g', 'api2g', 'api3g', 'api8g', 'api9g', 'api10g', 'api11g',
  'api12g', 'api13g', 'api14g', 'api15g', 'api16g', 'api17g', 'api18g',
  'api19g', 'api20g', 'api21g', 'api22g', 'api24g', 'api25g',
]

/** Token opaque milik proyek iLoveIMG — jangan diubah. */
const TASK =
  'r68zl88mq72xq94j2d5p66bn2z9lrbx20njsbw2qsAvgmzr11lvfhAx9kl87pp6yqgx7c8vg7sfbqnrr42qb16v0gj8jl5s0kq1kgp26mdyjjspd8c5A2wk8b4Adbm6vf5tpwbqlqdr8A9tfn7vbqvy28ylphlxdl379psxpd8r70nzs3sk1'

const HTTP_TIMEOUT_MS = 45_000
const GPU_TIMEOUT_MS = 180_000 // GPU lama: scale 4 bisa 30–90 detik
const TOKEN_TTL_MS = 10 * 60_000
const MAX_RETRIES = 3

/** Cache session (hanya untuk tool ini — tidak dibagi dengan file lain). */
const sessionCache = new Map() // pageUrl -> { token, csrf, servers, ts }

/** Parse `ilovepdfConfig = {...}` + meta csrf dari HTML (regex, tanpa cheerio). */
function parseConfig(html) {
  const text = typeof html === 'string' ? html : Buffer.from(html || '').toString()

  let token = null
  let cfg = null
  const cfgIdx = text.indexOf('ilovepdfConfig')
  if (cfgIdx !== -1) {
    const objStart = text.indexOf('{', cfgIdx)
    const objEnd = text.indexOf('};', objStart)
    if (objStart !== -1 && objEnd !== -1) {
      try {
        cfg = JSON.parse(text.slice(objStart, objEnd + 1))
        token = cfg?.token || null
      } catch {}
    }
  }

  const csrf = text.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i)?.[1] || null
  return {
    token,
    csrf,
    servers: Array.isArray(cfg?.servers) && cfg.servers.length ? cfg.servers : null,
  }
}

/**
 * Ambil session (token + csrf + daftar server), di-cache `TOKEN_TTL_MS`.
 * Panggil `force=true` untuk refresh saat server membalas 401/403.
 * @param {boolean} [force]
 * @param {string}  [pageUrl]
 * @returns {Promise<{token: string, csrf: string, servers: string[]|null}>}
 */
export async function getTokenInfo(force = false, pageUrl = PAGE_URL) {
  const now = Date.now()
  const hit = sessionCache.get(pageUrl)
  if (!force && hit?.token && hit?.csrf && now - hit.ts < TOKEN_TTL_MS) {
    return { token: hit.token, csrf: hit.csrf, servers: hit.servers }
  }

  const res = await axios.get(pageUrl, {
    timeout: 15_000,
    headers: { 'User-Agent': UA, Accept: 'text/html' },
  })

  const { token, csrf, servers } = parseConfig(res.data)
  if (!token || !csrf) {
    throw new Error('Token/CSRF gagal diambil dari iloveimg.com (mungkin sedang down)')
  }

  sessionCache.set(pageUrl, { token, csrf, servers, ts: now })
  return { token, csrf, servers }
}

/** Header auth + multipart. */
function buildHeaders(token, csrf, multipart) {
  return {
    Authorization: `Bearer ${token}`,
    Origin: 'https://www.iloveimg.com/',
    Cookie: `_csrf=${csrf}`,
    'User-Agent': UA,
    ...(multipart ? multipart.getHeaders() : {}),
  }
}

/**
 * Klasifikasi error server.
 * @param {any} err
 * @returns {'auth'|'rate'|'server'|null} null = tidak dikenal
 */
function classifyError(err) {
  const st = err?.response?.status
  if (st === 401 || st === 403) return 'auth'
  if (st === 429) return 'rate'
  if (st && st >= 500) return 'server'
  if (/unauthorized|forbidden|invalid token/i.test(String(err?.message || ''))) return 'auth'
  return null
}

/** Pilih server acak, hindari yang sudah dipakai (retry ke host lain). */
function pickServer(pool = SERVERS, used = []) {
  const avail = pool.filter((s) => !used.includes(s))
  const src = avail.length ? avail : pool
  if (!src.length) return null
  return src[Math.floor(Math.random() * src.length)]
}

/**
 * POST multipart ke `https://{server}.iloveimg.com/v1/{path}`.
 * validateStatus dimatikan supaya HTTP error bisa dibaca (bukan dilempar
 * axios) → klasifikasi + pesan error yang jelas.
 */
async function postToTool({ server, path, token, csrf, form, timeout, responseType }) {
  const res = await axios.post(`https://${server}.iloveimg.com/v1/${path}`, form, {
    headers: buildHeaders(token, csrf, form),
    responseType,
    timeout,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  })
  if (res.status < 200 || res.status >= 300) {
    const body = responseType === 'arraybuffer'
      ? Buffer.from(res.data || []).toString('utf8')
      : JSON.stringify(res.data)
    const e = new Error(`HTTP ${res.status} pada /v1/${path}: ${String(body).slice(0, 200)}`)
    e.response = { status: res.status }
    throw e
  }
  return res
}

/** Form multipart upload 1 file. */
function buildUploadForm(fileName) {
  const form = new FormData()
  form.append('name', fileName)
  form.append('chunk', '0')
  form.append('chunks', '1')
  form.append('task', TASK)
  form.append('preview', '1')
  return form
}
// ═══════════════════════════════════════════════════════════════════
//  AKHIR BLOK BERSAMA
// ═══════════════════════════════════════════════════════════════════

// ── Tool: upscale ───────────────────────────────────────────────

/**
 * Normalisasi scale: hanya 2, 3, atau 4 yang didukung.
 * @param {number|string} scale
 * @returns {2|3|4}
 */
export function normalizeScale(scale) {
  const n = Number(scale)
  if (n === 2 || n === 3) return n
  return 4
}

async function uploadImage({ server, token, csrf, buffer }) {
  const form = buildUploadForm('image.jpg')
  form.append('file', buffer, 'image.jpg')
  const res = await postToTool({ server, path: 'upload', token, csrf, form, timeout: HTTP_TIMEOUT_MS })
  return res.data
}

async function requestUpscale({ server, token, csrf, serverFilename, scale }) {
  const form = new FormData()
  form.append('task', TASK)
  form.append('server_filename', serverFilename)
  form.append('scale', String(scale))

  const res = await postToTool({
    server,
    path: 'upscale',
    token,
    csrf,
    form,
    timeout: GPU_TIMEOUT_MS,
    responseType: 'arraybuffer',
  })

  const buf = Buffer.from(res.data || [])
  if (!buf.length) throw new Error('Hasil upscale kosong dari server')
  return buf
}

/**
 * Perbesar (upscale) gambar.
 *
 * @param {Buffer} buffer            Gambar sumber
 * @param {number} [scale=4]         Faktor pembesar: 2, 3, atau 4 (default 4)
 * @returns {Promise<{scale: 2|3|4, buffer: Buffer, server: string}>}
 * @throws {Error} buffer kosong / semua server gagal
 */
export async function upscaleImage(buffer, scale = 4) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('Buffer gambar kosong / bukan Buffer')
  }

  const finalScale = normalizeScale(scale)
  let { token, csrf } = await getTokenInfo(false, PAGE_URL)
  const used = []
  let lastErr = null

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const server = pickServer(SERVERS, used)
    if (!server) break
    used.push(server)

    try {
      const upload = await uploadImage({ server, token, csrf, buffer })
      const serverFilename = upload?.server_filename
      if (!serverFilename) throw new Error('Upload gagal: server_filename tidak ada')

      const outBuffer = await requestUpscale({ server, token, csrf, serverFilename, scale: finalScale })
      return { scale: finalScale, buffer: outBuffer, server }
    } catch (err) {
      lastErr = err
      // Token kedaluwarsa → refetch sekali lalu lanjut ke server berikutnya.
      if (classifyError(err) === 'auth') {
        try {
          const fresh = await getTokenInfo(true, PAGE_URL)
          token = fresh.token
          csrf = fresh.csrf
        } catch {}
      }
    }
  }

  throw lastErr || new Error('Gagal upscale gambar (semua server error)')
}

/** Nama file acak (kalau plugin mau simpan ke disk). */
export function randomFilename(ext = 'jpg') {
  return `${crypto.randomBytes(8).toString('hex')}.${ext.replace(/^\./, '')}`
}

export { SERVERS, TASK, HTTP_TIMEOUT_MS, GPU_TIMEOUT_MS, MAX_RETRIES, PAGE_URL }
