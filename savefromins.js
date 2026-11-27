#!/usr/bin/env node
/**
 * Name : SaveFromIns Scraper (savefromins.com)
 * Owner : Zane
 * SL : https://whatsapp.com/channel/0029VbBe2Xt1t90gnNzfxc1F
 * Base Web : https://savefromins.com
 * Type : Scraper
 * Function : node savefromins.js "<link ig>" -> JSON metadata + semua download URL
 *            (video/image, multi-quality). Flag: --probe, --task, --full,
 *            --no-cache, --debug, --help.
 * Note : error fix sendiri.
 *        Zero dependency npm — Node built-in + curl.
 *        Bypass / anti-bot:
 *          1) API savefromins (api.savefromins.com) body terenkripsi:
 *             auth=<meta>&svs=<svs>&request=<encrypted> — request hanya bisa
 *             dibuat SDK resmi. Solusi: jalankan SDK resmi via vm.runInContext
 *             dengan mock DOM (meta downloader-sdk-auth) + fetch asli.
 *          2) SDK URL + auth rotate (hash di path, auth base64 di folder) —
 *             ambil dinamis dari homepage: <meta name="downloader-sdk-auth">
 *             + <link rel=preload href=.../sdk/js/sdk/...>. Fallback konstanta.
 *          3) Cache SDK di .cache/ (189KB) — kalau homepage gagal, pakai cache.
 *          4) Response SDK wajib Response asli (body.getReader() utk SSE
 *             /sse/downloader-api/download/progress) — mock body:null -> gagal.
 *          5) parseLink: {origin:'source', link} -> status:1 + data.media[].
 *             Error backend: status:0 + status_code (content_not_found,
 *             private_account, rate_limited, instagram_server_error, ...).
 *          6) download_url = CDN IG langsung (HEAD 200). resource_content ->
 *             createDownload({request:<token>}) -> {task_id|download_link} ->
 *             watchProgress({task_id}) event success/failed + download_link.
 *          7) Node TLS kadang diblok CF utk homepage/SDK -> HTTP via curl
 *             (browser UA); DoH fallback code 0 / status != 0.
 *          8) Error apapun -> stderr + exit 1; sukses -> JSON stdout exit 0.
 *        Output: JSON ke stdout saja.
 *        credit: Zane.
 *
 *        Usage:
 *          node savefromins.js "https://www.instagram.com/reel/XXXX/"
 *          node savefromins.js "<link>" --probe
 *          node savefromins.js "<link>" --task
 *          node savefromins.js --help
 *
 *        Flags:
 *          --probe      HEAD cek tiap download_url (alive/content-type)
 *          --task       resolve via createDownload+watchProgress (SSE)
 *          --full       sertakan resource_content + comment items
 *          --no-cache   paksa download ulang SDK
 *          --debug      log network/SDK ke stderr
 *          --help       contoh output JSON
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const BASE = "https://savefromins.com";
const DOH = "https://cloudflare-dns.com/dns-query";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
const AUTH_KNOWN = "f8a1c2d4";
const SDK_KNOWN = "https://web-res.savefromins.com/savefromins-com/sdk/js/sdk/ZjhhMWMyZDQ/20015-6627454ffc8e1009.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(HERE, ".cache");
const SDK_CACHE = path.join(CACHE_DIR, "savefromins_sdk.js");
const SDK_META = path.join(CACHE_DIR, "savefromins_sdk_meta.json");

const ERR_MSG = {
  unsupported_site: "situs tidak didukung",
  invalid_url: "url tidak valid",
  private_account: "akun privat",
  private_content: "konten privat",
  content_not_found: "konten tidak ditemukan / sudah dihapus",
  rate_limited: "rate limit - coba lagi nanti",
  access_blocked: "akses diblokir",
  instagram_server_error: "server instagram error",
  timeout: "timeout dari server",
  unknown: "error tidak diketahui",
  unsupported_live: "live tidak didukung",
  technical_error: "error teknis server",
};
const RETRYABLE = new Set(["rate_limited", "instagram_server_error", "timeout", "unknown", "technical_error"]);

let DEBUG = false;

function die(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}
function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function dlog(...a) {
  if (DEBUG) process.stderr.write(a.join(" ") + "\n");
}
function withTimeout(p, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}
function friendlyErr(code, msg) {
  const base = ERR_MSG[code] || code || "error";
  const m = String(msg || "")
    .replace(/^parse error:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return m ? `${code}: ${base} (${m})` : `${code}: ${base}`;
}

/* ---------- HTTP via curl (Node TLS kadang diblok CF) ---------- */
function curlRaw(url, opts = {}) {
  const { timeout = 25, method = "GET", body, headers = {}, retries = 3 } = opts;
  const run = (useDoh) => {
    const args = ["-s", "-m", String(timeout), "--http1.1", "--compressed", "-L", "--max-redirs", "4",
      "-A", UA, "-w", "\n__CURL_CODE__%{http_code}"];
    if (useDoh) args.push("--doh-url", DOH);
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    if (method !== "GET") args.push("-X", method);
    if (body != null) {
      if (!headers["Content-Type"] && !headers["content-type"]) {
        args.push("-H", "Content-Type: text/plain;charset=UTF-8");
      }
      args.push("--data", body);
    }
    args.push(url);
    const r = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const raw = r.stdout || "";
    const m = raw.match(/\n__CURL_CODE__(\d{3})$/);
    return {
      code: m ? Number(m[1]) : 0,
      body: m ? raw.slice(0, m.index) : raw,
      status: r.status ?? 0,
      stderr: r.stderr || "",
    };
  };
  let r = run(false);
  if (r.code === 0 || r.status !== 0) r = run(true);
  if ((r.code === 0 || r.status !== 0) && retries > 1) {
    for (let i = 1; i < retries; i++) {
      const wait = 800 * i + Math.floor(Math.random() * 400);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      r = run(true);
      if (r.code !== 0 && r.status === 0) break;
    }
  }
  return r;
}

function curlMeta(url, { head = true, timeout = 15 } = {}) {
  const run = (useDoh) => {
    const marker = "\n__META__%{http_code}\t%{content_type}";
    const args = ["-s", "-m", String(timeout), "--http1.1", "-L", "--max-redirs", "4", "-A", UA, "-w", marker];
    if (head) {
      args.push("-I");
    } else {
      args.push("-r", "0-0", "--max-filesize", "1048576", "--max-time", "10", "-o", "/dev/null", "-D", "-");
    }
    if (useDoh) args.push("--doh-url", DOH);
    args.push(url);
    const r = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
    const raw = r.stdout || "";
    const idx = raw.lastIndexOf("__META__");
    if (idx < 0) return { code: 0, content_type: "", content_length: "" };
    const headPart = raw.slice(0, idx);
    const parts = raw.slice(idx + 8).trim().split("\t");
    // header block terakhir (setelah redirect) utk Content-Length / Content-Range
    const cl = [...headPart.matchAll(/content-length:\s*(\d+)/gi)];
    const cr = [...headPart.matchAll(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/gi)];
    // utk range GET (206) total asli ada di Content-Range, bukan Content-Length (=1)
    const total = cr.length ? cr[cr.length - 1][1] : cl.length ? cl[cl.length - 1][1] : "";
    return {
      code: Number(parts[0]) || 0,
      content_type: parts[1] || "",
      content_length: total,
    };
  };
  let r = run(false);
  if (r.code === 0) r = run(true);
  return r;
}

function curlProbe(url) {
  let m = curlMeta(url, { head: true });
  if (m.code === 0 || (m.code >= 400 && m.code <= 599)) {
    const g = curlMeta(url, { head: false });
    if (g.code !== 0) m = g;
  }
  const alive = m.code === 200 || m.code === 206;
  const bytes = Number(m.content_length) > 0 ? Number(m.content_length) : null;
  return { alive, http: m.code, content_type: m.content_type || null, bytes };
}

/* ---------- discover auth + SDK URL dari homepage ---------- */
function discover() {
  const r = curlRaw(BASE + "/", {
    timeout: 20,
    headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  });
  if (r.code !== 200 || !r.body) return null;
  const html = r.body;
  let auth = null;
  let m = html.match(/name=["']downloader-sdk-auth["']\s+content=["']([^"']+)["']/i)
    || html.match(/content=["']([^"']+)["']\s+name=["']downloader-sdk-auth["']/i);
  if (m) auth = m[1];
  let sdkUrl = null;
  m = html.match(/(?:https:)?\/\/web-res\.savefromins\.com\/[^"'\s]+\/sdk\/js\/sdk\/[^"'\s]+\.js/);
  if (m) sdkUrl = m[0].startsWith("//") ? "https:" + m[0] : m[0];
  if (!auth && !sdkUrl) return null;
  dlog(`[discover] auth=${auth || "?"} sdk=${sdkUrl || "?"}`);
  return { auth: auth || null, sdkUrl: sdkUrl || null };
}

function readSdkMeta() {
  try { return JSON.parse(fs.readFileSync(SDK_META, "utf8")); } catch { return null; }
}

function loadSdkSource(flags) {
  let auth = null;
  let sdkUrl = null;
  try {
    const d = discover();
    if (d) {
      auth = d.auth;
      sdkUrl = d.sdkUrl;
    }
  } catch (e) {
    dlog(`[discover gagal] ${e.message}`);
  }
  const meta = readSdkMeta();
  if (!auth) auth = meta?.auth || AUTH_KNOWN;
  if (!sdkUrl) sdkUrl = meta?.sdkUrl || SDK_KNOWN;
  let haveCache = false;
  try {
    haveCache = fs.existsSync(SDK_CACHE) && fs.statSync(SDK_CACHE).size > 50000;
  } catch { haveCache = false; }
  if (!flags["no-cache"] && haveCache && meta?.url === sdkUrl) {
    dlog(`[sdk] cache hit ${sdkUrl}`);
    return { src: fs.readFileSync(SDK_CACHE, "utf8"), auth, sdkUrl, cached: true };
  }
  const r = curlRaw(sdkUrl, { timeout: 30 });
  if (r.code === 200 && r.body && r.body.length > 50000) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(SDK_CACHE, r.body);
      fs.writeFileSync(SDK_META, JSON.stringify({ url: sdkUrl, auth, bytes: r.body.length, at: Date.now() }));
    } catch (e) {
      dlog(`[sdk] cache write gagal: ${e.message}`);
    }
    dlog(`[sdk] fresh download ${r.body.length} bytes`);
    return { src: r.body, auth, sdkUrl, cached: false };
  }
  dlog(`[sdk] download gagal HTTP ${r.code}`);
  if (haveCache) {
    dlog("[sdk] fallback cache lama");
    return { src: fs.readFileSync(SDK_CACHE, "utf8"), auth, sdkUrl, cached: true, stale: true };
  }
  die(`download SDK gagal (HTTP ${r.code})`);
}

/* ---------- vm sandbox: jalankan SDK resmi dgn mock DOM ---------- */
function makeSandbox(auth) {
  const realFetch = globalThis.fetch.bind(globalThis);
  const sandbox = {
    console: {
      log: (...a) => dlog("[sdk]", ...a),
      info: (...a) => dlog("[sdk:i]", ...a),
      warn: (...a) => dlog("[sdk:w]", ...a),
      error: (...a) => dlog("[sdk:e]", ...a),
      debug: () => {},
      trace: () => {},
    },
    performance: globalThis.performance,
    Date, Math, JSON, Promise, Object, Array, String, Number, Boolean, RegExp,
    Error, TypeError, RangeError, SyntaxError, EvalError, URIError, AggregateError,
    Function, Symbol, Map, Set, WeakMap, WeakSet, Proxy, Reflect,
    ArrayBuffer, DataView, Int8Array, Uint8Array, Uint8ClampedArray,
    Int16Array, Uint16Array, Int32Array, Uint32Array,
    Float32Array, Float64Array, BigInt64Array, BigUint64Array, BigInt,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    parseInt, parseFloat, isNaN, isFinite, NaN, Infinity, undefined,
    setTimeout, clearTimeout, setInterval, clearInterval,
    queueMicrotask, setImmediate, clearImmediate,
    structuredClone: globalThis.structuredClone,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    AbortController, AbortSignal, Blob, File, FormData, Request, Headers, Response,
    ReadableStream, WritableStream, TransformStream,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    crypto: globalThis.crypto,
    // fetch asli: Response.body.getReader() wajib utk SSE progress
    fetch: async (input, init = {}) => {
      const u = input && typeof input === "object" ? input : String(input);
      const href = u && typeof u === "object" ? u.url : u;
      const method = init.method || (u && u.method) || "GET";
      dlog("[net]", method, href);
      try {
        const resp = await realFetch(u, init);
        dlog("[net ->", resp.status + "]", href);
        return resp;
      } catch (e) {
        dlog("[net err]", href, e.message);
        throw e;
      }
    },
    XMLHttpRequest: class {
      constructor() {
        this._h = {};
        this.readyState = 0;
        this.status = 0;
        this.responseText = "";
        this.response = "";
        this.responseType = "";
      }
      open(m, u) { this.method = m; this.url = u; }
      setRequestHeader(k, v) { this._h[k] = v; }
      getAllResponseHeaders() {
        const lines = Object.entries(this._h).map(([k, v]) => `${k}: ${v}\r\n`);
        return lines.join("") + "content-type: application/json\r\n";
      }
      getResponseHeader(k) { return String(k).toLowerCase() === "content-type" ? "application/json" : null; }
      async send(body) {
        try {
          const r = await sandbox.fetch(this.url, {
            method: this.method || "GET",
            body,
            headers: { "content-type": "application/x-www-form-urlencoded", ...this._h },
          });
          this.status = r.status;
          this.readyState = 4;
          this.responseText = await r.text();
          this.response = this.responseText;
          if (this.onreadystatechange) this.onreadystatechange();
          if (this.onload) this.onload();
        } catch (e) {
          if (this.onerror) this.onerror(e);
        }
      }
      abort() {}
      addEventListener(t, fn) { this["on" + t] = fn; }
      removeEventListener() {}
    },
    navigator: {
      locks: { request: async (name, cb) => (typeof cb === "function" ? cb({ name, mode: "granted" }) : undefined) },
      userAgent: UA,
      language: "en", languages: ["en", "en-US"], platform: "Linux x86_64",
      hardwareConcurrency: 8, maxTouchPoints: 0, webdriver: false,
      clipboard: { writeText: async () => {}, readText: async () => "" },
      permissions: { query: async () => ({ state: "granted" }) },
      sendBeacon: () => true,
    },
    location: {
      href: BASE + "/", origin: BASE, protocol: "https:",
      host: "savefromins.com", hostname: "savefromins.com", port: "", pathname: "/", search: "", hash: "",
      assign() {}, replace() {}, reload() {}, toString() { return BASE + "/"; },
      isSecureContext: true,
    },
    document: {
      querySelector(sel) {
        if (String(sel).includes("downloader-sdk-auth")) {
          return { content: auth, getAttribute: (n) => (String(n) === "content" ? auth : null) };
        }
        return null;
      },
      querySelectorAll() { return []; },
      getElementById() { return null; },
      getElementsByTagName() { return []; },
      getElementsByClassName() { return []; },
      createElement(tag) {
        return {
          tagName: String(tag).toUpperCase(), nodeType: 1, style: {}, attrs: {}, children: [], childNodes: [],
          href: "", target: "", rel: "", download: "", textContent: "", innerHTML: "", type: "", value: "", name: "",
          setAttribute(k, v) { this.attrs[k] = v; if (k === "href") this.href = v; },
          getAttribute(k) { return this.attrs[k] ?? null; },
          appendChild(c) { this.children.push(c); return c; },
          removeChild(c) { return c; }, remove() {}, insertBefore(c) { return c; }, contains() { return false; },
          click() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
          focus() {}, blur() {}, submit() {},
          querySelector() { return null; }, querySelectorAll() { return []; },
          cloneNode() { return this; },
          getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; },
          parentNode: null, parentElement: null, firstChild: null, lastChild: null, nextSibling: null, previousSibling: null,
          ownerDocument: null, namespaceURI: "http://www.w3.org/1999/xhtml", localName: null, prefix: null,
        };
      },
      createTextNode(t) { return { nodeType: 3, textContent: t, data: t }; },
      createDocumentFragment() { return { nodeType: 11, appendChild() {}, children: [] }; },
      createComment() { return { nodeType: 8 }; },
      body: { appendChild() {}, removeChild() {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, getAttribute() { return null; }, scrollTop: 0, clientWidth: 1920, clientHeight: 1080 },
      head: { appendChild() {}, removeChild() {}, setAttribute() {}, getAttribute() { return null; } },
      documentElement: { style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, getAttribute() { return null; }, clientWidth: 1920, clientHeight: 1080, scrollWidth: 1920, scrollHeight: 1080 },
      cookie: "", title: "Instagram Downloader", referrer: "", domain: "savefromins.com",
      readyState: "complete", visibilityState: "visible", hidden: false,
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      location: { href: BASE + "/", origin: BASE, search: "", pathname: "/", hash: "" },
      implementation: { createHTMLDocument: () => sandbox.document, hasFeature: () => true },
      currentScript: null, scripts: [], styleSheets: [],
      documentURI: BASE + "/", URL: BASE + "/",
      createElementNS(ns, tag) { return this.createElement(tag); },
      elementFromPoint() { return null; },
      defaultView: null,
    },
    localStorage: { _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }, clear() { this._d = {}; }, key(i) { return Object.keys(this._d)[i] ?? null; }, get length() { return Object.keys(this._d).length; } },
    sessionStorage: { _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }, clear() { this._d = {}; }, key(i) { return Object.keys(this._d)[i] ?? null; }, get length() { return Object.keys(this._d).length; } },
    history: { length: 1, state: null, pushState() {}, replaceState() {}, go() {}, back() {}, forward() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
    cancelAnimationFrame: clearTimeout,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, postMessage() {},
    open() { return null; }, close() {}, alert() {}, confirm() { return true; }, prompt() { return null; },
    scrollTo() {}, focus() {}, blur() {}, print() {},
    isSecureContext: true, origin: BASE,
    innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1,
    process: {
      env: { NODE_ENV: "production" }, version: "v20.11.0", versions: { node: "20.11.0" },
      argv: ["node", "sdk.js"], platform: "linux", arch: "x64",
      nextTick: process.nextTick.bind(process), cwd: () => HERE, exit() {}, on() {}, off() {}, once() {}, emit() {},
      hrtime: process.hrtime.bind(process), memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
      pid: 1, stderr: { write: () => true }, stdout: { write: () => true },
    },
    Buffer,
    require: (m) => { throw new Error("require:" + m); },
    module: { exports: {} }, exports: {},
    __dirname: HERE, __filename: path.join(HERE, "sdk.js"),
    Event: class { constructor(t) { this.type = t; } preventDefault() {} stopPropagation() {} },
    CustomEvent: class { constructor(t, i = {}) { this.type = t; this.detail = i.detail; } },
    MessageEvent: class { constructor(t, i = {}) { this.type = t; this.data = i.data; } },
    Notification: { permission: "default", requestPermission: async () => "default", close() {} },
    EventSource: undefined, WebSocket: undefined,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  sandbox.frames = sandbox;
  sandbox.document.defaultView = sandbox;
  Object.defineProperty(sandbox, "DownloaderSDKs", {
    configurable: true,
    get() { return sandbox._d; },
    set(v) { sandbox._d = v; dlog("[reg]", v && typeof v === "object" ? Object.keys(v) : v); },
  });
  return sandbox;
}

async function loadInstance(src, auth) {
  const sandbox = makeSandbox(auth);
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: "savefromins_sdk.js", timeout: 20000 });
  let entry = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const reg = sandbox.DownloaderSDKs;
    if (reg && typeof reg === "object") {
      entry = reg[auth] || Object.values(reg).find((v) => v && typeof v.create === "function") || null;
      if (entry && typeof entry.create === "function") break;
      entry = null;
    }
    await sleep(50);
  }
  if (!entry) die("SDK tidak mendaftar DownloaderSDKs — hapus .cache/savefromins_sdk.js lalu ulangi");
  dlog("[entry] svs=", entry.svs);
  const inst = await entry.create({ commParams: { domain: "savefromins.com" } });
  for (const m of ["parseLink", "createDownload", "watchProgress", "cancelDownload"]) {
    if (typeof inst?.[m] !== "function") die("SDK incomplete: " + m);
  }
  dlog("[inst] ok");
  return inst;
}

/* ---------- API wrappers ---------- */
async function parseLinkRetry(inst, url) {
  let lastErr = "unknown";
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res = null;
    try {
      res = await withTimeout(inst.parseLink({ origin: "source", link: url }), 60000, "parseLink");
    } catch (e) {
      if (e && (e.status_code || e.status === 0)) {
        res = { status: 0, status_code: e.status_code || "unknown", msg: e.message };
      } else {
        lastErr = `network: ${e?.message || e}`;
        dlog(`[parseLink attempt ${attempt}] ${lastErr}`);
        if (attempt < 3) { await sleep(1200 * attempt); continue; }
        die(lastErr);
      }
    }
    if (res && res.status === 1) {
      if (res.data) return res;
      die("response sukses tanpa data");
    }
    const code = res?.status_code || "unknown";
    lastErr = friendlyErr(code, res?.msg);
    dlog(`[parseLink attempt ${attempt}] ${lastErr}`);
    if (!RETRYABLE.has(code)) die(lastErr);
    if (attempt < 3) await sleep(1800 * attempt);
  }
  die(lastErr);
}

async function runTask(inst, data) {
  const media = Array.isArray(data?.media) ? data.media : [];
  let pick = null;
  outer: for (const m of media) {
    for (const r of Array.isArray(m.resources) ? m.resources : []) {
      if (r?.resource_content) { pick = { m, r }; break outer; }
    }
  }
  if (!pick) die("--task: tidak ada resource_content di response");
  const label = { type: pick.m.type || null, format: pick.r.format || null, quality: pick.r.quality || null };
  let dl;
  try {
    dl = await withTimeout(inst.createDownload({ request: pick.r.resource_content }), 30000, "createDownload");
  } catch (e) {
    die(`createDownload: ${e.message}`);
  }
  if (!dl || dl.status !== 1) die(`createDownload: ${dl?.status_code || dl?.msg || "gagal"}`);
  const d = dl.data || {};
  if (d.download_link && !d.task_id) return { ...label, task_id: null, download_link: d.download_link };
  if (!d.task_id) die("createDownload: task_id kosong");
  const task_id = d.task_id;
  let ev;
  try {
    ev = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("watchProgress timeout 45s")), 45000);
      inst.watchProgress({ task_id }, (e) => {
        if (e && (e.status === "success" || e.status === "failed")) {
          clearTimeout(timer);
          resolve(e);
        }
      }, {})
        .then((n) => {
          clearTimeout(timer);
          resolve({ status: "ended", ...(n && n.status !== 1 ? { msg: n.msg || n.status_code } : {}) });
        })
        .catch((err) => { clearTimeout(timer); reject(err); });
    });
  } catch (e) {
    die(`watchProgress: ${e.message}`);
  }
  if (ev.status === "ended") die(`watchProgress: stream selesai tanpa hasil${ev.msg ? " - " + ev.msg : ""}`);
  if (ev.status !== "success" || !ev.download_link) die(`task gagal: ${ev.status}`);
  return { ...label, task_id, download_link: ev.download_link, status: ev.status };
}

/* ---------- mapping ---------- */
function mapResult(res, url, flags) {
  const d = res.data || {};
  const mediaIn = Array.isArray(d.media) ? d.media : [];
  if (!mediaIn.length) die("tidak ada media dalam response");
  const media = mediaIn.map((m) => ({
    media_id: m.media_id ?? null,
    type: m.type ?? null,
    title: m.title ?? null,
    thumbnail: m.thumbnail ?? d.thumbnail ?? null,
    duration: typeof m.duration === "number" ? m.duration : null,
    resources: (Array.isArray(m.resources) ? m.resources : []).map((r) => {
      const o = {
        format: r.format ?? null,
        quality: r.quality ?? null,
        type: r.type ?? null,
        download_mode: r.download_mode ?? null,
        download_url: r.download_url ?? null,
        preview_url: r.preview_url ?? null,
        size: typeof r.size === "number" ? r.size : null,
      };
      if (flags.full && r.resource_content) o.resource_content = r.resource_content;
      return o;
    }),
  }));
  const totalRes = media.reduce((n, m) => n + m.resources.length, 0);
  const withUrl = media.reduce((n, m) => n + m.resources.filter((r) => r.download_url).length, 0);
  if (!withUrl) die("tidak ada download_url dalam response");
  const result = {
    ok: 1,
    credit: "Zane",
    site: "savefromins.com",
    url,
    id: d.id ?? null,
    title: d.title ?? null,
    thumbnail: d.thumbnail ?? null,
    duration: typeof d.duration === "number" ? d.duration : null,
    like_count: typeof d.like_count === "number" ? d.like_count : null,
    comment_count: typeof d.comment_count === "number" ? d.comment_count : null,
    publish_ts: typeof d.publish_ts === "number" ? d.publish_ts : null,
    user: d.user_item ?? null,
    media,
    total_media: media.length,
    total_resources: totalRes,
    download_urls: withUrl,
  };
  if (flags.full && d.comment_items && Array.isArray(d.comment_items.items)) {
    result.comments = d.comment_items.items.slice(0, 20).map((c) => ({
      username: c.username ?? null,
      text: c.text ?? null,
    }));
  }
  return result;
}

async function probeAll(result) {
  const seen = new Map();
  let checked = 0;
  let alive = 0;
  for (const m of result.media) {
    for (const r of m.resources) {
      if (!r.download_url) continue;
      let p = seen.get(r.download_url);
      if (!p) {
        p = curlProbe(r.download_url);
        seen.set(r.download_url, p);
        checked++;
        if (p.alive) alive++;
        dlog(`[probe ${checked}] http=${p.http} ${p.content_type || ""} ${r.download_url.slice(0, 80)}`);
        await sleep(200);
      }
      r.probe = p;
    }
  }
  result.probe = { checked, alive };
}

/* ---------- help ---------- */
function help() {
  out({
    ok: 1,
    credit: "Zane",
    usage: [
      'node savefromins.js "https://www.instagram.com/reel/XXXX/"',
      'node savefromins.js "<link>" --probe',
      'node savefromins.js "<link>" --task',
      "node savefromins.js --help",
    ],
    examples: [
      'node savefromins.js "https://www.instagram.com/reel/DScyVe6gmBe/"',
      'node savefromins.js "https://www.instagram.com/reel/DScyVe6gmBe/" --probe',
      'node savefromins.js "https://www.instagram.com/p/DXZx2eMDIPs/" --full',
    ],
    flags: {
      "--probe": "HEAD cek tiap download_url (alive/content-type/bytes)",
      "--task": "resolve link via createDownload + watchProgress (SSE)",
      "--full": "sertakan resource_content + comment items",
      "--no-cache": "paksa download ulang SDK",
      "--debug": "log network/SDK ke stderr",
    },
    notes: [
      "Output: JSON ke stdout; error ke stderr + exit 1.",
      "SDK resmi di-cache di .cache/savefromins_sdk.js (rediscover dari homepage).",
      "rate_limited / server error otomatis retry 3x backoff.",
    ],
  });
}

/* ---------- main ---------- */
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (const a of argv) {
  if (a.startsWith("--")) flags[a.slice(2)] = true;
  else pos.push(a);
}
DEBUG = !!flags.debug;

const run = async () => {
  if (flags.help || argv.length === 0) {
    help();
    return;
  }
  let url = pos.join(" ").trim();
  if (!url) {
    help();
    return;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = "https://" + url;
  try {
    new URL(url);
  } catch {
    die(`url tidak valid: ${url}`);
  }

  const sdk = loadSdkSource(flags);
  dlog(`[sdk] ${sdk.cached ? (sdk.stale ? "cache (stale)" : "cache") : "fresh"} auth=${sdk.auth}`);
  const inst = await loadInstance(sdk.src, sdk.auth);
  const res = await parseLinkRetry(inst, url);

  let task = null;
  if (flags.task) task = await runTask(inst, res.data);

  const result = mapResult(res, url, flags);
  if (task) result.task = task;

  if (flags.probe) {
    await probeAll(result);
    if (task?.download_link) {
      task.probe = curlProbe(task.download_link);
      dlog(`[probe task] http=${task.probe.http}`);
    }
  }

  const notes = [];
  if (!flags.probe) notes.push("download_url belum di-probe (pakai --probe utk cek live)");
  if (!flags.full) notes.push("resource_content disembunyikan (pakai --full)");
  if (notes.length) result.notes = notes;

  out(result);
};

run().catch((e) => die(e?.message || String(e)));
