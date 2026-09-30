#!/usr/bin/env node
/**
 * Name : VinzCloud AM Premium Activation CLI
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://vinzcloud.vercel.app
 * Type : Scraper / CLI
 * Function : Send magic link, verify, tempmail, stats, full auto
 * Note : Tidak butuh API key. Cukup tiru Origin + Referer.
 *
 * Usage:
 *   node vinzAm.js stats
 *   node vinzAm.js status
 *   node vinzAm.js send <email>
 *   node vinzAm.js verify <email> <magicLink>
 *   node vinzAm.js tempmail [domain]
 *   node vinzAm.js inbox <email>
 *   node vinzAm.js auto [domain]
 */

const BASE = 'https://vinzcloud.vercel.app';

const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  Origin: BASE,
  Referer: BASE + '/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

async function req(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: { ...HEADERS, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const api = {
  stats: () => req('/api/stats'),
  status: () => req('/api/status'),
  send: (email) =>
    req('/api/send-link', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  verify: (email, magicLink) =>
    req('/api/verify-link', {
      method: 'POST',
      body: JSON.stringify({ email, magicLink }),
    }),
  tempmail: (domain = 'catchmail.io') =>
    req(`/api/tempmail/generate?domain=${encodeURIComponent(domain)}`),
  inbox: (email) =>
    req(`/api/tempmail/inbox?email=${encodeURIComponent(email)}`),
  message: (id, email) =>
    req(
      `/api/tempmail/message?id=${encodeURIComponent(id)}&email=${encodeURIComponent(email)}`
    ),
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fullAuto(domain = 'catchmail.io') {
  console.log('[*] Generate temp mail...');
  const mail = await api.tempmail(domain);
  if (!mail.success || !mail.email) throw new Error('Gagal generate temp mail');
  const email = mail.email;
  console.log('[+] Email:', email);

  console.log('[*] Kirim magic link...');
  const sendRes = await api.send(email);
  console.log('[+] Send:', sendRes.message || sendRes);

  console.log('[*] Polling inbox (max 20x, interval 6s)...');
  let magicLink = null;

  for (let i = 1; i <= 20; i++) {
    await sleep(6000);
    process.stdout.write(`\r[+] Poll ${i}/20`);
    const inbox = await api.inbox(email);

    if (inbox?.messages?.length) {
      for (const msg of inbox.messages) {
        try {
          const detail = await api.message(msg.id, email);
          const body = JSON.stringify(detail);

          // Cari link prioritas (alight / firebase / oobCode)
          const preferred = body.match(
            /https?:\/\/[^\s"'<>\\]+(?:alight-creative\.firebaseapp\.com|oobCode|__)/i
          );
          if (preferred) {
            magicLink = preferred[0];
            break;
          }

          // Fallback: ambil link apapun
          const anyLink = body.match(/https?:\/\/[^\s"'<>\\]+/g);
          if (anyLink && anyLink.length) {
            magicLink = anyLink[0];
            break;
          }
        } catch {}
      }
      if (magicLink) break;
    }
  }
  console.log('');

  if (!magicLink) throw new Error('Magic link tidak ditemukan');

  console.log('[+] Magic Link:', magicLink);
  console.log('[*] Verifying...');
  const result = await api.verify(email, magicLink);

  return { email, magicLink, result };
}

// ─── CLI ───────────────────────────────────────────────
const [, , cmd, ...args] = process.argv;

async function main() {
  try {
    switch (cmd) {
      case 'stats':
        console.log(JSON.stringify(await api.stats(), null, 2));
        break;

      case 'status':
        console.log(JSON.stringify(await api.status(), null, 2));
        break;

      case 'send': {
        const email = args[0];
        if (!email) throw new Error('Usage: node vinzAm.js send <email>');
        console.log(JSON.stringify(await api.send(email), null, 2));
        break;
      }

      case 'verify': {
        const [email, magicLink] = args;
        if (!email || !magicLink)
          throw new Error('Usage: node vinzAm.js verify <email> <magicLink>');
        console.log(JSON.stringify(await api.verify(email, magicLink), null, 2));
        break;
      }

      case 'tempmail': {
        const domain = args[0] || 'catchmail.io';
        console.log(JSON.stringify(await api.tempmail(domain), null, 2));
        break;
      }

      case 'inbox': {
        const email = args[0];
        if (!email) throw new Error('Usage: node vinzAm.js inbox <email>');
        console.log(JSON.stringify(await api.inbox(email), null, 2));
        break;
      }

      case 'auto': {
        const domain = args[0] || 'catchmail.io';
        const result = await fullAuto(domain);
        console.log('\n========== HASIL ==========');
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      default:
        console.log(`
VinzCloud CLI — AM Premium Activation

Usage:
  node vinzAm.js stats
  node vinzAm.js status
  node vinzAm.js send <email>
  node vinzAm.js verify <email> <magicLink>
  node vinzAm.js tempmail [domain]
  node vinzAm.js inbox <email>
  node vinzAm.js auto [domain]

Contoh:
  node vinzAm.js send user@gmail.com
  node vinzAm.js verify user@gmail.com "https://..."
  node vinzAm.js auto catchmail.io
`);
        process.exit(cmd ? 1 : 0);
    }
  } catch (err) {
    console.error('[ERROR]', err.message);
    if (err.data) console.error(JSON.stringify(err.data, null, 2));
    process.exit(1);
  }
}

main();

