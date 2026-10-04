/**
 * Name : Starlabs AM Preset Finder scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://starlabs.biz.id/ampresetfind
 * Type : Scraper
 * Function : cari link preset Alight Motion di komentar video TikTok — info video + user + daftar preset (label + url)
 * Note : TANPA key/login/captcha — GET JSON ke bintangapi.my.id; halaman situs ter-obfuscate + guard anti-VM tapi endpoint publik; sukses: {success:true,data:{video,user,preset,thumbnail,total_comments_scanned}}; gagal: {success:false,error}
 */

const API = 'https://bintangapi.my.id/api/amfind/?url='
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const REFERER = 'https://starlabs.biz.id/ampresetfind/'

const TIMEOUT_MS = 110_000
const MAX_RETRIES = 2

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Cari preset AM dari URL video TikTok.
 * @param {string} tiktokUrl URL video TikTok (vt.tiktok.com / www.tiktok.com / vm.tiktok.com)
 * @returns {Promise<{ok:true, video, user, preset, thumbnail, totalComments} | {ok:false, error:string}>}
 */
export async function amPresetFind(tiktokUrl) {
  const u = String(tiktokUrl || '').trim()
  if (!/^https?:\/\//i.test(u)) {
    return { ok: false, error: 'Link harus diawali http:// atau https://' }
  }
  if (!/tiktok\.com\//i.test(u)) {
    return { ok: false, error: 'Link harus dari TikTok.' }
  }

  let lastError = 'Gagal menghubungi server.'
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(API + encodeURIComponent(u), {
        headers: { 'User-Agent': UA, Accept: 'application/json', Referer: REFERER },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const json = await res.json().catch(() => null)
      if (!json || typeof json !== 'object') {
        lastError = `Server balas bukan JSON (HTTP ${res.status}).`
        continue
      }
      if (json.success === true && json.data) {
        const d = json.data
        return {
          ok: true,
          video: d.video || {},
          user: d.user || {},
          preset: d.preset || null,
          thumbnail: d.thumbnail || null,
          totalComments: d.total_comments_scanned ?? null,
        }
      }
      // success:false = jawaban final server (upstream error / tidak ada data) — jangan retry buta
      return { ok: false, error: String(json.error || json.message || 'Data tidak ditemukan.').slice(0, 200) }
    } catch (e) {
      lastError = /abort|timeout/i.test(e?.message || '')
        ? 'Server timeout (>110 dtk). Coba lagi.'
        : `Gagal terhubung: ${String(e?.message || e).slice(0, 120)}`
      if (attempt < MAX_RETRIES) await sleep(2000 * attempt)
    }
  }
  return { ok: false, error: lastError }
}

export default { amPresetFind }