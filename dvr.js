/*
 * XTV DVR: record a live HLS channel and play it back a few minutes behind live with the ad
 * breaks cut out.
 *
 * Nothing is downloaded: free channels serve their video as small segment files that stay on the
 * CDN for a while, so a recording is just the list of segment URLs, polled from the channel's
 * playlist every few seconds. Segments that are ads (see adTracker in server.js) are left out, and
 * the playback playlist marks a discontinuity where each break was, so the show runs on from the
 * scene before the break to the scene after it.
 *
 * Each recording keeps up to MAX_KEEP of programme and stops when nobody has asked for it for
 * IDLE_STOP (playlist reloads and status checks from the player count as asking).
 */
const crypto = require('crypto');

const MAX_KEEP = 3 * 60 * 60;          // seconds of programme kept per recording
const IDLE_STOP = 3 * 60 * 1000;       // stop recording after this long without a viewer
const MAX_RECORDINGS = 12;
const MAX_ERRORS = 10;                 // consecutive failed playlist fetches before giving up

module.exports = function createDvr({ grab, relayUrl, adTracker }) {
  const recordings = new Map();

  const attrs = line => {
    const out = {};
    line.replace(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g, (_, k, v) => { out[k] = v.replace(/^"|"$/g, ''); });
    return out;
  };
  const withAbsUri = (line, base) => line.replace(/URI="([^"]+)"/, (_, u) => `URI="${new URL(u, base).href}"`);

  // Master playlist → the best video variant and, if audio is a separate track, its playlist.
  async function resolve(src) {
    const r = await grab(src.url, src, 2e6);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const text = r.body.toString('utf8');
    if (!text.startsWith('#EXTM3U')) throw new Error('not an HLS stream');
    if (!/#EXT-X-STREAM-INF/.test(text)) return { video: r.url, audio: null, info: '' };
    const lines = text.split(/\r?\n/).map(l => l.trim());
    const variants = [], audio = [];
    lines.forEach((l, i) => {
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const uri = lines.slice(i + 1).find(x => x && x[0] !== '#');
        if (uri) variants.push({ a: attrs(l.slice(18)), uri: new URL(uri, r.url).href, line: l });
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = attrs(l.slice(13));
        if (a.TYPE === 'AUDIO' && a.URI) audio.push({ ...a, URI: new URL(a.URI, r.url).href });
      }
    });
    if (!variants.length) throw new Error('empty master playlist');
    const best = variants.sort((x, y) => (+y.a.BANDWIDTH || 0) - (+x.a.BANDWIDTH || 0))[0];
    const group = best.a.AUDIO && audio.filter(m => m['GROUP-ID'] === best.a.AUDIO);
    const track = group?.length ? (group.find(m => m.DEFAULT === 'YES') || group[0]) : null;
    const info = ['BANDWIDTH', 'RESOLUTION', 'CODECS', 'FRAME-RATE']
      .filter(k => best.a[k]).map(k => k === 'CODECS' ? `CODECS="${best.a[k]}"` : `${k}=${best.a[k]}`).join(',');
    return { video: best.uri, audio: track ? track.URI : null, info };
  }

  function parseMedia(text, base) {
    const out = { seq: 0, target: 6, segs: [] };
    const ads = adTracker();
    let dur = 0, disc = false, map = '', key = '';
    for (const raw of text.split(/\r?\n/)) {
      const l = raw.trim();
      if (!l) continue;
      if (l[0] === '#') {
        ads.tag(l);
        if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) out.seq = parseInt(l.slice(22), 10) || 0;
        else if (l.startsWith('#EXT-X-TARGETDURATION:')) out.target = parseFloat(l.slice(22)) || 6;
        else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8)) || 0;
        else if (l === '#EXT-X-DISCONTINUITY') disc = true;
        else if (l.startsWith('#EXT-X-MAP:')) map = withAbsUri(l, base);
        else if (l.startsWith('#EXT-X-KEY:')) key = /METHOD=NONE/.test(l) ? '' : withAbsUri(l, base);
        continue;
      }
      out.segs.push({ uri: new URL(l, base).href, dur, ad: ads.segment(l), disc, map, key });
      disc = false;
    }
    return out;
  }

  function newTrack(url) {
    return {
      url, kept: [], lastUri: null, seen: new Set(), seenOrder: [], dirMax: new Map(), pending: new Map(), votes: [], reached: new Map(), current: null, loose: [],
      target: 6, cutPending: false, gap: false, trimmed: 0, trimmedDisc: 0, total: 0, keptDur: 0, cutDur: 0, inAd: false, errors: 0,
    };
  }

  // Where a segment sits in the stream: its folder, and the running number in its file name
  // (".../480348-1821270/hls_2400-00266.ts" → folder ".../480348-1821270/", number 266).
  // Tracking wrappers (".../beacon?url=<real segment>", "?redirect_url=<real segment>") are looked through.
  function position(uri) {
    let u;
    try { u = new URL(uri); } catch { return { dir: uri, num: NaN }; }
    for (const v of u.searchParams.values()) {
      if (/^https?:\/\//i.test(v)) { try { u = new URL(v); break; } catch {} }
    }
    let path = u.host + u.pathname;
    try { path = decodeURIComponent(path); } catch {}
    const slash = path.lastIndexOf('/');
    const m = /(\d+)\D*$/.exec(path.slice(slash + 1));
    return { dir: path.slice(0, slash + 1), num: m ? +m[1] : NaN };
  }

  const SEEN_MAX = 600;              // links remembered per track (~1 hour of 6 s segments)
  const VOTES = 7;                   // recent answers that vote on where the stream really is
  const MAJORITY = 4;                // …and how many must agree
  const PENDING_MAX = 400;           // offered-but-not-yet-recorded segments kept per folder
  // Some services (Pluto) don't answer consistently: most answers progress steadily, but some come
  // from a different part of the programme (stale caches, servers out of step) — sometimes minutes
  // off, ahead or behind. Recording answers as they came made playback jump back and forth.
  // So the recent answers vote: the programme section (folder) most of them show is followed, and
  // only up to the point most of them have reached. Everything offered is held until its turn, so a
  // section that wins the vote a few seconds late doesn't lose its start. Recording never goes back.
  function addSegments(t, p) {
    const now = Date.now();
    t.target = Math.max(t.target, p.target);
    const content = [];
    for (const s of p.segs) {
      if (t.seen.has(s.uri)) continue;
      const pos = position(s.uri);
      if (s.ad) continue;                                            // ads: handled below
      if (isNaN(pos.num)) { t.loose.push(s); continue; }            // unnumbered links: taken in order
      let dir = t.pending.get(pos.dir);
      if (!dir) t.pending.set(pos.dir, dir = new Map());
      if (!dir.has(pos.num)) dir.set(pos.num, s);
      if (dir.size > PENDING_MAX) dir.delete(Math.min(...dir.keys()));
      content.push(pos);
    }
    // This answer's vote: the folder of its newest programme segment, and how far it got.
    const last = [...p.segs].reverse().find(s => !s.ad && !isNaN(position(s.uri).num));
    if (last) {
      const pos = position(last.uri);
      t.votes.push({ dir: pos.dir, num: pos.num, at: now });
      if (t.votes.length > VOTES) t.votes.shift();
    }
    const adOnly = p.segs.length && p.segs.every(s => s.ad);
    if (adOnly) {                                                   // an ad break (left out of the recording)
      for (const s of p.segs) if (!t.seen.has(s.uri)) take(t, s, position(s.uri));
    }
    // Where do most recent answers say we are?
    const counts = new Map();
    for (const v of t.votes) counts.set(v.dir, (counts.get(v.dir) || 0) + 1);
    // A clear majority of the answers so far (at least 3) — so a recording starts within seconds.
    const need = Math.max(3, Math.min(MAJORITY, Math.ceil(t.votes.length * 0.6)));
    let winner = null;
    for (const [dir, n] of counts) if (n >= need) winner = dir;
    if (winner) {
      const nums = t.votes.filter(v => v.dir === winner).map(v => v.num).sort((a, b) => a - b);
      const reached = nums[Math.floor((nums.length - 1) / 2)];      // median: one odd answer can't move it
      // Most answers far behind us, answer after answer: the stream restarted its numbering.
      t.behind = (t.dirMax.get(winner) ?? -1) > reached + 30 ? (t.behind || 0) + 1 : 0;
      if (t.behind >= 10) { t.dirMax.delete(winner); t.reached.delete(winner); t.gap = true; t.behind = 0; }
      if (t.current && t.current !== winner) flush(t, t.current, t.reached.get(t.current) ?? -1);
      t.current = winner;
      t.reached.set(winner, Math.max(t.reached.get(winner) ?? -1, reached));
      flush(t, winner, t.reached.get(winner));
    }
    for (const s of t.loose.splice(0)) if (!t.seen.has(s.uri)) take(t, s, position(s.uri));
    t.inAd = adOnly;
    while (t.keptDur > MAX_KEEP && t.kept.length > 1) {
      const old = t.kept.shift();
      t.keptDur -= old.dur;
      t.trimmed++;
      if (t.kept[0].disc) t.trimmedDisc++;
      t.kept[0].disc = false;
    }
  }

  // Record a folder's held segments, in order, up to "upTo" — never anything older than already recorded.
  function flush(t, dirKey, upTo) {
    const held = t.pending.get(dirKey);
    if (!held) return;
    const max = t.dirMax.get(dirKey) ?? -1;
    const nums = [...held.keys()].filter(n => n > max && n <= upTo).sort((a, b) => a - b);
    let prev = max;
    for (const n of nums) {
      const s = held.get(n);
      held.delete(n);
      if (t.seen.has(s.uri)) continue;
      if (prev >= 0 && n > prev + 1) t.gap = true;                 // some of the programme never came by
      take(t, s, position(s.uri));
      prev = n;
    }
    for (const n of [...held.keys()]) if (n <= (t.dirMax.get(dirKey) ?? -1)) held.delete(n);
  }

  function take(t, s, pos) {
    t.seen.add(s.uri);
    t.seenOrder.push(s.uri);
    if (t.seenOrder.length > SEEN_MAX) t.seen.delete(t.seenOrder.shift());
    if (!s.ad && !isNaN(pos.num)) {
      t.dirMax.delete(pos.dir); // re-insert so the Map keeps the most recent folders last
      t.dirMax.set(pos.dir, pos.num);
      if (t.dirMax.size > 300) t.dirMax.delete(t.dirMax.keys().next().value);
    }
    t.lastUri = s.uri;
    t.total += s.dur;
    if (s.ad) { t.cutDur += s.dur; if (t.kept.length) t.cutPending = true; return; }
    t.kept.push({ uri: s.uri, dur: s.dur, map: s.map, key: s.key, disc: s.disc || t.cutPending || t.gap });
    t.cutPending = t.gap = false;
    t.keptDur += s.dur;
  }

  async function poll(rec, name) {
    const t = rec.tracks[name];
    if (!t || rec.stopped) return;
    let wait = 2000;
    try {
      const r = await grab(t.url, rec.src, 4e6);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const text = r.body.toString('utf8');
      if (!text.startsWith('#EXTM3U')) throw new Error('bad playlist');
      const p = parseMedia(text, r.url);
      addSegments(t, p);
      t.errors = 0;
      wait = Math.min(6000, Math.max(1500, p.target * 500));
    } catch (err) {
      if (++t.errors >= MAX_ERRORS) { rec.error = `stream stopped responding (${err.message})`; stop(rec); return; }
      wait = 3000;
    }
    if (Date.now() - rec.lastAccess > IDLE_STOP) { stop(rec); return; }
    rec.timers[name] = setTimeout(() => poll(rec, name), wait);
  }

  function stop(rec) {
    rec.stopped = true;
    for (const tm of Object.values(rec.timers)) clearTimeout(tm);
    if (!rec.error) recordings.delete(rec.id);
    else setTimeout(() => recordings.get(rec.id) === rec && recordings.delete(rec.id), 60000); // keep the error visible briefly
  }

  async function start(src) {
    const id = crypto.createHash('sha1').update(`${src.url}\n${src.ua}\n${src.ref}`).digest('hex').slice(0, 16);
    let rec = recordings.get(id);
    if (rec && !rec.stopped) { rec.lastAccess = Date.now(); return rec; }
    if ([...recordings.values()].filter(r => !r.stopped).length >= MAX_RECORDINGS) throw new Error('too many recordings running');
    const where = await resolve(src);
    rec = { id, src, info: where.info, tracks: { video: newTrack(where.video) }, timers: {}, lastAccess: Date.now(), started: Date.now() };
    if (where.audio) rec.tracks.audio = newTrack(where.audio);
    recordings.set(id, rec);
    await Promise.all(Object.keys(rec.tracks).map(name => poll(rec, name)));
    if (rec.error) throw new Error(rec.error);
    return rec;
  }

  const status = rec => {
    const v = rec.tracks.video;
    return {
      id: rec.id, error: rec.error || '',
      recorded: Math.round(v.total),   // seconds of stream seen, ads included (the head start)
      kept: Math.round(v.keptDur),     // seconds of programme in the recording
      cut: Math.round(v.cutDur),       // seconds of ads left out
      inAd: v.inAd,                    // the channel is in an ad break right now
    };
  };

  function mediaPlaylist(rec, name, opts) {
    const t = rec.tracks[name];
    const maxDur = t.kept.reduce((m, s) => Math.max(m, s.dur), t.target);
    const out = ['#EXTM3U', '#EXT-X-VERSION:6', `#EXT-X-TARGETDURATION:${Math.ceil(maxDur)}`,
      `#EXT-X-MEDIA-SEQUENCE:${t.trimmed}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${t.trimmedDisc}`];
    let map = null, key = '';
    t.kept.forEach((s, i) => {
      if (i && s.disc) out.push('#EXT-X-DISCONTINUITY');
      if (s.key !== key) { out.push(s.key ? relayTag(s.key, opts) : '#EXT-X-KEY:METHOD=NONE'); key = s.key; }
      if (s.map && s.map !== map) { out.push(relayTag(s.map, opts)); map = s.map; }
      out.push(`#EXTINF:${s.dur.toFixed(3)},`, relayUrl(s.uri, opts));
    });
    return out.join('\n') + '\n';
  }
  const relayTag = (line, opts) => line.replace(/URI="([^"]+)"/, (_, u) => `URI="${relayUrl(u, opts)}"`);

  function masterPlaylist(rec) {
    const out = ['#EXTM3U', '#EXT-X-VERSION:6'];
    const media = name => `/api/dvr/media.m3u8?id=${rec.id}&track=${name}`;
    if (rec.tracks.audio) out.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="${media('audio')}"`);
    out.push(`#EXT-X-STREAM-INF:${rec.info || 'BANDWIDTH=3000000'}${rec.tracks.audio ? ',AUDIO="aud"' : ''}`, media('video'));
    return out.join('\n') + '\n';
  }

  // /api/dvr/start (POST {url, ua, ref}) · /api/dvr/status?id · /api/dvr/master.m3u8?id · /api/dvr/media.m3u8?id&track
  return async function dvrApi(req, res, route, params, body) {
    const json = (code, b) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(b));
    const playlist = text => res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }).end(text);
    if (route === 'start') {
      const url = String(body.url || '');
      if (!/^https?:\/\//i.test(url)) { json(400, { error: 'bad url' }); return; }
      try { json(200, status(await start({ url, ua: String(body.ua || ''), ref: String(body.ref || '') }))); }
      catch (err) { json(422, { error: err.message }); }
      return;
    }
    const rec = recordings.get(params.get('id') || '');
    if (!rec) { json(404, { error: 'recording not found (it stops a few minutes after you leave the channel)' }); return; }
    rec.lastAccess = Date.now();
    if (route === 'status') json(200, status(rec));
    else if (route === 'master.m3u8') playlist(masterPlaylist(rec));
    else if (route === 'media.m3u8' && rec.tracks[params.get('track')]) playlist(mediaPlaylist(rec, params.get('track'), rec.src));
    else json(404, { error: 'unknown route' });
  };
};
