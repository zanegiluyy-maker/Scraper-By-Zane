const HOST = 'https://image.pollinations.ai'

// Cap keras: di atas ini server melambat brutal (2048² > 120 detik).
const MAX_DIM = 1024
const MAX_PIXELS = 1024 * 1024
const MIN_DIM = 64
const MAX_PROMPT = 1200

const T_GEN = 90_000
// Dimensi besar jauh lebih lambat di sisi server (terukur 2026-09-26):
//   512×512 → ~4 dtk, 768×512 → ~46 dtk, 1024×576 → ~40 dtk
// Variansi tinggi (antrean server), jadi timeout longgar: lebih baik menunggu
// daripada gagalDI tengah proses. User tetap melihat loading message progress.
const T_PER_MEGAPIXEL = 90_000
const RETRY_MAX = 3

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jitter = (ms) => ms + Math.floor(Math.random() * 400)

/** Dimensi yang Offered ke user. */
export const SHAPES = {
  square: { w: 512, h: 512, label: '1:1 · 512×512' },
  portrait: { w: 512, h: 768, label: '2:3 · 512×768' },
  landscape: { w: 768, h: 512, label: '3:2 · 768×512' },
  hd: { w: 768, h: 768, label: 'HD · 768×768' },
  wide: { w: 1024, h: 576, label: '16:9 · 1024×576' },
}

export class PollinationsError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'PollinationsError'
    this.code = code
    Object.assign(this, extra)
  }
}

/** Guard dimensi: clamp + tolak yang melebihi cap. */
function resolveDims(opts) {
  const shape = SHAPES[opts.shape] || SHAPES.square
  let w = Math.round(Number(opts.width) || shape.w)
  let h = Math.round(Number(opts.height) || shape.h)
  w = Math.min(MAX_DIM, Math.max(MIN_DIM, w))
  h = Math.min(MAX_DIM, Math.max(MIN_DIM, h))
  if (w * h > MAX_PIXELS) {
    // Turunkan proporsional biar tetap di bawah cap piksel.
    const k = Math.sqrt(MAX_PIXELS / (w * h))
    w = Math.max(MIN_DIM, Math.floor(w * k))
    h = Math.max(MIN_DIM, Math.floor(h * k))
  }
  return { w, h }
}

function isJpeg(buf) {
  return buf && buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
}

/**
 * Ambil metadata JSON yang tertanam di COM segment JPEG.
 * @param {Buffer} buf
 * @returns {object|null} objek metadata, atau null bila tidak ada/tidak bisa diparse
 */
export function extractMetadata(buf) {
  if (!buf || !buf.length) return null
  // Cari penanda {"prompt" dari belakang — stringify UTF-8/JSON selalu ASCII.
  const tail = buf.subarray(Math.max(0, buf.length - 4096)).toString('latin1')
  const at = tail.lastIndexOf('{"prompt"')
  if (at < 0) return null
  const json = tail.slice(at)
  // Scan depth sampai object balance penuh (bukan JSON.parse langsung, karena
  // bisa ada byte JPEG nyasar sebelum objek selesai).
  let depth = 0
  let end = -1
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end < 0) return null
  try { return JSON.parse(json.slice(0, end)) } catch { return null }
}

/** Timeout proporsional terhadap jumlah piksel. */
function timeoutFor(w, h, override) {
  if (Number.isFinite(Number(override)) && Number(override) > 0) return Number(override)
  const mp = (w * h) / 1_000_000
  return Math.max(T_GEN, Math.ceil(mp * T_PER_MEGAPIXEL))
}

/** Error transient yang layak retry. */
function classify(status) {
  if (status === 429) return { code: 'RATE', retryable: true, msg: 'Rate limit Pollinations (429). Coba beberapa detik lagi.' }
  if (status === 403 || status === 401) return { code: 'BLOCKED', retryable: true, msg: 'Pollinations memblokir request (403).' }
  if (status === 500 || status === 502 || status === 503) return { code: 'UPSTREAM', retryable: true, msg: `Server Pollinations bermasalah (HTTP ${status}).` }
  if (status === 400) return { code: 'BAD_REQ', retryable: false, msg: 'Permintaan ditolak Pollinations (400) — prompt/dimensi tidak valid.' }
  if (status === 404) return { code: 'NOT_FOUND', retryable: false, msg: 'Endpoint tidak ditemukan (404).' }
  return { code: 'HTTP', retryable: false, msg: `Pollinations balas HTTP ${status}.` }
}

async function rawFetch(url, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: ctrl.signal,
      redirect: 'follow',
    })
  } finally {
    clearTimeout(timer) // di finally: timer harus bersih walau fetch throw
  }
}

/**
 * Generate gambar dari prompt teks.
 *
 * @param {string} prompt                Deskripsi gambar (maks 1200 karakter)
 * @param {object} [opts]
 * @param {keyof SHAPES} [opts.shape]    'square' (default) | 'portrait' | 'landscape' | 'hd' | 'wide'
 * @param {number} [opts.width]          Lebar (di-clamp ke 64..1024)
 * @param {number} [opts.height]         Tinggi (di-clamp, total ≤ 1 MP)
 * @param {number|string} [opts.seed]    Seed (deterministik; default acak)
 * @param {string} [opts.negativePrompt] Prompt negatif
 * @returns {Promise<{buffer: Buffer, width: number, height: number, seed: number|string,
 *                    model: string, isMature: boolean, isChild: boolean, prompt: string}>}
 * @throws {PollinationsError} NO_PROMPT / PROMPT_TOO_LONG / TIMEOUT / RATE / HTTP
 */
export async function generateImage(prompt, opts = {}) {
  const text = String(prompt || '').trim()
  if (!text) throw new PollinationsError('NO_PROMPT', 'Prompt kosong.')
  if (text.length > MAX_PROMPT) {
    throw new PollinationsError('PROMPT_TOO_LONG', `Prompt ${text.length} karakter, maksimal ${MAX_PROMPT}.`)
  }

  const { w, h } = resolveDims(opts)
  const seed = opts.seed === undefined || opts.seed === null || opts.seed === ''
    ? Math.floor(Math.random() * 1_000_000_000)
    : opts.seed

  const q = new URLSearchParams({
    width: String(w),
    height: String(h),
    seed: String(seed),
    nologo: 'true', // diterima; logo tetap digambar di free tier
    private: 'true', // → nofeed, hasil tidak masuk feed publik
  })
  if (opts.negativePrompt) q.set('negative_prompt', String(opts.negativePrompt).slice(0, 400))

  const url = `${HOST}/prompt/${encodeURIComponent(text)}?${q}`
  const timeoutMs = timeoutFor(w, h, opts.timeoutMs)

  let lastErr = null
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      const res = await rawFetch(url, timeoutMs)

      if (!res.ok) {
        const info = classify(res.status)
        // Retry-After dihormati kalau ada (detik).
        const ra = Number(res.headers.get('retry-after'))
        if (!Number.isFinite(ra) || ra <= 0 || ra > 20) {
          await sleep(jitter(2000 * 2 ** (attempt - 1)))
        } else {
          await sleep(ra * 1000)
        }
        lastErr = new PollinationsError(info.code, info.msg, { status: res.status, retryable: info.retryable })
        if (!info.retryable) throw lastErr
        continue
      }

      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) throw new PollinationsError('EMPTY', 'Pollinations membalas body kosong.')
      if (!isJpeg(buf)) {
        // Body non-JPEG = biasanya halaman error / JSON.
        const head = buf.subarray(0, 120).toString('latin1').replace(/\s+/g, ' ')
        throw new PollinationsError('BAD_OUTPUT', `Bukan JPEG yang valid (${head})`, { status: res.status })
      }

      const meta = extractMetadata(buf)
      return {
        buffer: buf,
        width: Number(meta?.width) || w,
        height: Number(meta?.height) || h,
        seed: meta?.seed ?? seed,
        model: meta?.model || 'sana',
        isMature: !!(meta?.isMature ?? meta?.has_nsfw_concept),
        isChild: !!meta?.isChild,
        prompt: text,
      }
    } catch (err) {
      if (err instanceof PollinationsError && err.name === 'AbortError') throw err
      if (err?.name === 'AbortError' || /abort/i.test(String(err?.message))) {
        lastErr = new PollinationsError('TIMEOUT', `Generate melebihi ${Math.round(timeoutMs / 1000)} detik. Coba dimensi lebih kecil.`)
        if (attempt === RETRY_MAX) throw lastErr
        continue
      }
      lastErr = err
      if (!(err instanceof PollinationsError) || !err.retryable || attempt === RETRY_MAX) throw err
      await sleep(jitter(2000 * 2 ** (attempt - 1)))
    }
  }
  throw lastErr || new PollinationsError('FAILED', 'Gagal generate gambar.')
}

export const _internal = {
  HOST,
  UA,
  MAX_DIM,
  MAX_PIXELS,
  T_GEN,
  T_PER_MEGAPIXEL,
  timeoutFor,
  resolveDims,
  isJpeg,
  extractMetadata,
  classify,
}
