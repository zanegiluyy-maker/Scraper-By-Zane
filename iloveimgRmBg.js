import FormData from 'form-data'
import axios from 'axios'

// ═══════════════════════════════════════════════════════════════════
//  KONFIGURASI + TOKEN  (identik dengan iloveimgUpscale.js)
// ═══════════════════════════════════════════════════════════════════
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const PAGE_URL = 'https://www.iloveimg.com/remove-background'

/** Pool server cadangan; halaman tool ini mengiklankan api4g/5g/6g. */
const SERVERS = [
  'api1g', 'api2g', 'api3g', 'api8g', 'api9g', 'api10g', 'api11g',
  'api12g', 'api13g', 'api14g', 'api15g', 'api16g', 'api17g', 'api18g',
  'api19g', 'api20g', 'api21g', 'api22g', 'api24g', 'api25g',
]

/** Token opaque milik proyek iLoveIMG — jangan diubah. */
const TASK =
  'r68zl88mq72xq94j2d5p66bn2z9lrbx20njsbw2qsAvgmzr11lvfhAx9kl87pp6yqgx7c8vg7sfbqnrr42qb16v0gj8jl5s0kq1kgp26mdyjjspd8c5A2wk8b4Adbm6vf5tpwbqlqdr8A9tfn7vbqvy28ylphlxdl379psxpd8r70nzs3sk1'

const HTTP_TIMEOUT_MS = 45_000
const GPU_TIMEOUT_MS = 180_000
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

/** Batas dari config halaman (lihat header file). */
export const RM_BG_MAX_BYTES = 2 * 1024 * 1024
export const RM_BG_MAX_PIXELS = 4_403_200
/** Tipe yang diterima sisi web (dari `mimeTypes.removebackgroundimage`). */
export const RM_BG_MIME = 'image/jpeg,image/jpg,image/png'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Validasi PNG lewat magic byte + parse IHDR.
 * @param {Buffer} buf
 * @returns {{width: number, height: number}|null} null bila bukan PNG
 */
export function inspectPng(buf) {
  if (!buf || buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) return null
  // byte 0-7 signature, 8-11 panjang, 12-15 "IHDR", 16-19 width, 20-23 height
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

async function uploadForRmBg({ server, token, csrf, buffer, fileName }) {
  const form = buildUploadForm(fileName)
  form.append('file', buffer, { filename: fileName, contentType: 'image/jpeg' })
  const res = await postToTool({ server, path: 'upload', token, csrf, form, timeout: HTTP_TIMEOUT_MS })
  const serverFilename = res.data?.server_filename
  if (!serverFilename) throw new Error('Upload gagal: server_filename tidak ada di response')
  return serverFilename
}

async function requestRemoveBackground({ server, token, csrf, serverFilename }) {
  const form = new FormData()
  form.append('task', TASK)
  form.append('server_filename', serverFilename)
  const res = await postToTool({
    server,
    path: 'removebackground',
    token,
    csrf,
    form,
    timeout: GPU_TIMEOUT_MS,
    responseType: 'arraybuffer',
  })
  return Buffer.from(res.data || [])
}

/**
 * Hapus background dari gambar → PNG transparan (RGBA).
 *
 * @param {Buffer} buffer            Gambar sumber (JPG/PNG)
 * @param {object} [opts]
 * @param {string} [opts.fileName]   Nama file (default 'image.jpg')
 * @param {(stage: 'token'|'upload'|'process', detail?: string) => void} [opts.onProgress]
 *        Callback progres nyata per tahap untuk loading message bertahap.
 *        Dipanggil TANPA await → harus sinkron dan tidak boleh throw
 *        (scraper bungkus sendiri dengan try/catch).
 * @returns {Promise<{buffer: Buffer, width: number, height: number, server: string, transparent: boolean}>}
 * @throws {Error} buffer kosong / >2MB / hasil bukan PNG / semua server gagal
 */
export async function removeBackgroundImage(buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('Buffer gambar kosong / bukan Buffer')
  }
  if (buffer.length > RM_BG_MAX_BYTES) {
    throw new Error(
      `Ukuran ${(buffer.length / 1048576).toFixed(2)} MB melebihi batas 2 MB iLoveIMG. ` +
      `Kompres/resize dulu di server.`
    )
  }

  const fileName = String(opts.fileName || 'image.jpg').replace(/[^\w.\-]/g, '_') || 'image.jpg'
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null
  const step = (stage, detail) => {
    if (!onProgress) return
    try { onProgress(stage, detail) } catch {}
  }

  step('token')
  let session = await getTokenInfo(false, PAGE_URL)

  // Prioritas: server yang diiklankan halaman tool ini; fallback ke pool
  // bersama kalau halaman tidak menyebut apa pun.
  const pool = (Array.isArray(session.servers) && session.servers.length ? session.servers : SERVERS).filter(Boolean)
  const used = []
  let lastErr = null

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const server = pickServer(pool, used)
    if (!server) break
    used.push(server)

    try {
      step('upload', server)
      const serverFilename = await uploadForRmBg({ server, ...session, buffer, fileName })
      step('process', server)
      const out = await requestRemoveBackground({ server, ...session, serverFilename })

      if (!out.length) throw new Error('Hasil remove-background kosong dari server')
      const png = inspectPng(out)
      if (!png) {
        throw new Error('Server membalas data yang bukan PNG yang valid (kemungkinan halaman error tersimpan)')
      }
      if (png.width * png.height > RM_BG_MAX_PIXELS) {
        throw new Error(`Hasil ${png.width}×${png.height} melebihi batas 4.4MP`)
      }

      return { buffer: out, width: png.width, height: png.height, server, transparent: true }
    } catch (err) {
      lastErr = err
      // Token/JWT kedaluwarsa → refresh sekali, lalu coba server berikutnya.
      if (classifyError(err) === 'auth') {
        try { session = await getTokenInfo(true, PAGE_URL) } catch {}
      }
    }
  }

  throw lastErr || new Error('Gagal remove background (semua server error)')
}

export { SERVERS, TASK, HTTP_TIMEOUT_MS, GPU_TIMEOUT_MS, MAX_RETRIES, PAGE_URL }
  
