/*
 * XTV local server
 * ----------------
 * Serves the app and relays IPTV streams the way VLC fetches them, so the
 * browser can play links it can't reach directly (raw MPEG-TS, redirects to
 * other hosts, servers that reject non-player clients, http-only, no CORS).
 *
 *   node server.js            -> http://localhost:8092
 *   PORT=9000 node server.js
 *
 * GET /proxy?url=<encoded upstream URL>[&ua=…&ref=…]
 *                                          streams the upstream response through; HLS playlists are
 *                                          rewritten so their segments come through the relay too
 * GET /transcode?url=…[&ua=…&ref=…]       same, converted to H.264/AAC with ffmpeg (for formats
 *                                          browsers can't play, e.g. MPEG-2); needs ffmpeg on PATH
 * GET /proxy/ping                         lets the app detect this server
 * /api/account/me|register|login|logout   accounts (first account = admin), cookie sessions
 * /api/site/config                        lineup + settings + your favorites (signed in)
 * /api/site/favorites                     PUT your favorites
 * /api/site/lineup|settings|users|channels|retry   admin only
 * /api/dvr/start|status|master.m3u8|media.m3u8      DVR recordings (playlist links only, in memory)
 * Everything except the app's files and /api/account needs a signed-in user. Data lives in data/.
 * GET /api/iptv/search?q=disney xd         iptv-org channel search (name, logo, categories, country…)
 * GET /api/iptv/lookup?ids=DisneyXD.us,…   iptv-org channels by ID
 * GET /api/iptv/match?name=…&name=…        best exact-name match per name
 * GET /api/iptv/countries                  countries that have iptv-org streams
 * GET /api/iptv/streams?countries=US,CA    one stream per channel for those countries
 *                                          (each with health: ok | dead | unknown; checks start here)
 * GET /api/iptv/health?countries=US,UK     progress of those stream checks
 * GET /api/iptv/failed?url=…               the player gave up on a stream: mark it not working
 * GET /api/epg?ids=PlutoTV.us,…            program guide from iptv-org's i.mjh.nz guide sources
 * iptv-org data is cached in .cache/ and refreshed daily; guides every 6 hours (in memory).
 *
 * Listens on 127.0.0.1 only by default (set HOST=0.0.0.0 to use it from other
 * devices on your network — anyone who can reach it can use it as a relay).
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const vm = require('vm');

const PORT = +process.env.PORT || 8092;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const UA = 'VLC/3.0.21 LibVLC/3.0.21';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.m3u': 'audio/x-mpegurl', '.m3u8': 'application/vnd.apple.mpegurl',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// URL of this relay for an upstream URL, carrying the stream's required User-Agent / Referer along.
function relayUrl(target, opts, ad = false) {
  const q = new URLSearchParams({ url: target });
  if (opts.ua) q.set('ua', opts.ua);
  if (opts.ref) q.set('ref', opts.ref);
  if (ad) q.set('ad', '1'); // the player covers and mutes segments marked as ads
  return '/proxy?' + q;
}

// Ads that free channels stitch into the stream can be told apart in two ways:
//  - ad-break markers in the playlist (#EXT-X-CUE-OUT … #EXT-X-CUE-IN, or SCTE-35 date ranges), and
//  - segments served from ad systems (Pluto TV "…_ad/creative/…" and bumpers, Google ad pods, …).
// Ordinary TV commercials that are part of the broadcast itself (e.g. cable channels) carry neither.
const AD_SEGMENT = /\/\d*_?ad\/creative\/|\/creative\/[^/?]*_ad\b|ad_bumper|\/linear\/pods\/|doubleclick\.net|imasdk\.googleapis|freewheel|springserve|\/adserver|segments\.mediatailor|\/ads?\//i;
const attr = (line, key) => { const m = new RegExp(key + '="?([\\d.]+)', 'i').exec(line); return m ? +m[1] : NaN; };

// Follows a media playlist line by line and says which segments are ads (see AD_SEGMENT above).
function adTracker() {
  let inBreak = false, breakLeft = Infinity, dur = 0;
  const startBreak = seconds => { inBreak = true; breakLeft = seconds > 0 ? seconds : Infinity; };
  return {
    tag(l) {
      if (/^#EXTINF:/i.test(l)) dur = parseFloat(l.slice(8)) || 0;
      else if (/^#EXT-X-CUE-OUT-CONT/i.test(l)) { // joined mid-break: Duration and ElapsedTime tell how much is left
        const total = attr(l, 'Duration'), done = attr(l, 'ElapsedTime');
        startBreak(total - (done || 0));
      } else if (/^#EXT-X-CUE-OUT/i.test(l)) startBreak(parseFloat(l.split(':')[1]) || attr(l, 'DURATION'));
      else if (/^#EXT-X-CUE-IN/i.test(l)) inBreak = false;
      else if (/^#EXT-X-DATERANGE/i.test(l)) {
        if (/SCTE35-OUT=/i.test(l)) { if (!inBreak) startBreak(attr(l, 'PLANNED-DURATION') || attr(l, 'DURATION')); }
        else if (/SCTE35-IN=/i.test(l)) inBreak = false;
      }
    },
    segment(uri) {
      // Some links carry the path URL-encoded (Pluto: ".../p(9_ad%2Fcreative%2F...)"), so check both.
      let decoded = uri;
      try { decoded = decodeURIComponent(uri); } catch {}
      let ad = AD_SEGMENT.test(uri) || AD_SEGMENT.test(decoded);
      if (inBreak) {
        ad = true;
        breakLeft -= dur;
        if (breakLeft <= 0.05) inBreak = false;
      }
      return ad;
    },
  };
}

function rewritePlaylist(text, base, opts) {
  const abs = (s, ad) => { try { return relayUrl(new URL(s, base).href, opts, ad); } catch { return s; } };
  const ads = adTracker();
  return text.split(/\r?\n/).map(line => {
    const l = line.trim();
    if (!l) return line;
    if (l[0] === '#') {
      ads.tag(l);
      return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${abs(u)}"`);
    }
    return abs(l, ads.segment(l));
  }).join('\n');
}

function relay(req, res, target, opts = {}, hops = 0) {
  let u;
  try { u = new URL(target); } catch { res.writeHead(400).end('bad url'); return; }
  if (!/^https?:$/.test(u.protocol)) { res.writeHead(400).end('only http(s) urls'); return; }
  const headers = { 'User-Agent': opts.ua || UA, Accept: '*/*' };
  if (opts.ref) headers.Referer = opts.ref;
  const up = (u.protocol === 'https:' ? https : http).get(u, { headers }, r => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 5) {
      r.resume();
      relay(req, res, new URL(r.headers.location, u).href, opts, hops + 1);
      return;
    }
    const type = r.headers['content-type'] || 'application/octet-stream';
    const head = { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if (r.statusCode === 200 && (/mpegurl/i.test(type) || /\.m3u8?$/i.test(u.pathname))) {
      const chunks = [];
      let size = 0;
      r.on('data', c => { size += c.length; if (size > 8e6) up.destroy(new Error('playlist too large')); else chunks.push(c); });
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.startsWith('#EXTM3U')) { res.writeHead(200, head).end(Buffer.concat(chunks)); return; }
        res.writeHead(200, { ...head, 'Content-Type': 'application/vnd.apple.mpegurl' }).end(rewritePlaylist(text, u, opts));
      });
      return;
    }
    res.writeHead(r.statusCode, head);
    r.pipe(res);
  });
  up.setTimeout(15000, () => up.destroy(new Error('upstream timeout')));
  up.on('error', err => {
    console.warn('proxy:', u.host, err.message);
    if (!res.headersSent) res.writeHead(502).end(err.message); else res.destroy();
  });
  // Viewer left (channel change, tab closed): drop the upstream so it stops counting as a connection.
  res.on('close', () => up.destroy());
}

/* ---------- iptv-org channel database (https://github.com/iptv-org/api) ---------- */

const IPTV_API = 'https://iptv-org.github.io/api/';
const CACHE_DIR = path.join(ROOT, '.cache');
const DAY = 24 * 60 * 60 * 1000;
let iptv = null, iptvLoading = null;

function download(url, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    (u.protocol === 'https:' ? https : http).get(u, { headers: { 'User-Agent': 'xtv' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 5) {
        r.resume();
        download(new URL(r.headers.location, u).href, hops + 1).then(resolve, reject);
        return;
      }
      if (r.statusCode !== 200) { r.resume(); reject(new Error(`${url}: HTTP ${r.statusCode}`)); return; }
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve(Buffer.concat(chunks)));
      r.on('error', reject);
    }).on('error', reject).setTimeout(60000, function () { this.destroy(new Error(`${url}: timeout`)); });
  });
}
const getJSON = url => download(url).then(b => b.toString('utf8'));

// One of iptv-org's data files, cached on disk for a day (falls back to a stale copy when offline).
async function iptvFile(name) {
  const file = path.join(CACHE_DIR, `iptv-${name}.json`);
  const st = fs.existsSync(file) && fs.statSync(file);
  if (st && Date.now() - st.mtimeMs < DAY) return JSON.parse(fs.readFileSync(file, 'utf8'));
  try {
    const text = await getJSON(IPTV_API + name + '.json');
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, text);
    return JSON.parse(text);
  } catch (err) {
    if (st) { console.warn('iptv-org:', err.message, '(using cached copy)'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
    throw err;
  }
}

function loadIptv() {
  if (iptv && Date.now() - iptv.loaded < DAY) return Promise.resolve(iptv);
  return iptvLoading ||= Promise.all(['channels', 'logos', 'categories'].map(iptvFile)).then(([channels, logos, categories]) => {
    const catName = new Map(categories.map(c => [c.id, c.name]));
    // Best logo per channel: in use, channel-wide (not a single feed), raster before SVG, then largest.
    const logo = new Map();
    const rank = l => (l.in_use ? 4 : 0) + (l.feed ? 0 : 2) + (l.format === 'SVG' ? 0 : 1);
    for (const l of logos) {
      const cur = logo.get(l.channel);
      if (!cur || rank(l) > rank(cur) || (rank(l) === rank(cur) && l.width > cur.width)) logo.set(l.channel, l);
    }
    const byId = new Map();
    for (const c of channels) {
      byId.set(c.id, {
        id: c.id, name: c.name, altNames: c.alt_names || [], network: c.network, owners: c.owners || [], country: c.country,
        categories: (c.categories || []).map(id => catName.get(id) || id), website: c.website, closed: c.closed, nsfw: c.is_nsfw,
        logo: logo.get(c.id)?.url || '',
      });
    }
    iptv = { byId, list: [...byId.values()], loaded: Date.now() };
    console.log(`iptv-org: ${byId.size} channels loaded`);
    return iptv;
  }).finally(() => { iptvLoading = null; });
}

const fold = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

function iptvSearch(db, q, country, limit = 20) {
  const fq = fold(q);
  if (!fq) return [];
  const hits = [];
  for (const c of db.list) {
    if (c.nsfw) continue;
    const names = [c.name, ...c.altNames].map(fold);
    let score = 0;
    if (c.id.toLowerCase() === q.toLowerCase()) score = 100;
    else if (names.includes(fq)) score = 50;
    else if (names.some(n => n.startsWith(fq))) score = 30;
    else if (names.some(n => n.includes(fq))) score = 10;
    if (!score) continue;
    if (!c.closed) score += 5;
    if (country && c.country === country.toUpperCase()) score += 8;
    hits.push([score, c]);
  }
  return hits.sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length).slice(0, limit).map(h => h[1]);
}

async function iptvApi(res, route, params) {
  const send = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  let db;
  try { db = await loadIptv(); } catch (err) { send(503, { error: `iptv-org data unavailable: ${err.message}` }); return; }
  if (route === 'search') send(200, iptvSearch(db, params.get('q') || '', params.get('country')));
  else if (route === 'countries' || route === 'streams') {
    let cat;
    try { cat = await loadCatalog(); } catch (err) { send(503, { error: `iptv-org data unavailable: ${err.message}` }); return; }
    if (route === 'countries') { send(200, cat.countries); return; }
    const list = (params.get('countries') || '').split(',').flatMap(cc => cat.byCountry.get(cc.toUpperCase()) || []);
    checkStreams(list);
    send(200, list.map(s => ({ ...s, health: healthOf(s.url) })));
  } else if (route === 'health') {
    // Progress of the stream checks for these countries.
    let cat;
    try { cat = await loadCatalog(); } catch (err) { send(503, { error: err.message }); return; }
    const list = (params.get('countries') || '').split(',').flatMap(cc => cat.byCountry.get(cc.toUpperCase()) || []);
    const n = { total: list.length, ok: 0, dead: 0, unknown: 0 };
    for (const s of list) n[healthOf(s.url)]++;
    send(200, { ...n, checking: list.filter(s => probing.has(s.url)).length });
  } else if (route === 'failed') {
    // The player couldn't play this stream: treat it as not working until the next check.
    const url = params.get('url');
    if (url && !probing.has(url)) { health[url] = { ok: false, at: Date.now(), why: 'failed in player' }; saveHealth(); }
    send(200, { ok: true });
  }
  else if (route === 'lookup') {
    const out = {};
    for (const id of (params.get('ids') || '').split(',')) if (db.byId.has(id)) out[id] = db.byId.get(id);
    send(200, out);
  } else if (route === 'match') {
    // Channels without an iptv-org ID: match by exact name, but only when exactly one active channel
    // has that name ("Disney XD" alone is ambiguous: US and Poland), optionally narrowed by country.
    const out = {}, country = (params.get('country') || '').toUpperCase();
    for (const name of params.getAll('name')) {
      const fn = fold(name);
      let same = iptvSearch(db, name, '', 50).filter(c => !c.closed && [c.name, ...c.altNames].map(fold).includes(fn));
      if (country && same.length > 1) same = same.filter(c => c.country === country);
      if (same.length === 1) out[name] = same[0];
    }
    send(200, out);
  } else send(404, { error: 'unknown route' });
}

/* ---------- iptv-org streams by country ---------- */

let catalog = null, catalogLoading = null;

// Streams, countries and guide sources, joined onto the channel database.
function loadCatalog() {
  if (catalog && Date.now() - catalog.loaded < DAY) return Promise.resolve(catalog);
  return catalogLoading ||= Promise.all([loadIptv(), iptvFile('streams'), iptvFile('countries'), iptvFile('guides')]).then(([db, streams, countries, guides]) => {
    // Guide sources we can read directly: i.mjh.nz publishes ready-made XMLTV files
    // (site_id "PlutoTV/us#<channel id in that file>" -> https://i.mjh.nz/PlutoTV/us.xml.gz).
    const guide = new Map();
    for (const g of guides) {
      if (g.site !== 'i.mjh.nz' || !g.channel) continue;
      const [file, id] = g.site_id.split('#');
      if (!file || !id) continue;
      if (!guide.has(g.channel)) guide.set(g.channel, []);
      guide.get(g.channel).push({ file, id });
    }
    // One stream per channel: unlabeled ("Geo-blocked", "Not 24/7" …) first, then highest quality.
    const q = s => parseInt(s.quality, 10) || 0;
    const best = new Map();
    for (const s of streams) {
      const c = s.channel && db.byId.get(s.channel);
      if (!c || c.closed || c.nsfw) continue;
      const cur = best.get(c.id);
      const better = !cur || (s.labels?.length || 0) < (cur.labels?.length || 0) ||
        ((s.labels?.length || 0) === (cur.labels?.length || 0) && q(s) > q(cur));
      if (better) best.set(c.id, s);
    }
    const byCountry = new Map();
    for (const [id, s] of best) {
      const c = db.byId.get(id);
      if (!byCountry.has(c.country)) byCountry.set(c.country, []);
      byCountry.get(c.country).push({
        iptvId: id, name: c.name, logo: c.logo, group: c.categories[0] || 'General', country: c.country,
        url: s.url, userAgent: s.user_agent || '', referrer: s.referrer || '', quality: s.quality || '',
        labels: s.labels || [], hasGuide: guide.has(id),
      });
    }
    for (const list of byCountry.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    const countryList = countries.filter(c => byCountry.has(c.code))
      .map(c => ({ code: c.code, name: c.name, flag: c.flag, count: byCountry.get(c.code).length }))
      .sort((a, b) => a.name.localeCompare(b.name));
    catalog = { byCountry, countries: countryList, guide, loaded: Date.now() };
    console.log(`iptv-org: ${best.size} channels with streams in ${countryList.length} countries, ${guide.size} with guides`);
    return catalog;
  }).finally(() => { catalogLoading = null; });
}

/* ---------- Stream health: which iptv-org streams actually play ---------- */

// Each stream is checked the way a player would open it: playlist → (variant playlist) → a video
// segment, with the stream's User-Agent/Referer. Results are kept in .cache/health.json and
// rechecked every 12 hours. Your own channels (channels.js / the lineup editor) are never probed.
const HEALTH_FILE = path.join(CACHE_DIR, 'health.json');
const RECHECK = 12 * 60 * 60 * 1000;
const PROBE_CONCURRENCY = 24;
let health = {};
try { health = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')); } catch {}
let healthSaveTimer = 0;
function saveHealth() {
  clearTimeout(healthSaveTimer);
  healthSaveTimer = setTimeout(() => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFile(HEALTH_FILE, JSON.stringify(health), err => err && console.warn('health:', err.message));
  }, 2000);
}

// GET up to maxBytes of a URL (following redirects), then hang up.
function grab(url, opts, maxBytes, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error('bad url')); return; }
    const headers = { 'User-Agent': opts.ua || UA, Accept: '*/*' };
    if (opts.ref) headers.Referer = opts.ref;
    const req = (u.protocol === 'https:' ? https : http).get(u, { headers }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 5) {
        r.resume();
        grab(new URL(r.headers.location, u).href, opts, maxBytes, hops + 1).then(resolve, reject);
        return;
      }
      const chunks = [];
      let size = 0, done = false;
      const finish = () => { if (done) return; done = true; resolve({ status: r.statusCode, url: u.href, body: Buffer.concat(chunks) }); req.destroy(); };
      r.on('data', c => { chunks.push(c); size += c.length; if (size >= maxBytes) finish(); });
      r.on('end', finish);
      r.on('error', err => { if (!done) reject(err); });
    });
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.on('error', err => reject(err));
  });
}

async function probe(s) {
  const opts = { ua: s.userAgent, ref: s.referrer };
  let r = await grab(s.url, opts, 512e3);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  let text = r.body.toString('utf8');
  if (!text.startsWith('#EXTM3U')) { if (!r.body.length) throw new Error('no data'); return; } // direct stream
  const uris = t => t.split(/\r?\n/).map(l => l.trim()).filter(l => l && l[0] !== '#');
  if (/#EXT-X-STREAM-INF/.test(text)) { // master playlist: check the first variant
    const v = uris(text)[0];
    if (!v) throw new Error('empty playlist');
    r = await grab(new URL(v, r.url).href, opts, 512e3);
    if (r.status !== 200) throw new Error(`variant HTTP ${r.status}`);
    text = r.body.toString('utf8');
    if (!text.startsWith('#EXTM3U')) throw new Error('bad variant playlist');
  }
  const segs = uris(text);
  if (!segs.length) throw new Error('no segments');
  const seg = await grab(new URL(segs[segs.length - 1], r.url).href, opts, 16e3);
  if (seg.status !== 200 && seg.status !== 206) throw new Error(`segment HTTP ${seg.status}`);
  if (!seg.body.length) throw new Error('empty segment');
}

const probeQueue = [], probing = new Set();
let probeWorkers = 0;
function checkStreams(list, force = false) {
  const now = Date.now();
  for (const s of list) {
    const h = health[s.url];
    if ((force || !h || now - h.at > RECHECK) && !probing.has(s.url)) { probing.add(s.url); probeQueue.push(s); }
  }
  while (probeWorkers < PROBE_CONCURRENCY && probeQueue.length) {
    probeWorkers++;
    (async () => {
      for (let s; (s = probeQueue.shift());) {
        try { await probe(s); health[s.url] = { ok: true, at: Date.now() }; }
        catch (err) { health[s.url] = { ok: false, at: Date.now(), why: err.message }; }
        probing.delete(s.url);
        saveHealth();
      }
      probeWorkers--;
    })();
  }
}
const healthOf = url => health[url] ? (health[url].ok ? 'ok' : 'dead') : 'unknown';

/* ---------- Program guides (XMLTV from i.mjh.nz) ---------- */

const GUIDE_TTL = 6 * 60 * 60 * 1000;
const guideFiles = new Map(); // file -> { loaded, programs: Map(channel id -> [...]) } or a pending Promise

const xmlText = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1))
    : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()]).trim();

// XMLTV time: "20261025120000 +0000"
function xmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-])?(\d{2})?(\d{2})?/.exec(s || '');
  if (!m) return NaN;
  const t = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return m[7] ? t - (m[7] === '-' ? -1 : 1) * ((+m[8]) * 60 + (+m[9] || 0)) * 60000 : t;
}

function parseXmltv(xml) {
  const programs = new Map();
  const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attr = k => (new RegExp(`\\b${k}="([^"]*)"`).exec(m[1]) || [])[1];
    const ch = attr('channel'), start = xmltvTime(attr('start')), end = xmltvTime(attr('stop'));
    if (!ch || !(end > start)) continue;
    const title = /<title\b[^>]*>([\s\S]*?)<\/title>/.exec(m[2]);
    const sub = /<sub-title\b[^>]*>([\s\S]*?)<\/sub-title>/.exec(m[2]);
    const desc = /<desc\b[^>]*>([\s\S]*?)<\/desc>/.exec(m[2]);
    if (!programs.has(ch)) programs.set(ch, []);
    programs.get(ch).push({
      start, end, title: title ? xmlText(title[1]) : 'Untitled',
      desc: [sub && xmlText(sub[1]), desc && xmlText(desc[1])].filter(Boolean).join(' — '),
    });
  }
  for (const list of programs.values()) list.sort((a, b) => a.start - b.start);
  return programs;
}

async function guideFile(file) {
  const cur = guideFiles.get(file);
  if (cur && !(cur instanceof Promise) && Date.now() - cur.loaded < GUIDE_TTL) return cur.programs;
  if (cur instanceof Promise) return cur;
  const p = download(`https://i.mjh.nz/${file}.xml.gz`)
    .then(buf => { const programs = parseXmltv(zlib.gunzipSync(buf).toString('utf8')); guideFiles.set(file, { loaded: Date.now(), programs }); return programs; })
    .catch(err => {
      console.warn('guide:', file, err.message);
      if (cur) { guideFiles.set(file, cur); return cur.programs; }
      guideFiles.delete(file);
      return new Map();
    });
  guideFiles.set(file, p);
  return p;
}

// GET /api/epg?ids=PlutoTV.us,…  ->  { "<iptv-org id>": [{ start, end, title, desc }] } for the next ~day
async function epgApi(res, params) {
  const send = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  let cat;
  try { cat = await loadCatalog(); } catch (err) { send(503, { error: err.message }); return; }
  const from = Date.now() - 6 * 3600e3, to = Date.now() + 30 * 3600e3;
  const out = {};
  await Promise.all((params.get('ids') || '').split(',').filter(Boolean).slice(0, 200).map(async id => {
    for (const src of cat.guide.get(id) || []) {
      const list = (await guideFile(src.file)).get(src.id);
      if (list?.length) { out[id] = list.filter(p => p.end > from && p.start < to); return; }
    }
  }));
  send(200, out);
}

/* ---------- DVR: watch behind live with ad breaks cut (see dvr.js) ---------- */

const dvrApi = require('./dvr.js')({ grab, relayUrl, adTracker });

/* ---------- Format conversion (ffmpeg) ---------- */

// Browsers only decode H.264/AAC-style streams; VLC plays anything. For the rest (MPEG-2 video,
// MP2/AC-3 audio …) ffmpeg reads the stream through this relay and re-encodes it as H.264/AAC.
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const HAS_FFMPEG = (() => { try { return spawnSync(FFMPEG, ['-version'], { timeout: 5000 }).status === 0; } catch { return false; } })();

function transcode(req, res, target, opts) {
  if (!HAS_FFMPEG) { res.writeHead(501).end('ffmpeg not installed'); return; }
  const src = `http://127.0.0.1:${PORT}${relayUrl(target, opts)}`;
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-headers', `X-XTV-Internal: ${INTERNAL}\r\n`, '-i', src,
    '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', '60', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  ff.stdout.pipe(res);
  ff.stderr.on('data', d => console.warn('ffmpeg:', String(d).trim()));
  ff.on('close', () => res.end());
  res.on('close', () => ff.kill('SIGKILL'));
}

/* ---------- Accounts, site settings and the shared lineup ---------- */

// Everything lives in data/ (users, sessions, settings, lineup). The first account registered is the
// admin; the admin edits the lineup, picks countries, checks channel status and manages users.
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const readData = (name, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch { return d; } };
function writeData(name, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, name);
  if (value === undefined) { fs.rmSync(file, { force: true }); return; }
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}
let users = readData('users.json', {});       // lowercased name -> { name, salt, hash, admin, created, favs }
let sessions = readData('sessions.json', {}); // token -> { user, expires }
let settings = readData('settings.json', {}); // { countries, hideBroken, registrationOpen }
const SESSION_DAYS = 30;
const INTERNAL = crypto.randomBytes(24).toString('hex'); // lets ffmpeg read through the relay

// channels.js (window.XTV_CONFIG = {...}) holds the starting lineup and defaults. It is read here
// and never served to browsers, since it can contain provider logins.
function defaults() {
  try {
    const box = { window: {} };
    // Your own channels.js if you have one, otherwise the example that ships with XTV (fresh installs).
    const file = ['channels.js', 'channels.example.js'].map(f => path.join(ROOT, f)).find(f => fs.existsSync(f));
    if (!file) return {};
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), box, { timeout: 1000 });
    return box.window.XTV_CONFIG || {};
  } catch (err) { console.warn('channels.js:', err.message); return {}; }
}
function siteConfig() {
  const d = defaults(), lineup = readData('lineup.json', null);
  return {
    networkName: d.networkName || 'XTV',
    playlistUrl: d.playlistUrl || '',
    channels: lineup || d.channels || [],
    customLineup: !!lineup,
    countries: settings.countries ?? d.iptvCountries ?? [],
    hideBroken: settings.hideBroken ?? true,
    registrationOpen: settings.registrationOpen ?? true,
  };
}

const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
function checkPassword(u, password) {
  const a = Buffer.from(hashPassword(password, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const publicUser = u => u && { name: u.name, admin: !!u.admin };

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const token = cookies(req).xtv_session, s = token && sessions[token];
  if (!s) return null;
  if (s.expires < Date.now()) { delete sessions[token]; writeData('sessions.json', sessions); return null; }
  return users[s.user] || null;
}
function startSession(res, u) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions[token] = { user: u.name.toLowerCase(), expires: Date.now() + SESSION_DAYS * 864e5 };
  writeData('sessions.json', sessions);
  res.setHeader('Set-Cookie', `xtv_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}
function endSession(req, res) {
  const token = cookies(req).xtv_session;
  if (token && sessions[token]) { delete sessions[token]; writeData('sessions.json', sessions); }
  res.setHeader('Set-Cookie', 'xtv_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => { size += c.length; if (size > 2e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));

// Slow down password guessing: 10 failed sign-ins per address per 10 minutes.
const failures = new Map();
function tooManyFailures(req) {
  const ip = req.socket.remoteAddress, now = Date.now();
  const list = (failures.get(ip) || []).filter(t => now - t < 10 * 60e3);
  failures.set(ip, list);
  return list.length >= 10;
}
const noteFailure = req => failures.get(req.socket.remoteAddress)?.push(Date.now()) ?? failures.set(req.socket.remoteAddress, [Date.now()]);

async function accountApi(req, res, route) {
  const me = currentUser(req);
  if (route === 'me') {
    json(res, 200, { user: publicUser(me), setup: !Object.keys(users).length, registrationOpen: siteConfig().registrationOpen });
    return;
  }
  if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return; }
  if (route === 'logout') { endSession(req, res); json(res, 200, { ok: true }); return; }
  let body;
  try { body = await readBody(req); } catch (err) { json(res, 400, { error: err.message }); return; }
  const name = String(body.name || '').trim(), password = String(body.password || '');
  if (route === 'register') {
    const first = !Object.keys(users).length;
    if (!first && !siteConfig().registrationOpen) { json(res, 403, { error: 'New accounts are switched off. Ask the admin.' }); return; }
    if (!/^[\w.-]{3,32}$/.test(name)) { json(res, 400, { error: 'Username: 3–32 letters, numbers, dots, dashes or underscores.' }); return; }
    if (password.length < 8) { json(res, 400, { error: 'Password: at least 8 characters.' }); return; }
    if (users[name.toLowerCase()]) { json(res, 409, { error: 'That username is taken.' }); return; }
    const salt = crypto.randomBytes(16).toString('hex');
    const u = users[name.toLowerCase()] = { name, salt, hash: hashPassword(password, salt), admin: first, created: Date.now(), favs: [] };
    writeData('users.json', users);
    startSession(res, u);
    json(res, 200, { user: publicUser(u) });
  } else if (route === 'login') {
    if (tooManyFailures(req)) { json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' }); return; }
    const u = users[name.toLowerCase()];
    if (!u || !checkPassword(u, password)) { noteFailure(req); json(res, 401, { error: 'Wrong username or password.' }); return; }
    startSession(res, u);
    json(res, 200, { user: publicUser(u) });
  } else json(res, 404, { error: 'unknown route' });
}

// Signed-in users: site config + their favorites. Admin: lineup, settings, users, channel status.
async function siteApi(req, res, route, params, me) {
  let body = {};
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try { body = await readBody(req); } catch (err) { json(res, 400, { error: err.message }); return; }
  }
  if (route === 'config') { json(res, 200, { ...siteConfig(), favs: me.favs || [], user: publicUser(me) }); return; }
  if (route === 'favorites' && req.method === 'PUT') {
    me.favs = Array.isArray(body.favs) ? body.favs.filter(f => typeof f === 'string').slice(0, 5000) : [];
    writeData('users.json', users);
    json(res, 200, { ok: true });
    return;
  }
  if (!me.admin) { json(res, 403, { error: 'Admins only.' }); return; }

  if (route === 'lineup') {
    if (req.method === 'PUT' && Array.isArray(body.channels)) writeData('lineup.json', body.channels);
    else if (req.method === 'DELETE') writeData('lineup.json', undefined); // back to channels.js
    else { json(res, 400, { error: 'bad request' }); return; }
    json(res, 200, { ok: true });
  } else if (route === 'settings' && req.method === 'PUT') {
    for (const k of ['countries', 'hideBroken', 'registrationOpen']) if (k in body) settings[k] = body[k];
    if (Array.isArray(settings.countries)) settings.countries = settings.countries.map(c => String(c).toUpperCase()).slice(0, 50);
    writeData('settings.json', settings);
    json(res, 200, siteConfig());
  } else if (route === 'users') {
    if (req.method === 'GET') { json(res, 200, Object.values(users).map(u => ({ ...publicUser(u), created: u.created }))); return; }
    const u = users[String(params.get('name') || body.name || '').toLowerCase()];
    if (!u) { json(res, 404, { error: 'No such user.' }); return; }
    const admins = Object.values(users).filter(x => x.admin);
    if ((req.method === 'DELETE' || body.admin === false) && u.admin && admins.length === 1) { json(res, 400, { error: 'There must be at least one admin.' }); return; }
    if (req.method === 'DELETE') {
      delete users[u.name.toLowerCase()];
      for (const [t, s] of Object.entries(sessions)) if (s.user === u.name.toLowerCase()) delete sessions[t];
      writeData('sessions.json', sessions);
    } else if (typeof body.admin === 'boolean') u.admin = body.admin;
    else { json(res, 400, { error: 'Nothing to change.' }); return; }
    writeData('users.json', users);
    json(res, 200, { ok: true });
  } else if (route === 'channels') {
    // Every channel in the lineup with its last check: iptv-org streams for the chosen countries,
    // plus the lineup's own channels (checked only when the admin asks).
    let cat;
    try { cat = await loadCatalog(); } catch (err) { json(res, 503, { error: err.message }); return; }
    const cfg = siteConfig();
    const own = cfg.channels.filter(c => c && c.url).map(c => ({ name: c.name, url: c.url, country: '', own: true, userAgent: c.userAgent || '', referrer: c.referrer || '' }));
    const iptvList = cfg.countries.flatMap(cc => cat.byCountry.get(cc) || []);
    json(res, 200, [...own, ...iptvList].map(s => ({
      name: s.name, url: s.url, country: s.country, own: !!s.own, iptvId: s.iptvId || '',
      status: probing.has(s.url) ? 'checking' : healthOf(s.url), why: health[s.url]?.why || '', at: health[s.url]?.at || 0,
    })));
  } else if (route === 'retry' && req.method === 'POST') {
    // Check these streams again now; ones that pass are back in everyone's lineup straight away.
    let cat;
    try { cat = await loadCatalog(); } catch (err) { json(res, 503, { error: err.message }); return; }
    const want = new Set(Array.isArray(body.urls) ? body.urls : []);
    const cfg = siteConfig();
    const known = [...cfg.channels.filter(c => c && c.url).map(c => ({ url: c.url, userAgent: c.userAgent, referrer: c.referrer })),
      ...cfg.countries.flatMap(cc => cat.byCountry.get(cc) || [])];
    const list = known.filter(s => want.has(s.url));
    checkStreams(list, true);
    json(res, 200, { queued: list.length });
  } else json(res, 404, { error: 'unknown route' });
}

// Only the app's own files are public (never data/, .cache/, server.js or channels.js).
const PUBLIC = new Set(['index.html', 'app.js', 'styles.css']);
function serveFile(req, res, pathname) {
  const name = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  if (!PUBLIC.has(name)) { res.writeHead(404).end('not found'); return; }
  const file = path.join(ROOT, name);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  if (pathname === '/proxy/ping') { res.writeHead(200, { 'Content-Type': 'text/plain' }).end('xtv'); return; }
  if (pathname.startsWith('/api/account/')) { accountApi(req, res, pathname.slice(13)); return; }
  // Everything below needs a signed-in user (ffmpeg reading through the relay uses the internal key).
  const internal = req.headers['x-xtv-internal'] === INTERNAL;
  const me = internal ? null : currentUser(req);
  if (!internal && !me && (pathname === '/proxy' || pathname === '/transcode' || pathname.startsWith('/api/'))) {
    json(res, 401, { error: 'Please sign in.' });
    return;
  }
  if (pathname.startsWith('/api/site/')) { siteApi(req, res, pathname.slice(10), searchParams, me); return; }
  if (pathname.startsWith('/api/dvr/')) {
    (async () => {
      let body = {};
      if (req.method === 'POST') { try { body = await readBody(req); } catch (err) { json(res, 400, { error: err.message }); return; } }
      dvrApi(req, res, pathname.slice(9), searchParams, body);
    })();
    return;
  }
  if (pathname === '/proxy') {
    relay(req, res, searchParams.get('url') || '', { ua: searchParams.get('ua') || '', ref: searchParams.get('ref') || '' });
    return;
  }
  if (pathname === '/transcode') {
    transcode(req, res, searchParams.get('url') || '', { ua: searchParams.get('ua') || '', ref: searchParams.get('ref') || '' });
    return;
  }
  if (pathname === '/api/caps') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ffmpeg: HAS_FFMPEG })); return; }
  if (pathname === '/api/epg') { epgApi(res, searchParams); return; }
  if (pathname.startsWith('/api/iptv/')) { iptvApi(res, pathname.slice(10), searchParams); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  serveFile(req, res, pathname);
}).listen(PORT, HOST, () => console.log(`XTV running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
