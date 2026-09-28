/**
 * Name : Facebook video/photo scraper
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://www.facebook.com
 * Type : Scraper
 * Function : ambil video HD/SD + foto + caption langsung dari halaman publik Facebook
 * Note : TANPA login/captcha; konten privat/text-only ditolak explisit; _fbp cookie dibuat dinamis per-request
 */

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'

function fbCookie() {
  // _fbp analitik generik FB (fb.1.<ms>.<rand>) — dibuat per-request supaya
  // tidak memakai sidik statis yang sama untuk semua panggilan.
  return `wd=1920x1080; _fbp=fb.1.${Date.now()}.${Math.floor(Math.random() * 1e10)}`
}

/**
 * Ambil media dari URL/kode-share Facebook.
 * @param {string} input link facebook.com / fb.watch / fb.com / kode share
 */
export async function fbdl(input) {
  const UA = DEFAULT_UA

  const pageHeaders = {
    'user-agent': UA,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.0.1',
    'accept-language': 'en-US,en;q=0.9',
    'upgrade-insecure-requests': '1',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'cookie': fbCookie(),
  }

  async function retryFetch(fn, times = 3, delay = 1500) {
    for (let i = 0; i < times; i++) {
      const result = await fn()
      if (result) return result
      if (i < times - 1) await new Promise(r => setTimeout(r, delay))
    }
    return null
  }

  const found = typeof input === 'string' ? input.match(/https?:\/\/(?:www\.|m\.|web\.|lm\.)?(?:facebook\.com|fb\.watch|fb\.com|fb\.me)\/[^\s"'<>]+/) : null
  const trimmed = typeof input === 'string' ? input.trim() : ''
  const url = found ? found[0]
    : (/^https?:\/\/\S+$/.test(trimmed) ? trimmed
    : (/^[A-Za-z0-9]{8,20}$/.test(trimmed) ? 'https://www.facebook.com/share/p/' + trimmed + '/' : ''))
  if (!url) throw new Error('No Facebook URL or share code found')

  const page = await retryFetch(async () => {
    try {
      const res = await fetch(url, { headers: pageHeaders, redirect: 'follow', signal: AbortSignal.timeout(15000) })
      if (!res.ok) return null
      const html = await res.text()
      if (!html.includes('<title>')) return null
      return { html, permalink: res.url }
    } catch (_) {
      return null
    }
  })

  if (!page) throw new Error('All Facebook sources failed for: ' + url)

  const grabJsonString = (key) => {
    const m = page.html.match(new RegExp('"' + key + '":"((?:[^"\\\\]|\\\\.)*)"'))
    if (!m) return null
    try { return JSON.parse('"' + m[1] + '"') } catch (_) { return null }
  }

  const grabMeta = (prop) => {
    const m = page.html.match(new RegExp('<meta[^>]+(?:property|name)="' + prop + '"[^>]+content="([^"]*)"'))
    return m ? m[1] : null
  }

  const decode = (s) => s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')

  const hd = grabJsonString('browser_native_hd_url')
  const sd = grabJsonString('browser_native_sd_url')

  const title = decode((grabMeta('og:title') || page.html.match(/<title>([^<]*)/)?.[1] || '-')).trim().replace(/\s*\|\s*Facebook\s*$/, '') || '-'
  const description = decode(grabMeta('og:description') || '').trim()
  const poster = decode(grabMeta('og:image') || '')

  const video = []
  if (hd) video.push({ quality: 'HD', url: hd, width: 0, height: 0 })
  if (sd) video.push({ quality: 'SD', url: sd, width: 0, height: 0 })

  const isPhoto = !video.length && !!poster
    && (page.html.includes('"__typename":"Photo"') || page.html.includes('"photo_id"'))
  if (!video.length && !isPhoto) throw new Error('No media found (private, text-only, or not a post): ' + url)

  const groupMatch = page.permalink.match(/facebook\.com\/groups\/([^/?#]+)/)
  const nameMatch = (page.permalink.match(/facebook\.com\/([^/]+)\/(?:videos|reel|watch|photo)/)
    || page.permalink.match(/facebook\.com\/([^/?#]+)/))
  const rawName = groupMatch ? '' : (nameMatch?.[1] || '')
  const username = groupMatch ? 'group:' + decodeURIComponent(groupMatch[1])
    : (rawName && !['watch', 'share', 'reel', 'photo.php', 'video.php', 'permalink', 'groups'].includes(rawName)
      ? decodeURIComponent(rawName) : '-')
  const userUrl = groupMatch ? 'https://www.facebook.com/groups/' + groupMatch[1]
    : (username !== '-' ? 'https://www.facebook.com/' + username : '')

  return {
    displayUri: poster,
    user: {
      username,
      fullname: title.includes(' | ') ? title.split(' | ').pop() : title,
      url: userUrl,
    },
    post: {
      caption: description || title,
      title,
      likeCount: '-',
      commentCount: '-',
      permalink: page.permalink,
    },
    previewComment: [],
    type: video.length ? 'video' : 'image',
    image: poster ? [{ url: poster }] : [],
    video,
    audioOnly: [],
  }
}

export default { fbdl }
