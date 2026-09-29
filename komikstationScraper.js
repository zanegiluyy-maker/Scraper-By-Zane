/**
 * Name : KomikStation manhwa scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://komikstation.org
 * Type : Scraper
 * Function : search manhwa + daftar chapter + unduh ZIP per chapter
 * Note : TANPA key/captcha (WP REST publik + halaman HTML); file download = ZIP gambar (situs tidak sediakan PDF)
 */

const BASE = 'https://komikstation.org'
const DDL = 'https://klikcdn.com/ddl'
const TIMEOUT_MS = 25_000
const MAX_ZIP_BYTES = 100 * 1024 * 1024

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
]

const baseHeaders = (i, json) => ({
  'User-Agent': UAS[i % UAS.length],
  Accept: json ? 'application/json' : 'text/html,*/*;q=0.8',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  Referer: `${BASE}/`,
  ...(json ? { 'Content-Type': 'application/json' } : {}),
})

// GET/POST dgn 1x retry utk network-error/5xx/403/429.
async function req(url, { method = 'GET', body, timeoutMs = TIMEOUT_MS, ua = 0 } = {}) {
  let lastErr = null
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        headers: baseHeaders(ua + i, !!body),
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      if (res.ok) return res
      if (![403, 429].includes(res.status) && res.status < 500) return res
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 800))
  }
  throw lastErr
}

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const decodeEntities = (s) => String(s || '')
  .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d) } catch { return '' } })
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return '' } })
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")

const metaOf = (html, prop) => {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, 'i'))
  return m ? decodeEntities(m[1]) : ''
}

/**
 * Cari manhwa via WP REST publik.
 * @param {string} query
 * @param {number} [limit=5]
 * @returns {Promise<Array<{id: number, title: string, url: string}>>}
 */
export async function searchManhwa(query, limit = 5) {
  const q = String(query || '').trim()
  if (!q) throw new Error('Kata kunci kosong.')
  const res = await req(`${BASE}/wp-json/wp/v2/search?search=${encodeURIComponent(q)}&per_page=${Math.min(Math.max(limit, 1), 20)}`)
  if (!res.ok) throw new Error(`Pencarian gagal (HTTP ${res.status}).`)
  const list = await res.json().catch(() => null)
  if (!Array.isArray(list)) throw new Error('Respons pencarian bukan daftar.')
  return list
    .filter((it) => it?.url?.includes('/manga/'))
    .map((it) => ({ id: it.id, title: decodeEntities(stripTags(it.title)), url: it.url }))
}

/**
 * Detail manga + daftar chapter (terbaru dulu, seperti situs).
 * @param {string} mangaUrl link /manga/<slug>/
 */
export async function getMangaDetail(mangaUrl) {
  if (!/^https?:\/\/(www\.)?komikstation\.org\/manga\/[^/]+\/?/i.test(String(mangaUrl || ''))) {
    throw new Error('Bukan link manga KomikStation.')
  }
  const res = await req(mangaUrl)
  if (!res.ok) throw new Error(`Halaman manga gagal (HTTP ${res.status}).`)
  const html = await res.text()

  const listHtml = html.split('id="chapterlist"')[1]?.split('</ul>')[0] || ''
  const chapters = []
  const liRe = /<li[^>]*data-num="(\d+)"[^>]*>(.*?)<\/li>/gis
  let m
  while ((m = liRe.exec(listHtml)) !== null) {
    const block = m[2]
    const read = block.match(/<a[^>]+href="([^"]+)"[^>]*>\s*<span class="chapternum">([^<]*)<\/span>/) || block.match(/<a[^>]+href="([^"]+)"/)
    const date = (block.match(/<span class="chapterdate">([^<]*)<\/span>/) || [])[1] || ''
    const ddl = (block.match(/<a[^>]+href="(https:\/\/klikcdn\.com\/ddl\?id=\d+)"[^>]*class="dload"/) || [])[1] || null
    if (!read) continue
    chapters.push({
      num: parseInt(m[1], 10),
      title: decodeEntities(stripTags(block.match(/<span class="chapternum">([^<]*)<\/span>/)?.[1] || `Chapter ${m[1]}`)),
      date: date.trim(),
      readUrl: read[1],
      downloadUrl: ddl,
    })
  }
  if (!chapters.length) throw new Error('Daftar chapter tidak ditemukan.')

  return {
    title: (metaOf(html, 'og:title').replace(/\s*[-|]\s*KomikStation\s*$/i, '') || '').trim(),
    cover: metaOf(html, 'og:image') || null,
    synopsis: metaOf(html, 'og:description').slice(0, 500) || null,
    pageUrl: mangaUrl,
    chapterCount: chapters.length,
    latestChapter: chapters[0]?.title || null,
    chapters,
  }
}

/**
 * Unduh ZIP 1 chapter via klikcdn (nonce → init → token → file).
 * @param {string} ddlUrl link https://klikcdn.com/ddl?id=NNN (dari getMangaDetail)
 * @param {object} [opts] {maxBytes, timeoutMs, onProgress}
 * @returns {Promise<{filename: string, size: number, buffer: Buffer}>}
 */
export async function downloadChapter(ddlUrl, { maxBytes = MAX_ZIP_BYTES, timeoutMs = 120_000, onProgress } = {}) {
  const idMatch = String(ddlUrl || '').match(/[?&]id=(\d+)/)
  if (!idMatch) throw new Error('Link download tidak valid (butuh klikcdn ddl?id=).')
  const id = idMatch[1]
  const ref = `${DDL}/?id=${id}`

  // 1) nonce fresh dari halaman download.
  const page = await req(ref)
  if (!page.ok) throw new Error(`Halaman download gagal (HTTP ${page.status}).`)
  const nonce = (await page.text()).match(/const nonce = "([a-f0-9]+)"/)?.[1]
  if (!nonce) throw new Error('Nonce download tidak ditemukan (struktur berubah?).')

  // 2) init → token download. Server kadang generate file dulu (busy) —
  // frontend-nya polling init tiap 5 detik (maks 12x); kita tiru persis.
  let dlUrl = null
  for (let attempt = 0; attempt < 12; attempt++) {
    const init = await req(`${DDL}/index.php?api=file/reupload/init`, {
      method: 'POST',
      body: { post_id: Number(id), nonce },
      timeoutMs: 30_000,
    })
    const initJson = await init.json().catch(() => null)
    if (!init.ok || !initJson?.success) {
      throw new Error(initJson?.message || `Init download gagal (HTTP ${init.status}).`)
    }
    if (initJson.data?.live && initJson.data?.download_url) {
      dlUrl = initJson.data.download_url
      break
    }
    if (!initJson.data?.busy) {
      throw new Error(initJson.data?.message || initJson.message || 'Server tidak mengembalikan link file.')
    }
    if (typeof onProgress === 'function') {
      try { onProgress(0, null) } catch { /* abaikan */ }
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  if (!dlUrl) throw new Error('Server masih generate file (sibuk) — coba lagi 1 menit.')

  // 3) unduh file (stream + cap + progress).
  const res = await fetch(dlUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': UAS[0], Referer: `${ref}/` },
  })
  if (!res.ok) throw new Error(`Unduhan gagal (HTTP ${res.status}).`)
  const total = Number(res.headers.get('content-length') || 0)
  if (total > maxBytes) throw new Error(`File kebesaran (${(total / 1048576).toFixed(0)}MB).`)
  const chunks = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.length
    if (size > maxBytes) throw new Error('File melebihi batas.')
    chunks.push(chunk)
    if (typeof onProgress === 'function') {
      try { onProgress(size, total || null) } catch { /* callback user, jangan crash */ }
    }
  }
  const buffer = Buffer.concat(chunks)
  if (!buffer.length) throw new Error('File kosong.')
  if (!buffer.subarray(0, 2).equals(Buffer.from('PK'))) {
    throw new Error('Bukan file ZIP valid (format berubah?).')
  }
  const cd = res.headers.get('content-disposition') || ''
  const filename = decodeURIComponent(cd.match(/filename="?([^";]+)"?/)?.[1] || `chapter-${id}.zip`)
  return { filename, size, buffer }
}
