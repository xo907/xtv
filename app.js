(() => {
  'use strict';

  let CFG = { channels: [] }; // site config from server.js (lineup, countries…), loaded after sign-in
  let me = null;              // signed-in user: { name, admin }
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const store = {
    get(k, d) { try { const v = localStorage.getItem('xtv.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('xtv.' + k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem('xtv.' + k); } catch {} },
  };

  const MIN = 60e3, HOUR = 60 * MIN, HALF = 30 * MIN, WINDOW = 3 * HOUR;
  const app = $('#app'), video = $('#video'), screen = $('#screen');

  const state = {
    mode: 'splash',
    channels: [],
    favs: new Set(),
    cur: -1, prev: -1,
    filter: 'all',
    guide: { row: 0, time: 0, start: 0 },
    listSel: 0,
    q: '',
    num: '', numTimer: 0,
    custom: false,
  };

  /* ================= Channels ================= */

  function normalize(list) {
    const used = new Set();
    const out = list.filter(c => c && c.url).map(c => ({ ...c }));
    out.forEach(c => {
      const n = parseInt(c.number, 10);
      c.number = n > 0 && !used.has(n) ? n : 0;
      if (c.number) used.add(c.number);
    });
    let next = 1;
    out.forEach(c => {
      if (!c.number) { while (used.has(next)) next++; c.number = next; used.add(next); }
      c.name = String(c.name || `Channel ${c.number}`).trim();
      c.group = String(c.group || 'General').trim();
      c.schedule = Array.isArray(c.schedule) ? c.schedule : [];
    });
    return out.sort((a, b) => a.number - b.number);
  }

  // The lineup is shared by everyone and saved on the server (admins only).
  function saveChannels() {
    state.custom = true;
    CFG.channels = state.channels.filter(c => !c.source);
    api('site/lineup', 'PUT', { channels: CFG.channels }).catch(err => toast(`Couldn't save the lineup: ${esc(err.message)}`, 4000));
    enrichChannels();
  }
  async function api(path, method = 'GET', body) {
    const r = await fetch('api/' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }
  async function loadConfig() {
    CFG = await api('site/config');
    me = CFG.user;
    state.favs = new Set(CFG.favs || []);
    app.classList.toggle('is-admin', !!me?.admin);
  }

  /* ================= iptv-org channel data (via server.js) ================= */

  // Channels get a missing logo and category filled in from iptv-org, by their `iptvId`
  // (e.g. "DisneyXD.us") or, failing that, by an unambiguous exact name match.
  const iptvInfo = new Map(); // channel url -> iptv-org record
  async function enrichChannels() {
    if (!proxy) return;
    const need = state.channels.filter(c => !iptvInfo.has(c.url));
    if (!need.length) return;
    const ids = [...new Set(need.map(c => c.iptvId).filter(Boolean))];
    const names = [...new Set(need.filter(c => !c.iptvId).map(c => c.name))];
    const byId = {}, byName = {};
    try {
      for (let i = 0; i < ids.length; i += 50)
        Object.assign(byId, await (await fetch(`api/iptv/lookup?ids=${encodeURIComponent(ids.slice(i, i + 50).join(','))}`)).json());
      for (let i = 0; i < names.length; i += 50)
        Object.assign(byName, await (await fetch('api/iptv/match?' + names.slice(i, i + 50).map(n => 'name=' + encodeURIComponent(n)).join('&'))).json());
    } catch (err) { console.warn('XTV: iptv-org lookup failed', err); return; }
    let changed = false;
    for (const c of need) {
      const info = c.iptvId ? byId[c.iptvId] : byName[c.name];
      if (!info) continue;
      iptvInfo.set(c.url, info);
      if (!c.logo && info.logo) { c.logo = info.logo; changed = true; }
      if (c.group === 'General' && info.categories[0]) { c.group = info.categories[0]; changed = true; }
    }
    if (!changed) return;
    if (state.mode === 'guide') renderGuide(false);
    else if (state.mode === 'list') renderList();
    else if (state.mode === 'manage') renderManage();
  }

  const iptvLabel = c => `${c.name} · ${c.country}${c.categories.length ? ' · ' + c.categories.join(', ') : ''}${c.closed ? ' (closed)' : ''}`;

  // Re-locate the tuned channel after the lineup changes (sorting/renumbering).
  function reindex(curUrl, prevUrl) {
    state.cur = state.channels.findIndex(c => c.url === curUrl);
    state.prev = state.channels.findIndex(c => c.url === prevUrl);
  }

  function parseM3U(text) {
    const out = [];
    let meta = null, group = '';
    for (const raw of text.split(/\r?\n/)) {
      const l = raw.trim();
      if (!l) continue;
      if (/^#EXTINF/i.test(l)) {
        meta = {};
        let q = false, cut = -1;
        for (let i = 0; i < l.length; i++) {
          if (l[i] === '"') q = !q;
          else if (l[i] === ',' && !q) { cut = i; break; }
        }
        const head = cut < 0 ? l : l.slice(0, cut);
        const attrs = {};
        head.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { attrs[k.toLowerCase()] = v; });
        meta.name = (cut < 0 ? '' : l.slice(cut + 1).trim()) || attrs['tvg-name'] || '';
        meta.number = attrs['tvg-chno'] || attrs['channel-number'] || attrs['tvg-channel-number'] || '';
        meta.logo = attrs['tvg-logo'] || attrs['logo'] || '';
        meta.group = attrs['group-title'] || group;
        if (attrs['tvg-id']) meta.callsign = attrs['tvg-id'].slice(0, 8);
        if (/^[\w&+!-]+\.[a-z]{2}(@[\w-]+)?$/i.test(attrs['tvg-id'] || '')) meta.iptvId = attrs['tvg-id'].split('@')[0];
      } else if (/^#EXTGRP:/i.test(l)) {
        group = l.slice(8).trim();
        if (meta) meta.group = meta.group || group;
      } else if (l[0] !== '#') {
        out.push({ ...(meta || {}), url: l });
        meta = null;
      }
    }
    return out;
  }

  function toM3U(list) {
    const a = s => String(s ?? '').replace(/"/g, "'");
    return '#EXTM3U\n' + list.map(c =>
      `#EXTINF:-1 tvg-chno="${c.number}" tvg-name="${a(c.name)}"${c.iptvId || c.callsign ? ` tvg-id="${a(c.iptvId || c.callsign)}"` : ''} tvg-logo="${a(c.logo)}" group-title="${a(c.group)}",${c.name}\n${c.url}`
    ).join('\n') + '\n';
  }

  /* ================= Schedule / EPG ================= */

  function parseHM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }

  const floorTo = (t, step) => { const d = new Date(t); d.setMinutes(Math.floor(d.getMinutes() / (step / MIN)) * (step / MIN), 0, 0); return +d; };

  // Live EPG: channels with an `epg` URL (Xtream Codes player_api.php JSON) get their real listings.
  const liveEpg = new Map();
  const b64 = s => { try { return new TextDecoder().decode(Uint8Array.from(atob(s || ''), c => c.charCodeAt(0))); } catch { return s || ''; } };

  async function loadEpg() {
    const all = [...new Set(state.channels.map(c => c.epg).filter(Boolean))];
    const urls = all.filter(u => !u.startsWith('iptv:'));
    const ids = all.filter(u => u.startsWith('iptv:')).map(u => u.slice(5));
    const batches = [];
    for (let i = 0; i < ids.length; i += 100) batches.push(ids.slice(i, i + 100));
    await Promise.all(batches.map(async batch => {
      try {
        const r = await fetch(`api/epg?ids=${encodeURIComponent(batch.join(','))}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        for (const [id, list] of Object.entries(await r.json())) if (list.length) liveEpg.set('iptv:' + id, list);
      } catch (err) { console.warn('XTV: could not load iptv-org guides', err); }
    }));
    await Promise.all(urls.map(async url => {
      try {
        const r = await fetch(viaProxy(url));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const list = ((await r.json()).epg_listings || []).map(p => ({
          start: p.start_timestamp * 1000, end: p.stop_timestamp * 1000, title: b64(p.title) || 'Untitled', desc: b64(p.description),
        })).filter(p => p.end > p.start).sort((a, b) => a.start - b.start);
        if (list.length) liveEpg.set(url, list);
      } catch (err) { console.warn('XTV: could not load EPG', url, err); }
    }));
    tick();
    if (state.mode === 'guide') renderGuide(false);
  }

  // Programs covering [from, to): live EPG or the channel's daily schedule, with gaps filled by hourly "live" blocks.
  function programs(ch, from, to) {
    let sched = [];
    const live = ch.epg && liveEpg.get(ch.epg);
    if (live) sched = live.filter(p => p.end > from && p.start < to);
    else if (ch.schedule.length) {
      const d = new Date(from); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 1);
      for (; +d < to; d.setDate(d.getDate() + 1)) {
        for (const p of ch.schedule) {
          if (Array.isArray(p.days) && p.days.length && !p.days.includes(d.getDay())) continue;
          const s = parseHM(p.start), e = parseHM(p.end);
          if (s == null || e == null) continue;
          const start = new Date(d); start.setHours(0, s, 0, 0);
          const end = new Date(d); end.setHours(0, e <= s ? e + 1440 : e, 0, 0);
          if (+end > from && +start < to) sched.push({ start: +start, end: +end, title: p.title || 'Untitled', desc: p.desc || '' });
        }
      }
      sched.sort((a, b) => a.start - b.start);
    }
    const filled = [];
    const fill = (a, b) => {
      while (a < b) {
        const h = new Date(a); h.setMinutes(60, 0, 0);
        const e = Math.min(+h, b);
        filled.push({ start: a, end: e, title: ch.defaultTitle || `${ch.name} Live`, desc: ch.description || '', filler: true });
        a = e;
      }
    };
    const aligned = floorTo(from, HOUR);
    let t = sched.length ? Math.min(aligned, sched[0].start) : aligned;
    for (const p of sched) {
      if (p.end <= t) continue;
      if (p.start > t) fill(t, p.start);
      filled.push({ ...p, start: Math.max(p.start, t) });
      t = p.end;
    }
    if (t < to) fill(t, to);
    return filled;
  }

  function nowNext(ch, at = Date.now()) {
    const ps = programs(ch, at - 6 * HOUR, at + 12 * HOUR);
    const now = ps.find(p => p.start <= at && p.end > at);
    const next = now ? ps.find(p => p.start >= now.end) : null;
    return { now, next };
  }

  const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtRange = p => `${fmtTime(p.start)} – ${fmtTime(p.end)}`;
  const pct = p => clamp((Date.now() - p.start) / (p.end - p.start), 0, 1);
  function fmtDur(ms) {
    const m = Math.max(0, Math.round(ms / MIN));
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  }
  function dayLabel(t) {
    const d = new Date(t), today = new Date();
    const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - today.setHours(0, 0, 0, 0)) / 864e5);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  /* ================= Rendering helpers ================= */

  function hue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  function initials(c) {
    if (c.callsign) return c.callsign.slice(0, 4).toUpperCase();
    const w = c.name.split(/\s+/).filter(Boolean);
    return (w.length > 1 ? w.slice(0, 3).map(x => x[0]).join('') : c.name.slice(0, 3)).toUpperCase();
  }
  function logoHTML(c) {
    return `<span class="logo" style="--hue:${hue(c.name)}"><em>${esc(initials(c))}</em>${c.logo ? `<img src="${esc(c.logo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
  }

  let toastTimer = 0;
  function toast(html, ms = 2200) {
    const t = $('#toast');
    t.innerHTML = html;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // Filters: where channels come from (All · Favorites · My channels · one per country), plus an
  // optional category picked from a dropdown, so the row stays short however big the lineup gets.
  const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
  const countryName = cc => { try { return regionNames?.of(cc === 'UK' ? 'GB' : cc) || cc; } catch { return cc; } };
  function filterList() {
    const fs = [{ id: 'all', label: 'All' }, { id: 'fav', label: '★ Favorites' }];
    const countries = [...new Set(state.channels.map(c => c.country).filter(Boolean))];
    if (countries.length) {
      if (state.channels.some(c => !c.source)) fs.push({ id: 'mine', label: 'My channels' });
      fs.push(...countries.map(cc => ({ id: 'c:' + cc, label: countryName(cc) })));
    }
    return fs;
  }
  const inSource = (c, f) => f === 'all' || (f === 'fav' ? state.favs.has(c.url) : f === 'mine' ? !c.source : 'c:' + c.country === f);
  // Search looks through every channel (filters are set aside while searching) by name, number,
  // category and country; best matches first.
  const fold = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  function searchScore(c, q) {
    if (String(c.number) === q) return 100;
    if (String(c.number).startsWith(q)) return 60;
    const name = fold(c.name);
    if (name === q) return 90;
    if (name.startsWith(q)) return 80;
    if (name.split(/[^a-z0-9]+/).some(w => w.startsWith(q))) return 70;
    if (name.includes(q)) return 50;
    if (fold(c.callsign).startsWith(q)) return 40;
    if (fold(c.group).includes(q) || (c.country && fold(countryName(c.country)).includes(q))) return 20;
    return 0;
  }
  function filtered() {
    const q = fold(state.q.trim());
    if (q) {
      return state.channels.map((c, i) => ({ c, i, s: searchScore(c, q) })).filter(r => r.s)
        .sort((a, b) => b.s - a.s || a.c.number - b.c.number);
    }
    const f = state.filter, cat = state.cat;
    return state.channels.map((c, i) => ({ c, i })).filter(({ c }) => inSource(c, f) && (!cat || c.group === cat));
  }

  // The search boxes in the Channels panel and the Guide share one query.
  function setSearch(q) {
    state.q = q;
    for (const el of $$('.g-search, .l-search')) if (el.value !== q) el.value = q;
    app.classList.toggle('searching', !!q.trim());
    if (state.mode === 'guide') { state.guide.row = 0; renderGuide(); }
    else if (state.mode === 'list') { state.listSel = 0; renderList(); }
  }
  function focusSearch() {
    if (state.mode !== 'guide' && state.mode !== 'list') openList();
    const el = $(state.mode === 'guide' ? '.g-search' : '.l-search');
    el.focus();
    el.select();
  }
  for (const el of $$('.g-search, .l-search')) {
    el.addEventListener('input', () => setSearch(el.value));
    el.addEventListener('keydown', e => {
      const guide = state.mode === 'guide';
      const rows = filtered();
      const move = d => {
        if (guide) guideMoveRow(d);
        else { state.listSel = clamp(state.listSel + d, 0, rows.length - 1); renderList(); }
      };
      switch (e.key) {
        case 'ArrowDown': move(1); break;
        case 'ArrowUp': move(-1); break;
        case 'PageDown': move(8); break;
        case 'PageUp': move(-8); break;
        case 'Enter':
          if (guide) guideSelect();
          else { const r = rows[state.listSel]; if (r) { setMode('tv'); tune(r.i); } }
          el.blur();
          break;
        case 'Escape': if (el.value) setSearch(''); else el.blur(); break;
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();
    });
  }
  function renderFilters(el) {
    const fs = filterList();
    if (!fs.some(f => f.id === state.filter)) state.filter = 'all';
    const cats = [...new Set(state.channels.filter(c => inSource(c, state.filter)).map(c => c.group))].sort();
    if (!cats.includes(state.cat)) state.cat = '';
    const html = fs.map(f => `<button type="button" data-f="${esc(f.id)}" class="${f.id === state.filter ? 'on' : ''}">${esc(f.label)}</button>`).join('')
      + (cats.length > 1 ? `<select class="f-cat${state.cat ? ' on' : ''}" aria-label="Category"><option value="">All categories</option>${
        cats.map(g => `<option${g === state.cat ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select>` : '');
    if (el.dataset.html === html) return; // unchanged: keep the dropdown's focus and scroll position
    el.dataset.html = html;
    el.innerHTML = html;
    $('button.on', el)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function cycleFilter(dir) {
    const fs = filterList();
    const i = fs.findIndex(f => f.id === state.filter);
    state.filter = fs[(i + dir + fs.length) % fs.length].id;
    state.cat = '';
  }

  /* ================= Static / signal ================= */

  const sc = $('#static'), sctx = sc.getContext('2d');
  const img = sctx.createImageData(sc.width, sc.height);
  const px = new Uint32Array(img.data.buffer);
  let staticOn = false;
  function drawStatic() {
    if (!staticOn) return;
    for (let i = 0; i < px.length; i++) { const v = (Math.random() * 255) | 0; px[i] = 0xff000000 | (v << 16) | (v << 8) | v; }
    sctx.putImageData(img, 0, 0);
    requestAnimationFrame(drawStatic);
  }
  function setSignal(kind, title = '', sub = '') {
    app.dataset.signal = kind || '';
    $('.signal-title').textContent = title;
    $('.signal-sub').textContent = sub;
    if (kind && !staticOn) { staticOn = true; drawStatic(); }
    else if (!kind) staticOn = false;
  }

  /* ================= Playback ================= */

  let hls = null, ts = null, tuneToken = 0, retryTimer = 0;
  let proxy = false; // true when served by server.js, which relays streams the way VLC fetches them

  const viaProxy = (u, ch) => {
    if (!proxy || !/^https?:\/\//i.test(u)) return u;
    const q = new URLSearchParams({ url: u });
    if (ch?.userAgent) q.set('ua', ch.userAgent);
    if (ch?.referrer) q.set('ref', ch.referrer);
    return 'proxy?' + q;
  };
  // Xtream Codes raw links (http://host/user/pass/123 or /live/user/pass/123.ts) and other .ts links are MPEG-TS.
  const XTREAM = /^(https?:\/\/[^/]+)\/(?:live\/)?([^/]+)\/([^/]+)\/(\d+)(?:\.ts)?$/i;
  const TS_CACHE = 3; // seconds buffered before (re)starting a relayed stream

  /* ---- Ad cover ---- */
  // server.js marks segments it can tell are ads (ad-break markers, Pluto/Google ad servers …) with
  // &ad=1. While one plays the picture is covered and the sound muted; it can't be skipped, since on
  // live TV the show hasn't been broadcast yet. "Show ad" uncovers the current break.
  let blockAds = store.get('blockAds', true), adOn = false, adEnd = 0, adShown = false, mutedBefore = false;
  function setAdCover(on, end = 0) {
    adEnd = end;
    if (on === adOn) return;
    adOn = on;
    if (on) { mutedBefore = video.muted; video.muted = true; }
    else video.muted = mutedBefore;
    app.classList.toggle('ad-break', on);
    syncVolumeUI();
    updateAdCountdown();
  }
  function onFragment(frag) {
    const isAd = /[?&]ad=1(&|$)/.test(frag.url || '');
    if (!isAd) { adShown = false; setAdCover(false); return; }
    // The break runs until the next segment that isn't an ad.
    const frags = hls?.levels?.[frag.level]?.details?.fragments || [];
    let end = frag.start + frag.duration;
    for (let i = frags.findIndex(f => f.sn === frag.sn) + 1; i > 0 && i < frags.length && /[?&]ad=1(&|$)/.test(frags[i].url); i++) end = frags[i].start + frags[i].duration;
    setAdCover(blockAds && !adShown, end);
  }
  function updateAdCountdown() {
    if (!adOn) return;
    const left = Math.round(adEnd - video.currentTime);
    $('.ad-left').textContent = left > 2 ? `Back in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Back in a moment';
  }
  $('.ad-show').addEventListener('click', () => { adShown = true; setAdCover(false); });

  /* ---- DVR: watch a few minutes behind live with the ad breaks cut out (server.js + dvr.js) ---- */
  // Live: the channel as it airs, ads covered where detectable. DVR: the server records the channel
  // (a list of segment links, kept in memory), we wait for a head start, then play the recording
  // with ads removed; every skipped break uses up some of the head start.
  let dvrOn = false;                               // every visit starts Live; DVR is switched on per visit
  const HEAD_STARTS = [5, 10, 15, 20, 30];        // minutes, as offered in Settings → Account
  let headStart = HEAD_STARTS.reduce((a, b) => Math.abs(b - store.get('dvrHead', 10)) < Math.abs(a - store.get('dvrHead', 10)) ? b : a);
  let dvr = null;                                  // { id, ch, status, playing, go }
  let dvrTimer = 0;
  const dvrSkip = new Set();                       // channels switched to live for this session
  const dvrResume = new Map();                     // url → { id, pos, at }: where you were in each recording
  const fmtClock = s => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const dvrEligible = ch => dvrOn && proxy && !dvrSkip.has(ch.url) && !needsTx.has(ch.url)
    && /\.m3u8?(\?|#|$)/i.test(ch.url) && !!window.Hls?.isSupported();
  function stopDvr() {
    clearTimeout(dvrTimer);
    dvr = null;
    app.classList.remove('dvr-wait', 'dvr-live');
  }
  // Seconds behind live: programme recorded but not watched yet.
  const dvrBehind = () => dvr?.status ? Math.max(0, dvr.status.kept - video.currentTime) : 0;
  // The head start is programme recorded (ads don't count: they're cut, so they can't be watched).
  function showDvrWait() {
    const need = headStart * 60, have = dvr?.status?.kept || 0;
    $('.dw-left').textContent = dvr?.status?.inAd
      ? `Ad break on now — it's being left out · ready in ${fmtClock(need - have)}`
      : `Ready in ${fmtClock(need - have)}`;
    $('.dw-bar i').style.width = `${Math.min(100, have / need * 100)}%`;
    app.classList.add('dvr-wait');
  }
  $('#dvrwait').addEventListener('click', e => {
    const b = e.target.closest('[data-dw]');
    if (!b || !dvr) return;
    if (b.dataset.dw === 'now') dvr.go = true;
    else { dvrSkip.add(dvr.ch.url); play(dvr.ch); }
  });
  function toggleDvr() {
    dvrOn = !dvrOn;
    syncDvrUI();
    dvrSkip.clear();
    toast(dvrOn ? `<b>DVR</b> — channels start ${headStart} min behind live, ads skipped where possible` : '<b>Live</b> — ads covered where possible', 3500);
    const ch = state.channels[state.cur];
    if (ch && state.mode !== 'splash') play(ch);
  }
  function syncDvrUI() {
    $('#remote [data-cmd="dvr"]')?.classList.toggle('on', dvrOn);
    for (const r of $$('.a-mode input')) r.checked = (r.value === 'dvr') === dvrOn;
    if ($('.a-head')) $('.a-head').value = String(headStart);
  }
  function togglePause() {
    if (!dvr?.playing) { toast('Pause works in DVR mode'); return; }
    if (video.paused) { video.play().catch(() => {}); toast('▶ Playing'); }
    else { video.pause(); toast('❚❚ Paused — still recording'); }
  }

  /* ---- Subtitles (CC) ---- */
  // Streams can carry a subtitle track (WebVTT) and/or captions embedded in the video (CEA-608).
  // With CC on we show exactly one: the subtitle track if there is one, else the embedded captions —
  // showing both is what made subtitles appear twice.
  let ccOn = store.get('cc', false), ccTimer = 0;
  const textTracks = () => [...video.textTracks].filter(t => t.kind === 'captions' || t.kind === 'subtitles');
  function applyCC() {
    const subs = ccOn && hls?.subtitleTracks?.length > 0; // the stream has a proper subtitle track
    if (hls) {
      hls.subtitleDisplay = subs;
      if (subs && hls.subtitleTrack < 0) {
        const en = hls.subtitleTracks.findIndex(t => /^en/i.test(t.lang || '') || /english/i.test(t.name || ''));
        hls.subtitleTrack = Math.max(0, en);
      } else if (!subs && hls.subtitleTracks?.length) hls.subtitleTrack = -1;
    }
    const caps = textTracks().filter(t => t.kind === 'captions');
    const pick = ccOn && !subs ? caps.find(t => t.cues?.length) || caps[0] : null;
    const set = (t, mode) => { if (t.mode !== mode) t.mode = mode; };
    for (const t of textTracks()) {
      if (!ccOn) set(t, 'disabled');
      else if (t.kind === 'subtitles') { if (!subs) set(t, 'disabled'); } // hls.js shows the chosen one
      else set(t, subs ? 'disabled' : t === pick ? 'showing' : 'hidden'); // hidden still collects cues
    }
    $('#remote [data-cmd="cc"]')?.classList.toggle('on', ccOn);
    clearInterval(ccTimer);
    if (ccOn) ccTimer = setInterval(applyCC, 2000); // embedded captions show up a little after tuning
  }
  video.textTracks.addEventListener('addtrack', () => applyCC());
  function toggleCC() {
    ccOn = !ccOn;
    store.set('cc', ccOn);
    applyCC();
    if (!ccOn) { toast('Subtitles off'); return; }
    toast('Subtitles on');
    setTimeout(() => {
      if (ccOn && !textTracks().some(t => t.mode === 'showing' || (t.kind === 'captions' && t.cues?.length)))
        toast('Subtitles on — none found on this channel yet', 3000);
    }, 4000);
  }
  let caps = {};      // what server.js can do, e.g. { ffmpeg: true }
  const needsTx = new Set(store.get('transcode2', [])); // stream URLs that play only after conversion
  store.del('transcode'); // older list: wrongly included streams with a separate audio track
  const isRawTs = u =>XTREAM.test(u) || /\.ts(\?|#|$)/i.test(u);

  function teardown() {
    if (hls) { hls.destroy(); hls = null; }
    if (ts) { ts.destroy(); ts = null; }
  }

  function stopPlayback() {
    tuneToken++;
    clearTimeout(retryTimer);
    adShown = false;
    setAdCover(false);
    stopDvr();
    teardown();
    video.pause();
    video.removeAttribute('src');
    video.load();
    app.classList.remove('buffering');
  }

  function play(ch, attempt = 0) {
    stopPlayback();
    const token = tuneToken;
    const alive = () => token === tuneToken;
    setSignal('tuning', attempt ? 'Reconnecting…' : 'Tuning…', `${ch.number} · ${ch.name}`);

    const start = () => video.play().catch(err => {
      if (!alive() || err.name !== 'NotAllowedError') return;
      video.muted = true;
      syncVolumeUI();
      video.play().catch(() => {});
      toast('Autoplay blocked — playing muted. Press <kbd>M</kbd> to unmute', 3500);
    });
    const watchPicture = () => setTimeout(() => {
      if (alive() && !video.videoWidth && video.buffered.length && !app.dataset.signal?.startsWith('nosignal')) toTx();
    }, 12000);
    const fail = (why) => {
      if (!alive()) return;
      teardown();
      setSignal('nosignal', 'No Signal', `${ch.number} · ${ch.name} — ${why}. Retrying…`);
      if (attempt === 2 && ch.source === 'iptv' && why === 'stream unreachable') fetch(`api/iptv/failed?url=${encodeURIComponent(ch.url)}`).catch(() => {});
      retryTimer = setTimeout(() => alive() && play(ch, attempt + 1), attempt < 3 ? 5000 : 15000);
    };

    // Raw MPEG-TS: relay it through server.js and play with mpegts.js (what VLC does). Without the
    // server, fall back to the HLS version an Xtream panel serves at /live/user/pass/123.m3u8.
    const tsOk = proxy && window.mpegts && mpegts.getFeatureList().mseLivePlayback;
    // Streams in formats browsers can't decode (e.g. MPEG-2 video, MP2/AC-3 audio) are converted by
    // server.js with ffmpeg; we find out when one plays without a picture, then remember it.
    const tx = tsOk && caps.ffmpeg && needsTx.has(ch.url);
    const toTx = () => {
      if (!alive() || tx || !tsOk || !caps.ffmpeg) return false;
      needsTx.add(ch.url);
      store.set('transcode2', [...needsTx]);
      console.info('XTV: converting', ch.name, 'with ffmpeg (format not playable in the browser)');
      play(ch, attempt);
      return true;
    };
    if ((tx || isRawTs(ch.url)) && tsOk && (tx || ch.type !== 'hls')) {
      const src = tx ? 'transcode' + viaProxy(ch.url, ch).slice(5) : viaProxy(ch.url, ch);
      // Like VLC's network caching: hold a few seconds in reserve and never skip ahead to the live edge.
      // Playing from a near-empty buffer makes the picture stall and jump every second.
      ts = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: new URL(src, location.href).href }, {
        enableWorker: true, lazyLoad: false, liveBufferLatencyChasing: false, liveSync: false,
        enableStashBuffer: true, stashInitialSize: 512 * 1024, autoCleanupSourceBuffer: true,
      });
      ts.on(mpegts.Events.ERROR, (type, detail) => {
        console.warn('XTV: mpegts', type, detail);
        if (type === mpegts.ErrorTypes.MEDIA_ERROR && toTx()) return;
        fail(type === mpegts.ErrorTypes.NETWORK_ERROR ? 'stream unreachable' : 'stream error');
      });
      const ahead = () => { const b = video.buffered; return b.length ? b.end(b.length - 1) - video.currentTime : 0; };
      let filling = 0;
      const fillThen = go => {
        if (filling) return;
        app.classList.add('buffering');
        const t0 = Date.now();
        filling = setInterval(() => {
          if (!alive()) { clearInterval(filling); return; }
          if (ahead() >= TS_CACHE || Date.now() - t0 > 15000) { clearInterval(filling); filling = 0; go(); }
        }, 200);
      };
      const onWaiting = () => { if (!alive()) return video.removeEventListener('waiting', onWaiting); if (!video.paused) { video.pause(); fillThen(() => video.play().catch(() => {})); } };
      video.addEventListener('waiting', onWaiting);
      ts.attachMediaElement(video);
      ts.load();
      // Providers send a burst of recent video (often a minute or more) on connect. Wait for the burst
      // to land, then jump once to TS_CACHE seconds behind its newest frame so we start near live.
      const startNearLive = () => {
        let last = -1;
        const t0 = Date.now();
        app.classList.add('buffering');
        filling = setInterval(() => {
          if (!alive()) { clearInterval(filling); return; }
          const b = video.buffered, end = b.length ? b.end(b.length - 1) : 0;
          const settled = end > 0 && end - last < 0.6; // grew less than ~real time in 500ms: burst is over
          last = end;
          if ((settled && end >= TS_CACHE) || Date.now() - t0 > 10000) {
            clearInterval(filling); filling = 0;
            if (b.length && end - video.currentTime > TS_CACHE + 1) video.currentTime = Math.max(b.start(b.length - 1), end - TS_CACHE);
            fillThen(start);
          }
        }, 500);
      };
      startNearLive();
      watchPicture();
      play.fail = fail;
      return;
    }
    if (dvrEligible(ch)) {
      play.fail = fail;
      playDvr(ch, { alive, start, fail });
      return;
    }
    const url = ch.url.replace(XTREAM, '$1/live/$2/$3/$4.m3u8');
    const isHls = /\.m3u8?(\?|#|$)/i.test(url) || ch.type === 'hls';
    if (isHls && window.Hls && Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode: true, backBufferLength: 30, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 3,
        enableCEA708Captions: true, enableWebVTT: true, enableIMSC1: true, subtitleDisplay: false,
      });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => applyCC());
      hls.on(Hls.Events.FRAG_CHANGED, (_, d) => alive() && onFragment(d.frag));
      let mediaRecoveries = 0;
      hls.on(Hls.Events.MANIFEST_PARSED, () => { if (alive()) { start(); watchPicture(); } });
      // No video track the browser can decode (e.g. MPEG-2): hand the stream to ffmpeg instead.
      // Streams with a separate audio track report audio first and video a moment later, so wait.
      let sawVideo = false;
      hls.on(Hls.Events.BUFFER_CODECS, (_, d) => {
        if (d.video || d.audiovideo) { sawVideo = true; return; }
        setTimeout(() => { if (alive() && !sawVideo) toTx(); }, 4000);
      });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!alive() || !d.fatal) return;
        if (/codec|demux|parsing/i.test(d.details) && toTx()) return;
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 2) hls.recoverMediaError();
        else fail(d.type === Hls.ErrorTypes.NETWORK_ERROR ? 'stream unreachable' : 'stream error');
      });
      hls.loadSource(viaProxy(url, ch));
      hls.attachMedia(video);
    } else if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
      fail('HLS not supported in this browser');
    } else {
      video.src = url;
      start();
    }
    play.fail = fail;
  }

  async function playDvr(ch, { alive, start, fail }) {
    let st;
    try { st = await api('dvr/start', 'POST', { url: ch.url, ua: ch.userAgent || '', ref: ch.referrer || '' }); }
    catch (err) {
      if (!alive()) return;
      toast(`DVR isn't available on ${esc(ch.name)} — watching live`, 3500);
      dvrSkip.add(ch.url);
      play(ch);
      return;
    }
    if (!alive()) return;
    dvr = { id: st.id, ch, status: st, playing: false, go: false };
    const need = headStart * 60;
    const prev = dvrResume.get(ch.url);
    const resumeAt = prev && prev.id === st.id && Date.now() - prev.at < 10 * MIN && prev.pos <= st.kept ? prev.pos : null;
    if (resumeAt != null) dvr.go = true; // the head start is already there
    const begin = () => {
      app.classList.remove('dvr-wait');
      setSignal('tuning', 'Starting…', `${ch.number} · ${ch.name}`);
      dvr.playing = true;
      app.classList.add('dvr-live');
      hls = new Hls({
        backBufferLength: 60, manifestLoadingMaxRetry: 3, levelLoadingMaxRetry: 4,
        // Pick up where you were (after a playback error, or coming back to the channel), else the head start.
        startPosition: resumeAt ?? Math.max(0, dvr.status.kept - need), // hls.js never jumps ahead to live on its own
        enableCEA708Captions: true, enableWebVTT: true, enableIMSC1: true, subtitleDisplay: false,
      });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => applyCC());
      hls.on(Hls.Events.MANIFEST_PARSED, () => alive() && start());
      let recoveries = 0;
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!alive() || !d.fatal) return;
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && recoveries++ < 3) hls.recoverMediaError();
        else fail(d.type === Hls.ErrorTypes.NETWORK_ERROR ? 'recording unreachable' : 'stream error');
      });
      hls.loadSource(`api/dvr/master.m3u8?id=${dvr.id}`);
      hls.attachMedia(video);
    };
    // Keep the recording alive and up to date; start once the head start is there (or on "Start now").
    const tick = async () => {
      if (!alive() || !dvr) return;
      try { dvr.status = await api(`dvr/status?id=${dvr.id}`); }
      catch (err) { if (!dvr.playing) { toast(`Recording stopped — watching live`, 3000); dvrSkip.add(ch.url); play(ch); return; } }
      if (!alive() || !dvr) return;
      if (!dvr.playing) {
        if (dvr.go || dvr.status.kept >= need) begin();
        else { setSignal(null); showDvrWait(); }
      } else if (video.currentTime > 0) dvrResume.set(ch.url, { id: dvr.id, pos: video.currentTime, at: Date.now() });
      if (dvr.playing && dvr.status.inAd && dvrBehind() < 2 && (video.readyState < 3 || app.classList.contains('buffering'))) {
        setSignal(null);
        setAdCover(true, 0); // caught up with live in the middle of a break: nothing to skip to yet
      } else if (adOn && !dvr.status.inAd) setAdCover(false);
      dvrTimer = setTimeout(tick, dvr.playing ? 4000 : 1000);
    };
    tick();
  }

  video.addEventListener('playing', () => { setSignal(null); app.classList.remove('buffering'); });
  video.addEventListener('waiting', () => app.classList.add('buffering'));
  video.addEventListener('canplay', () => app.classList.remove('buffering'));
  video.addEventListener('error', () => { if (!hls && !ts && video.getAttribute('src')) play.fail?.('stream unreachable'); });
  video.addEventListener('ended', () => { if (!hls && !ts) play.fail?.('off air'); else play.fail?.('broadcast ended'); });

  /* ================= Tuning ================= */

  function tune(i) {
    const n = state.channels.length;
    if (!n) return;
    i = ((i % n) + n) % n;
    if (i !== state.cur) {
      state.prev = state.cur;
      state.cur = i;
      store.set('last', state.channels[i].url);
      play(state.channels[i]);
    }
    showBanner();
    syncRemote();
    if (state.mode === 'list') renderList();
  }
  const chUp = () => tune(state.cur + 1);
  const chDown = () => tune(state.cur - 1);
  const lastCh = () => { if (state.prev >= 0 && state.prev < state.channels.length) tune(state.prev); else toast('No previous channel'); };

  function toggleFav(ch) {
    if (!ch) return;
    if (state.favs.has(ch.url)) { state.favs.delete(ch.url); toast(`Removed <b>${esc(ch.name)}</b> from Favorites`); }
    else { state.favs.add(ch.url); toast(`<span style="color:var(--gold)">★</span> Added <b>${esc(ch.name)}</b> to Favorites`); }
    saveFavs();
    updateBanner();
    syncRemote();
  }
  const saveFavs = () => api('site/favorites', 'PUT', { favs: [...state.favs] }).catch(err => console.warn('XTV: favorites not saved', err));

  /* ================= Banner ================= */

  let bannerTimer = 0;
  function updateBanner() {
    const ch = state.channels[state.cur];
    if (!ch) return;
    const { now, next } = nowNext(ch);
    $('.b-num').textContent = ch.number;
    const logoKey = ch.url + '|' + ch.logo + '|' + ch.name;
    if ($('.b-logo').dataset.key !== logoKey) { $('.b-logo').dataset.key = logoKey; $('.b-logo').innerHTML = logoHTML(ch); }
    $('.b-name').textContent = ch.name;
    const live = $('#banner .badge.live');
    if (dvr?.playing) { live.textContent = `DVR −${fmtClock(dvrBehind())}`; live.classList.add('dvr'); }
    else { live.textContent = 'LIVE'; live.classList.remove('dvr'); }
    $('.b-call').textContent = ch.callsign || '';
    $('.b-fav').classList.toggle('on', state.favs.has(ch.url));
    $('.b-title').textContent = now ? now.title : ch.name;
    $('.b-range').textContent = now ? fmtRange(now) : '';
    $('.b-left').textContent = now ? `${fmtDur(now.end - Date.now())} left` : '';
    $('#banner .progress i').style.width = now ? pct(now) * 100 + '%' : '0';
    $('.b-desc').textContent = now?.desc || '';
    $('.b-next span').textContent = next ? `${fmtTime(next.start)}  ${next.title}` : '—';
  }
  function showBanner(ms = 5000) {
    if (!state.channels[state.cur]) return;
    updateBanner();
    $('#banner').classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, ms);
  }
  function hideBanner() { $('#banner').classList.remove('show'); }

  /* ================= Number entry ================= */

  function digit(d) {
    state.num = (state.num + d).slice(-4);
    const el = $('#numentry');
    el.textContent = state.num;
    el.classList.add('show');
    clearTimeout(state.numTimer);
    state.numTimer = setTimeout(commitNum, 1600);
  }
  function commitNum() {
    clearTimeout(state.numTimer);
    $('#numentry').classList.remove('show');
    const n = parseInt(state.num, 10);
    state.num = '';
    if (!n) return;
    const i = state.channels.findIndex(c => c.number === n);
    if (i < 0) { toast(`Channel ${n} is not available`); return; }
    if (state.mode === 'guide') {
      let rows = filtered();
      if (!rows.some(r => r.i === i)) { state.filter = 'all'; rows = filtered(); }
      state.guide.row = rows.findIndex(r => r.i === i);
      state.guide.time = Date.now();
      state.guide.start = floorTo(Date.now(), HALF);
      renderGuide();
    } else {
      if (state.mode !== 'tv') setMode('tv');
      tune(i);
    }
  }

  /* ================= Guide ================= */

  function openGuide() {
    const n = Date.now();
    state.guide.start = floorTo(n, HALF);
    state.guide.time = n;
    const rows = filtered();
    state.guide.row = Math.max(0, rows.findIndex(r => r.i === state.cur));
    setMode('guide');
    renderGuide(true);
  }

  function guideRows() { return filtered(); }

  function progAt(ch, t) {
    return programs(ch, t - 12 * HOUR, t + 12 * HOUR).find(p => p.start <= t && p.end > t);
  }

  function renderGuide(scroll = true) {
    const g = state.guide;
    const rows = guideRows();
    renderFilters($('.g-filters'));
    const start = g.start, end = start + WINDOW, now = Date.now();
    $('.g-day').textContent = dayLabel(Math.max(start, now));
    $('.g-times').innerHTML = Array.from({ length: 6 }, (_, k) =>
      `<span style="left:${k / 6 * 100}%">${fmtTime(start + k * HALF)}</span>`).join('');

    const rowsEl = $('.g-rows');
    if (!rows.length) {
      rowsEl.innerHTML = `<div class="g-empty">${state.filter === 'fav' ? 'No favorites yet — press <kbd>S</kbd> on a channel to add it.' : 'No channels in this lineup.'}</div>`;
      updateGuideInfo(null, null);
      updateNowLine();
      return;
    }
    g.row = clamp(g.row, 0, rows.length - 1);
    // Only the rows in view (plus a margin) are drawn; spacers stand in for the rest, so the guide
    // stays fast with thousands of channels.
    const pitch = (parseFloat(getComputedStyle(rowsEl).getPropertyValue('--rowh')) || 64) + 4;
    const viewH = rowsEl.clientHeight || 600;
    if (scroll) {
      const top = g.row * pitch;
      if (top < rowsEl.scrollTop) rowsEl.scrollTop = top;
      else if (top + pitch > rowsEl.scrollTop + viewH) rowsEl.scrollTop = top + pitch - viewH;
    }
    const first = Math.max(0, Math.floor(rowsEl.scrollTop / pitch) - 8);
    const last = Math.min(rows.length, Math.ceil((rowsEl.scrollTop + viewH) / pitch) + 8);
    const selProg = progAt(rows[g.row].c, g.time);
    rowsEl.innerHTML = `<div style="height:${first * pitch}px"></div>` + rows.slice(first, last).map(({ c, i }, k) => {
      const r = first + k;
      const progs = programs(c, start, end).filter(p => p.end > start && p.start < end).map(p => {
        const l = Math.max(0, (p.start - start) / WINDOW * 100);
        const w = (Math.min(p.end, end) - Math.max(p.start, start)) / WINDOW * 100;
        const sel = r === g.row && p.start <= g.time && p.end > g.time;
        const cls = ['g-prog', sel && 'sel', p.start <= now && p.end > now && 'now', p.start < start && 'cont', p.filler && 'filler'].filter(Boolean).join(' ');
        return `<div class="${cls}" style="left:${l}%;width:${w}%" data-r="${r}" data-t="${Math.max(p.start, now)}"><b>${esc(p.title)}</b><small>${fmtRange(p)}</small></div>`;
      }).join('');
      return `<div class="g-row${r === g.row ? ' sel' : ''}${i === state.cur ? ' tuned' : ''}" data-r="${r}">
        <div class="g-ch" data-r="${r}"><span class="n">${c.number}</span>${logoHTML(c)}<span class="nm">${esc(c.name)}</span>${state.favs.has(c.url) ? '<span class="star">★</span>' : ''}</div>
        <div class="g-track">${progs}</div></div>`;
    }).join('') + `<div style="height:${(rows.length - last) * pitch}px"></div>`;

    updateGuideInfo(rows[g.row].c, selProg);
    updateNowLine();
  }
  let guideScrollRaf = 0;
  $('.g-rows').addEventListener('scroll', () => {
    if (state.mode !== 'guide' || guideScrollRaf) return;
    guideScrollRaf = requestAnimationFrame(() => {
      guideScrollRaf = 0;
      const el = $('.g-rows'), top = el.scrollTop;
      renderGuide(false);
      el.scrollTop = top;
    });
  }, { passive: true });

  function updateGuideInfo(ch, p) {
    $('.g-sel-chan').innerHTML = ch ? `${logoHTML(ch)}<span>${ch.number} · ${esc(ch.name)}</span>${ch.group ? `<span>· ${esc(ch.group)}</span>` : ''}` : '';
    $('.g-sel-title').textContent = p ? p.title : '';
    const now = Date.now();
    $('.g-sel-time').innerHTML = p
      ? `<span>${dayLabel(p.start)}, ${fmtRange(p)}</span>` +
        (p.start <= now ? `<span class="badge live">LIVE</span><span>${fmtDur(p.end - now)} left</span>` : `<span class="soon">Starts in ${fmtDur(p.start - now)}</span>`)
      : '';
    $('.g-sel-desc').textContent = p?.desc || ch?.description || '';
  }

  function updateNowLine() {
    const g = state.guide, now = Date.now();
    const f = (now - g.start) / WINDOW;
    const line = $('.g-nowline');
    line.style.display = f >= 0 && f <= 1 ? '' : 'none';
    line.style.setProperty('--now', f);
  }

  function guideMoveTime(dir) {
    const g = state.guide, rows = guideRows();
    if (!rows.length) return;
    const ch = rows[g.row].c, now = Date.now();
    const cur = progAt(ch, g.time);
    if (!cur) return;
    if (dir > 0) {
      if (cur.end > now + 24 * HOUR) return;
      g.time = cur.end;
    } else {
      if (cur.start <= now) return;
      const prev = progAt(ch, cur.start - 1);
      g.time = prev ? Math.max(prev.start, now) : now;
    }
    const minStart = floorTo(now, HALF);
    while (g.time >= g.start + WINDOW - HALF) g.start += HALF;
    while (g.time < g.start && g.start > minStart) g.start -= HALF;
    g.start = Math.max(g.start, minStart);
    renderGuide();
  }

  function guideMoveRow(d) {
    const rows = guideRows();
    if (!rows.length) return;
    state.guide.row = clamp(state.guide.row + d, 0, rows.length - 1);
    if (state.guide.time < Date.now()) state.guide.time = Date.now();
    renderGuide();
  }

  function guideSelect() {
    const rows = guideRows();
    const r = rows[state.guide.row];
    if (!r) return;
    const p = progAt(r.c, state.guide.time);
    setMode('tv');
    tune(r.i);
    if (p && p.start > Date.now()) toast(`<b>${esc(p.title)}</b> starts at ${fmtTime(p.start)}`, 3000);
  }

  $('.g-rows').addEventListener('click', e => {
    const ch = e.target.closest('.g-ch');
    const pr = e.target.closest('.g-prog');
    if (ch) { state.guide.row = +ch.dataset.r; guideSelect(); return; }
    if (pr) {
      const r = +pr.dataset.r, t = +pr.dataset.t;
      if (pr.classList.contains('sel')) { guideSelect(); return; }
      state.guide.row = r;
      state.guide.time = t;
      renderGuide(false);
    }
  });
  $('.g-filters').addEventListener('click', e => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    state.filter = b.dataset.f;
    state.cat = '';
    state.guide.row = 0;
    renderGuide();
  });
  $('.g-filters').addEventListener('change', e => {
    state.cat = e.target.value;
    state.guide.row = 0;
    renderGuide();
    e.target.blur();
  });

  /* ================= Channel list ================= */

  function openList() {
    const rows = filtered();
    state.listSel = Math.max(0, rows.findIndex(r => r.i === state.cur));
    setMode('list');
    renderList();
  }
  let listPitch = 0; // measured height of one list row incl. spacing
  function renderList(scroll = true) {
    const rows = filtered();
    renderFilters($('.l-filters'));
    $('.l-count').textContent = `${rows.length} of ${state.channels.length}`;
    state.listSel = clamp(state.listSel, 0, Math.max(0, rows.length - 1));
    const ul = $('.l-items');
    // Like the guide: draw only the rows in view, with spacers for the rest.
    const pitch = listPitch || 62, viewH = ul.clientHeight || 600;
    if (scroll) {
      const top = state.listSel * pitch;
      if (top < ul.scrollTop) ul.scrollTop = top;
      else if (top + pitch > ul.scrollTop + viewH) ul.scrollTop = top + pitch - viewH;
    }
    const first = Math.max(0, Math.floor(ul.scrollTop / pitch) - 8);
    const last = Math.min(rows.length, Math.ceil((ul.scrollTop + viewH) / pitch) + 8);
    const pad = h => `<li aria-hidden="true" style="height:${h}px;padding:0;margin:0;border:0;pointer-events:none"></li>`;
    ul.innerHTML = rows.length ? pad(first * pitch) + rows.slice(first, last).map(({ c, i }, k) => {
      const r = first + k;
      const { now } = nowNext(c);
      return `<li class="${r === state.listSel ? 'sel' : ''}${i === state.cur ? ' tuned' : ''}" data-r="${r}">
        <span class="ln">${c.number}</span>${logoHTML(c)}
        <span class="lt"><b>${esc(c.name)}</b><small>${now ? esc(now.title) + ' · ' + fmtTime(now.end) : ''}</small>
        <div class="progress"><i style="width:${now ? pct(now) * 100 : 0}%"></i></div></span>
        <button type="button" class="l-fav${state.favs.has(c.url) ? ' on' : ''}" data-fav="${r}" title="${state.favs.has(c.url) ? 'Remove from' : 'Add to'} Favorites (S)" aria-label="Favorite">★</button></li>`;
    }).join('') + pad((rows.length - last) * pitch) : `<li class="empty">${state.filter === 'fav' ? 'No favorites yet.' : 'No channels.'}</li>`;
    const items = ul.querySelectorAll('li[data-r]');
    const measured = items.length > 1 ? items[1].offsetTop - items[0].offsetTop : 0;
    if (measured > 0 && Math.abs(measured - pitch) > 0.5) { listPitch = measured; renderList(scroll); }
  }
  let listScrollRaf = 0;
  $('.l-items').addEventListener('scroll', () => {
    if (state.mode !== 'list' || listScrollRaf) return;
    listScrollRaf = requestAnimationFrame(() => { listScrollRaf = 0; const el = $('.l-items'), top = el.scrollTop; renderList(false); el.scrollTop = top; });
  }, { passive: true });
  $('.l-items').addEventListener('click', e => {
    const fav = e.target.closest('.l-fav');
    if (fav) {
      const r = filtered()[+fav.dataset.fav];
      if (r) { toggleFav(r.c); renderList(false); }
      return;
    }
    const li = e.target.closest('li[data-r]');
    if (!li) return;
    const r = filtered()[+li.dataset.r];
    if (r) { state.listSel = +li.dataset.r; setMode('tv'); tune(r.i); }
  });
  $('.l-filters').addEventListener('click', e => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    state.filter = b.dataset.f;
    state.cat = '';
    state.listSel = 0;
    renderList();
  });
  $('.l-filters').addEventListener('change', e => {
    state.cat = e.target.value;
    state.listSel = 0;
    renderList();
    e.target.blur();
  });

  /* ================= Lineup manager ================= */

  const mPanel = $('.m-panel'), form = $('.m-form');
  let editing = -1;

  function openManage(view) {
    setMode('manage');
    view = view || (me?.admin ? 'table' : 'account');
    if (view === 'account') openAccount(); else showManageView(view);
  }
  const TAB_OF = { table: 'table', form: 'table', import: 'table', countries: 'countries', status: 'status', users: 'users', account: 'account' };
  function showManageView(view) {
    mPanel.dataset.view = view;
    for (const t of $$('.m-tabs button')) t.classList.toggle('on', t.dataset.tab === TAB_OF[view]);
    const own = state.channels.filter(c => !c.source).length;
    const per = pickedCountries().map(cc => [cc, state.channels.filter(c => c.country === cc).length]).filter(([, n]) => n);
    $('.m-source').textContent = `${own} of your own${per.length ? ' · ' + per.map(([cc, n]) => `${countryName(cc)} ${n}`).join(' · ') : ''}`
      + (state.hiddenCount ? ` · ${state.hiddenCount} not working (hidden)` : '') + (state.checking ? ' · checking streams…' : '');
    if (view === 'table') renderManage();
  }
  function renderManage() {
    const tb = $('.m-table tbody');
    const own = state.channels.map((c, i) => ({ c, i })).filter(({ c }) => !c.source);
    tb.innerHTML = own.map(({ c, i }) => `<tr class="${i === state.cur ? 'tuned' : ''}">
      <td class="num">${c.number}</td><td>${logoHTML(c)}</td>
      <td><b>${esc(c.name)}</b>${state.favs.has(c.url) ? ' <span style="color:var(--gold)">★</span>' : ''}${c.schedule.length ? `<br><small style="color:var(--dim)">${c.schedule.length} scheduled</small>` : ''}</td>
      <td>${esc(c.group)}</td><td class="url" title="${esc(c.url)}">${esc(c.url)}</td>
      <td class="acts"><button data-act="watch" data-i="${i}" title="Watch">▶</button><button data-act="edit" data-i="${i}" title="Edit">✎</button><button data-act="del" class="del" data-i="${i}" title="Delete">✕</button></td></tr>`).join('');
    $('.m-scroll').classList.toggle('empty', !own.length);
  }

  const schedToText = s => s.map(p => `${p.start}-${p.end} ${p.title || ''}${p.desc ? ' | ' + p.desc : ''}${Array.isArray(p.days) && p.days.length ? ' @' + p.days.join(',') : ''}`).join('\n');
  function textToSched(t) {
    const out = [], bad = [];
    t.split(/\n/).map(l => l.trim()).filter(Boolean).forEach(l => {
      const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+(.*)$/.exec(l);
      if (!m) { bad.push(l); return; }
      let rest = m[3], days;
      const dm = /\s*@([\d,\s]+)$/.exec(rest);
      if (dm) { days = dm[1].split(',').map(Number).filter(n => n >= 0 && n <= 6); rest = rest.slice(0, dm.index); }
      const [title, ...d] = rest.split('|');
      out.push({ start: m[1], end: m[2], title: title.trim(), desc: d.join('|').trim(), ...(days?.length ? { days } : {}) });
    });
    return { out, bad };
  }

  function editChannel(i) {
    editing = i;
    const c = state.channels[i] || {};
    form.reset();
    for (const k of ['number', 'name', 'callsign', 'group', 'logo', 'url', 'defaultTitle', 'description', 'iptvId']) form.elements[k].value = c[k] ?? '';
    $('.iptv-hint').textContent = '';
    if (i < 0) form.elements.number.value = '';
    form.elements.schedule.value = schedToText(c.schedule || []);
    $('#groups').innerHTML = [...new Set(state.channels.map(x => x.group))].map(g => `<option value="${esc(g)}">`).join('');
    showManageView('form');
    form.elements.name.focus();
  }

  // iptv-org search in the channel form: type a name, pick a channel, empty fields get filled in.
  let iptvHits = [], iptvTimer = 0;
  form.elements.iptvId.addEventListener('input', e => {
    clearTimeout(iptvTimer);
    const q = e.target.value.trim();
    const hit = iptvHits.find(h => h.id === q);
    if (hit) {
      const f = form.elements;
      if (!f.name.value) f.name.value = hit.name;
      if (!f.logo.value) f.logo.value = hit.logo;
      if (!f.group.value && hit.categories[0]) f.group.value = hit.categories[0];
      $('.iptv-hint').textContent = iptvLabel(hit);
      return;
    }
    $('.iptv-hint').textContent = '';
    if (!proxy) { $('.iptv-hint').textContent = 'Search needs the XTV server (node server.js).'; return; }
    if (q.length < 2) return;
    iptvTimer = setTimeout(async () => {
      try {
        iptvHits = await (await fetch(`api/iptv/search?q=${encodeURIComponent(q)}`)).json();
        $('#iptv-hits').innerHTML = iptvHits.map(h => `<option value="${esc(h.id)}" label="${esc(iptvLabel(h))}">`).join('');
      } catch (err) { $('.iptv-hint').textContent = 'iptv-org search failed — see console.'; console.warn(err); }
    }, 250);
  });

  form.addEventListener('submit', e => {
    e.preventDefault();
    const f = form.elements;
    const { out: schedule, bad } = textToSched(f.schedule.value);
    if (bad.length) { toast(`Couldn't read schedule line: <code>${esc(bad[0])}</code>`, 4000); return; }
    const num = parseInt(f.number.value, 10);
    const clash = num && state.channels.findIndex((c, i) => c.number === num && i !== editing);
    if (num && clash >= 0) { toast(`Channel ${num} is already used by <b>${esc(state.channels[clash].name)}</b>`, 3500); return; }
    const ch = {
      number: num || 0, name: f.name.value.trim(), callsign: f.callsign.value.trim(), group: f.group.value.trim(),
      logo: f.logo.value.trim(), url: f.url.value.trim(), defaultTitle: f.defaultTitle.value.trim(),
      description: f.description.value.trim(), schedule, iptvId: f.iptvId.value.trim(),
    };
    if (!ch.iptvId) delete ch.iptvId;
    for (const k of ['epg', 'userAgent', 'referrer']) if (state.channels[editing]?.[k]) ch[k] = state.channels[editing][k];
    const curUrl = state.channels[state.cur]?.url, prevUrl = state.channels[state.prev]?.url;
    const old = state.channels[editing];
    const list = state.channels.slice();
    if (old) {
      list[editing] = ch;
      if (old.url !== ch.url && state.favs.delete(old.url)) { state.favs.add(ch.url); saveFavs(); }
    } else list.push(ch);
    state.channels = normalize(list);
    saveChannels();
    const retune = old && old.url === curUrl && old.url !== ch.url;
    reindex(retune ? ch.url : curUrl, prevUrl);
    if (retune && state.cur >= 0) play(state.channels[state.cur]);
    toast(`Saved <b>${esc(ch.name)}</b>`);
    showManageView('table');
  });

  function deleteChannel(i) {
    const c = state.channels[i];
    if (!c || !confirm(`Delete channel ${c.number} "${c.name}"?`)) return;
    const curUrl = state.channels[state.cur]?.url, prevUrl = state.channels[state.prev]?.url;
    state.channels.splice(i, 1);
    saveChannels();
    reindex(curUrl, prevUrl);
    if (curUrl === c.url) { stopPlayback(); setSignal('nosignal', 'No Channel', 'This channel was removed from the lineup'); }
    renderManage();
    showManageView('table');
  }

  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'audio/x-mpegurl' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function impMsg(text, kind = '') { const m = $('.imp-msg'); m.textContent = text; m.className = 'imp-msg ' + kind; }
  function doImport(text) {
    if (/#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/i.test(text)) {
      impMsg('That looks like a single HLS stream, not a channel list. Add its URL as a channel instead.', 'err');
      return;
    }
    const parsed = parseM3U(text);
    if (!parsed.length) { impMsg('No channels found in that playlist.', 'err'); return; }
    const replace = $('.imp-replace').checked;
    const curUrl = state.channels[state.cur]?.url, prevUrl = state.channels[state.prev]?.url;
    const base = replace ? [] : state.channels;
    const known = new Set(base.map(c => c.url));
    const fresh = parsed.filter(c => !known.has(c.url));
    state.channels = normalize(base.concat(fresh));
    saveChannels();
    reindex(curUrl, prevUrl);
    toast(`Imported ${fresh.length} channel${fresh.length === 1 ? '' : 's'}${parsed.length > fresh.length ? ` (${parsed.length - fresh.length} already in lineup)` : ''}`, 3500);
    $('.imp-text').value = '';
    impMsg('');
    showManageView('table');
  }

  $('#manage').addEventListener('click', async e => {
    if (e.target.id === 'manage') { setMode('tv'); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const i = +b.dataset.i;
    switch (b.dataset.act) {
      case 'close': setMode('tv'); break;
      case 'add': editChannel(-1); break;
      case 'edit': editChannel(i); break;
      case 'del': deleteChannel(i); break;
      case 'watch': setMode('tv'); tune(i); break;
      case 'cancel': showManageView('table'); break;
      case 'import': impMsg(''); showManageView('import'); $('.imp-text').focus(); break;
      case 'countries': openCountries(); break;
      case 'countries-apply': applyCountries(); break;
      case 'retry': retryStreams([statusRows()[i].url]); break;
      case 'retry-all': retryStreams(state.status.filter(s => s.status === 'dead').map(s => s.url)); break;
      case 'user-admin': setUser(b.dataset.name, { admin: b.dataset.admin === '1' }); break;
      case 'user-del':
        if (confirm(`Delete the account "${b.dataset.name}"?`)) setUser(b.dataset.name, null);
        break;
      case 'logout':
        await api('account/logout', 'POST').catch(() => {});
        location.reload();
        break;
      case 'export': download('xtv-lineup.m3u', toM3U(state.channels)); break;
      case 'reset':
        if (!confirm('Discard lineup changes and go back to the lineup in channels.js?')) return;
        await api('site/lineup', 'DELETE');
        await loadConfig();
        await loadLineup();
        iptvInfo.clear();
        enrichChannels();
        state.cur = -1; state.prev = -1;
        if (state.channels.length) tune(0);
        showManageView('table');
        break;
      case 'test': {
        const url = form.elements.url.value.trim();
        if (!url) { toast('Enter a stream URL first'); return; }
        play({ number: form.elements.number.value || '—', name: form.elements.name.value || 'Test', url });
        state.cur = -1;
        toast('Playing test stream behind this window');
        break;
      }
      case 'imp-go': doImport($('.imp-text').value); break;
      case 'imp-url': {
        const url = $('.imp-url').value.trim();
        if (!url) { impMsg('Enter a playlist URL.', 'err'); return; }
        impMsg('Loading…');
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          $('.imp-text').value = await r.text();
          impMsg('Loaded — review and press Import.', 'ok');
        } catch (err) { impMsg(`Couldn't load (${err.message}). The server may block cross-origin requests.`, 'err'); }
        break;
      }
    }
  });
  $('.imp-file').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    $('.imp-text').value = await f.text();
    impMsg(`Loaded ${f.name} — review and press Import.`, 'ok');
  });

  /* ================= Volume / fullscreen ================= */

  video.volume = clamp(store.get('vol', 0.8), 0, 1);
  function syncVolumeUI() {
    $('.r-vol').value = Math.round(video.volume * 100);
    $('.r-mute').textContent = video.muted || video.volume === 0 ? '🔇' : video.volume < .5 ? '🔉' : '🔊';
  }
  function volToast() {
    const v = video.muted ? 0 : Math.round(video.volume * 100);
    toast(`<span>${video.muted ? '🔇 Muted' : '🔊'}</span><div class="vol-bar"><i style="width:${v}%"></i></div><span style="font-variant-numeric:tabular-nums;width:2.5em;text-align:right">${v}</span>`, 1500);
  }
  function setVolume(v) {
    video.volume = clamp(v, 0, 1);
    video.muted = false;
    store.set('vol', video.volume);
    syncVolumeUI();
    volToast();
  }
  function toggleMute() { video.muted = !video.muted; syncVolumeUI(); volToast(); }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  /* ================= Modes & input ================= */

  function setMode(m) {
    state.mode = m;
    app.dataset.mode = m;
    if (m !== 'tv') hideBanner();
    if (m === 'tv') { app.classList.remove('show-remote'); }
  }

  function syncRemote() {
    const ch = state.channels[state.cur];
    $('#remote [data-cmd="fav"]')?.classList.toggle('on', !!ch && state.favs.has(ch.url));
  }

  const commands = {
    up: chUp, down: chDown, last: lastCh,
    guide: openGuide, list: openList,
    info: () => ($('#banner').classList.contains('show') ? hideBanner() : showBanner(8000)),
    fav: () => toggleFav(state.channels[state.cur]),
    mute: toggleMute, fullscreen: toggleFullscreen, cc: toggleCC, dvr: toggleDvr, pause: togglePause, search: () => focusSearch(),
    manage: () => openManage(), help: () => setMode('help'),
  };

  function powerOn() {
    if (state.mode !== 'splash') return;
    setMode('tv');
    screen.classList.remove('power-on'); void screen.offsetWidth; screen.classList.add('power-on');
    if (!state.channels.length) { openManage(); toast('Add your first channel to get started', 4000); return; }
    const last = store.get('last', null);
    const i = state.channels.findIndex(c => c.url === last);
    tune(i >= 0 ? i : 0);
  }

  function isTyping(e) { return e.target.closest?.('input, textarea, select, [contenteditable]'); }

  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const mode = state.mode;

    if (mode === 'auth') return;
    if (mode === 'splash') { e.preventDefault(); powerOn(); return; }
    if (mode === 'help') { e.preventDefault(); setMode('tv'); return; }
    if (mode === 'manage') {
      if (k === 'Escape' && !isTyping(e)) { e.preventDefault(); ['form', 'import'].includes(mPanel.dataset.view) ? showManageView('table') : setMode('tv'); }
      return;
    }
    if (isTyping(e)) return;

    if (/^[0-9]$/.test(k)) { e.preventDefault(); digit(k); return; }
    if (k === 'Enter' && state.num) { e.preventDefault(); commitNum(); return; }

    let handled = true;
    if (mode === 'tv') {
      switch (k) {
        case 'ArrowUp': case 'PageUp': case 'ChannelUp': chUp(); break;
        case 'ArrowDown': case 'PageDown': case 'ChannelDown': chDown(); break;
        case 'ArrowRight': case '+': case '=': case 'AudioVolumeUp': setVolume(video.volume + 0.05); break;
        case 'ArrowLeft': case '-': case '_': case 'AudioVolumeDown': setVolume(video.volume - 0.05); break;
        case 'Backspace': case 'r': case 'R': lastCh(); break;
        case 'g': case 'G': case 'F1': openGuide(); break;
        case 'Enter': case 'l': case 'L': openList(); break;
        case 'i': case 'I': commands.info(); break;
        case 's': case 'S': commands.fav(); break;
        case 'm': case 'M': case 'AudioVolumeMute': toggleMute(); break;
        case 'c': case 'C': toggleCC(); break;
        case 'd': case 'D': toggleDvr(); break;
        case ' ': case 'k': case 'K': case 'MediaPlayPause': togglePause(); break;
        case 'f': case 'F': toggleFullscreen(); break;
        case 'e': case 'E': openManage(); break;
        case 'h': case 'H': case '?': setMode('help'); break;
        case '/': focusSearch(); break;
        case 'Escape': hideBanner(); break;
        default: handled = false;
      }
    } else if (mode === 'guide') {
      switch (k) {
        case 'ArrowUp': guideMoveRow(-1); break;
        case 'ArrowDown': guideMoveRow(1); break;
        case 'PageUp': guideMoveRow(-8); break;
        case 'PageDown': guideMoveRow(8); break;
        case 'ArrowLeft': guideMoveTime(-1); break;
        case 'ArrowRight': guideMoveTime(1); break;
        case 'Enter': guideSelect(); break;
        case 'Tab': cycleFilter(e.shiftKey ? -1 : 1); state.guide.row = 0; renderGuide(); break;
        case 's': case 'S': { const r = guideRows()[state.guide.row]; if (r) { toggleFav(r.c); renderGuide(false); } break; }
        case 'Escape': case 'Backspace': case 'g': case 'G': setMode('tv'); break;
        case 'l': case 'L': openList(); break;
        case '/': focusSearch(); break;
        default: handled = false;
      }
    } else if (mode === 'list') {
      const rows = filtered();
      switch (k) {
        case 'ArrowUp': state.listSel = clamp(state.listSel - 1, 0, rows.length - 1); renderList(); break;
        case 'ArrowDown': state.listSel = clamp(state.listSel + 1, 0, rows.length - 1); renderList(); break;
        case 'PageUp': state.listSel = clamp(state.listSel - 8, 0, rows.length - 1); renderList(); break;
        case 'PageDown': state.listSel = clamp(state.listSel + 8, 0, rows.length - 1); renderList(); break;
        case 'ArrowLeft': case 'ArrowRight': case 'Tab': cycleFilter(k === 'ArrowLeft' || e.shiftKey ? -1 : 1); state.listSel = 0; renderList(); break;
        case 'Enter': { const r = rows[state.listSel]; if (r) { setMode('tv'); tune(r.i); } break; }
        case 's': case 'S': { const r = rows[state.listSel]; if (r) { toggleFav(r.c); renderList(); } break; }
        case 'Escape': case 'Backspace': case 'l': case 'L': setMode('tv'); break;
        case 'g': case 'G': openGuide(); break;
        case '/': focusSearch(); break;
        default: handled = false;
      }
    }
    if (handled) e.preventDefault();
  });

  // Mouse / touch
  $('#splash').addEventListener('click', powerOn);
  $('#help').addEventListener('click', () => setMode('tv'));
  /* ---- Right-click menu: channels in the Guide and Channels list, and the channel you're watching ---- */
  const ctx = $('#ctx');
  let ctxChan = null;
  function closeCtx() { ctx.classList.remove('open'); ctxChan = null; }
  function openCtx(x, y, { c, i }) {
    ctxChan = { c, i };
    const fav = state.favs.has(c.url);
    const item = (act, ic, label, cls = '') => `<button type="button" role="menuitem" data-x="${act}" class="${cls}"><span class="ic">${ic}</span>${label}</button>`;
    ctx.innerHTML = `<div class="ctx-head">${c.number} · ${esc(c.name)}</div>`
      + (i !== state.cur || state.mode !== 'tv' ? item('watch', '▶', 'Watch') : '')
      + item('fav', fav ? '★' : '☆', fav ? 'Remove from Favorites' : 'Add to Favorites', fav ? 'fav-on' : '')
      + (dvrOn && /\.m3u8?(\?|#|$)/i.test(c.url) ? item(dvrSkip.has(c.url) ? 'dvr' : 'live', '◉', dvrSkip.has(c.url) ? 'Watch with DVR (skip ads)' : 'Watch live instead') : '')
      + (me?.admin && !c.source ? '<hr>' + item('edit', '✎', 'Edit channel') : '');
    ctx.classList.add('open');
    const w = ctx.offsetWidth, h = ctx.offsetHeight;
    ctx.style.left = `${Math.min(x, innerWidth - w - 8)}px`;
    ctx.style.top = `${Math.min(y, innerHeight - h - 8)}px`;
  }
  document.addEventListener('contextmenu', e => {
    if (e.target.closest('input, textarea, #manage, #auth')) return;
    const el = e.target.closest('#guide [data-r], #list li[data-r]');
    let r = el ? filtered()[+el.dataset.r] : null;
    if (!r && e.target.closest('#screen, #banner') && state.mode === 'tv' && state.channels[state.cur]) r = { c: state.channels[state.cur], i: state.cur };
    if (!r) return;
    e.preventDefault();
    openCtx(e.clientX, e.clientY, r);
  });
  ctx.addEventListener('click', e => {
    const b = e.target.closest('button[data-x]');
    if (!b || !ctxChan) return;
    const { c, i } = ctxChan;
    closeCtx();
    const watch = () => { setMode('tv'); if (i === state.cur) play(c); else tune(i); };
    switch (b.dataset.x) {
      case 'watch': watch(); break;
      case 'fav':
        toggleFav(c);
        if (state.mode === 'guide') renderGuide(false); else if (state.mode === 'list') renderList(false);
        break;
      case 'live': dvrSkip.add(c.url); watch(); break;
      case 'dvr': dvrSkip.delete(c.url); watch(); break;
      case 'edit': openManage(); editChannel(i); break;
    }
  });
  document.addEventListener('pointerdown', e => { if (!e.target.closest('#ctx')) closeCtx(); }, true);
  document.addEventListener('keydown', e => { if (ctx.classList.contains('open') && e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeCtx(); } }, true);
  addEventListener('blur', closeCtx);
  $('.g-rows').addEventListener('scroll', closeCtx, { passive: true });
  $('.l-items').addEventListener('scroll', closeCtx, { passive: true });

  // Buttons with data-cmd (control bar, top-right corner, Guide / Channels headers) run the same commands as the keys.
  document.addEventListener('click', e => {
    const b = e.target.closest('button[data-cmd]');
    if (b && !b.closest('#manage')) commands[b.dataset.cmd]?.();
  });
  $('.r-vol').addEventListener('input', e => setVolume(e.target.value / 100));
  $('#banner').addEventListener('click', e => { if (e.target.closest('.b-fav')) commands.fav(); });

  let idleTimer = 0;
  function wake() {
    app.classList.remove('idle');
    if (state.mode === 'tv') app.classList.add('show-remote');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if ($('#remote').matches(':hover')) return wake();
      app.classList.remove('show-remote');
      if (state.mode === 'tv') app.classList.add('idle');
    }, 3000);
  }
  document.addEventListener('mousemove', wake);

  screen.addEventListener('click', () => {
    if (state.mode === 'guide') { setMode('tv'); return; }
    if (state.mode !== 'tv') return;
    wake();
    showBanner();
  });
  screen.addEventListener('dblclick', toggleFullscreen);
  // Clicking outside the list drawer closes it
  app.addEventListener('click', e => {
    if (state.mode === 'list' && !e.target.closest('#list')) setMode('tv');
  }, true);

  let touchY = null, touchT = 0;
  screen.addEventListener('touchstart', e => { touchY = e.touches[0].clientY; touchT = Date.now(); }, { passive: true });
  screen.addEventListener('touchend', e => {
    if (touchY == null || state.mode !== 'tv') return;
    const dy = e.changedTouches[0].clientY - touchY;
    touchY = null;
    if (Math.abs(dy) > 60 && Date.now() - touchT < 600) { dy < 0 ? chUp() : chDown(); }
    else wake();
  });

  /* ================= Clock ================= */

  function tick() {
    const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('.b-clock').textContent = t;
    $('.g-clock').textContent = t;
    if ($('#banner').classList.contains('show')) updateBanner();
    updateAdCountdown();
    if (state.mode === 'guide') {
      updateNowLine();
      // Roll the guide window forward once "now" moves past the first half hour.
      if (Date.now() >= state.guide.start + HALF && state.guide.time <= Date.now()) {
        state.guide.start = floorTo(Date.now(), HALF);
        state.guide.time = Date.now();
        renderGuide(false);
      }
    }
  }
  setInterval(tick, 1000);

  /* ================= Boot ================= */

  async function loadLineup() {
    state.custom = !!CFG.customLineup;
    let list = CFG.channels || [];
    if (!state.custom && CFG.playlistUrl) {
      try {
        const r = await fetch(CFG.playlistUrl);
        if (r.ok) list = list.concat(parseM3U(await r.text()));
      } catch (err) { console.warn('XTV: could not load playlistUrl', err); }
    }
    state.channels = normalize(list.concat(await iptvChannels(list)));
  }

  // iptv-org streams for the countries picked in Lineup → Countries, numbered from 1000 after your
  // own channels. Channels you already have (same iptv-org ID or stream URL) are skipped.
  const pickedCountries = () => CFG.countries || [];
  async function iptvChannels(own) {
    const countries = pickedCountries();
    if (!proxy || !countries.length) return [];
    let list;
    try {
      const r = await fetch(`api/iptv/streams?countries=${encodeURIComponent(countries.join(','))}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      list = await r.json();
    } catch (err) { console.warn('XTV: could not load iptv-org streams', err); toast('Couldn\'t load iptv-org channels — see console'); return []; }
    const haveId = new Set(own.map(c => c.iptvId).filter(Boolean)), haveUrl = new Set(own.map(c => c.url));
    let n = Math.max(999, ...own.map(c => parseInt(c.number, 10) || 0)), cc = null;
    const hide = CFG.hideBroken !== false;
    state.hiddenCount = 0;
    state.checking = list.some(c => c.health === 'unknown');
    return list.filter(c => !haveId.has(c.iptvId) && !haveUrl.has(c.url)).map(c => {
      if (c.country !== cc) { cc = c.country; n = Math.ceil((n + 1) / 1000) * 1000 - 1; }
      return {
      number: ++n, name: c.name, logo: c.logo, group: c.group, url: c.url, iptvId: c.iptvId, country: c.country, source: 'iptv',
      ...(c.userAgent && { userAgent: c.userAgent }), ...(c.referrer && { referrer: c.referrer }),
      ...(c.hasGuide && { epg: 'iptv:' + c.iptvId }),
      description: [c.quality, ...c.labels].filter(Boolean).join(' · '),
      health: c.health,
      };
    }).filter(c => {
      // Numbers are assigned before this, so hiding a channel leaves a gap instead of renumbering.
      if (hide && c.health === 'dead') { state.hiddenCount++; return false; }
      return true;
    });
  }

  // Streams are checked by server.js in the background (first run takes a few minutes). While that
  // runs, refresh the lineup now and then so broken channels drop out — only while just watching.
  let healthTimer = 0, healthDead = -1;
  function watchHealth() {
    clearTimeout(healthTimer);
    if (!proxy || !pickedCountries().length || CFG.hideBroken === false) return;
    healthTimer = setTimeout(async () => {
      let h;
      try { h = await (await fetch(`api/iptv/health?countries=${encodeURIComponent(pickedCountries().join(','))}`)).json(); }
      catch { watchHealth(); return; }
      if (h.dead !== healthDead && (state.mode === 'tv' || state.mode === 'splash')) {
        healthDead = h.dead;
        const curUrl = state.channels[state.cur]?.url, prevUrl = state.channels[state.prev]?.url;
        await loadLineup();
        reindex(curUrl, prevUrl);
      }
      if (h.checking || h.unknown) watchHealth();
    }, 20000);
  }

  /* ================= Settings tabs: channel status, users, account ================= */

  $('.m-tabs').addEventListener('click', e => {
    const t = e.target.closest('button[data-tab]');
    if (!t) return;
    ({ table: () => showManageView('table'), countries: openCountries, status: openStatus, users: openUsers, account: openAccount })[t.dataset.tab]();
  });

  // Channel status (admin): every channel's last check, with Retry. Channels that pass come back.
  state.status = [];
  let statusTimer = 0, statusWasChecking = false;
  async function openStatus() {
    showManageView('status');
    if (!state.status.length) $('.s-table tbody').innerHTML = '<tr><td colspan="4" class="m-note">Loading…</td></tr>';
    await refreshStatus();
  }
  async function refreshStatus() {
    clearTimeout(statusTimer);
    try { state.status = await api('site/channels'); } catch (err) { $('.s-sum').textContent = `Couldn't load: ${err.message}`; return; }
    renderStatus();
    const checking = state.status.some(s => s.status === 'checking');
    if (statusWasChecking && !checking) {
      // A round of checks just finished: rebuild the lineup so channels that now work are back.
      const before = state.channels.length, curUrl = state.channels[state.cur]?.url, prevUrl = state.channels[state.prev]?.url;
      await loadLineup();
      reindex(curUrl, prevUrl);
      const back = state.channels.length - before;
      toast(back > 0 ? `<b>${back}</b> channel${back === 1 ? '' : 's'} working again — back in the lineup` : 'Checks finished — no change', 3500);
    }
    statusWasChecking = checking;
    if (checking && state.mode === 'manage' && mPanel.dataset.view === 'status') statusTimer = setTimeout(refreshStatus, 2500);
  }
  function statusRows() {
    const want = $('.s-filter').value, q = fold($('.s-find').value.trim());
    return state.status.filter(s => (!want || s.status === want || (want === 'dead' && s.status === 'checking' && s.why))
      && (!q || fold(s.name).includes(q) || fold(s.url).includes(q)));
  }
  const ago = t => {
    if (!t) return '—';
    const m = Math.round((Date.now() - t) / MIN);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  };
  const STATUS_LABEL = { ok: 'Working', dead: 'Not working', unknown: 'Not checked', checking: 'Checking…' };
  function renderStatus() {
    const n = { ok: 0, dead: 0, unknown: 0, checking: 0 };
    for (const s of state.status) n[s.status]++;
    $('.s-sum').innerHTML = ['ok', 'dead', 'unknown', 'checking'].filter(k => n[k] || k !== 'checking')
      .map(k => `<span class="pill ${k}">${STATUS_LABEL[k]} <b>${n[k]}</b></span>`).join('');
    $('[data-act="retry-all"]').disabled = !n.dead;
    $('[data-act="retry-all"]').textContent = n.dead ? `Retry all ${n.dead} not working` : 'Retry all not working';
    const rows = statusRows(), shown = rows.slice(0, 300);
    $('.s-table tbody').innerHTML = shown.map((s, i) => `<tr>
      <td><b>${esc(s.name)}</b><small class="sub">${s.own ? 'Your channel' : esc(countryName(s.country))}</small></td>
      <td><span class="pill ${s.status}">${STATUS_LABEL[s.status]}</span>${s.why && s.status !== 'ok' ? `<small class="sub why">${esc(s.why)}</small>` : ''}</td>
      <td class="when">${ago(s.at)}</td>
      <td class="acts"><button class="btn small" data-act="retry" data-i="${i}"${s.status === 'checking' ? ' disabled' : ''}>${s.status === 'unknown' ? 'Check' : 'Retry'}</button></td></tr>`).join('')
      + (rows.length > shown.length ? `<tr><td colspan="4" class="m-note">Showing 300 of ${rows.length} — narrow it down with the search box.</td></tr>` : '')
      + (!rows.length ? '<tr><td colspan="4" class="m-note">Nothing here.</td></tr>' : '');
  }
  $('.s-filter').addEventListener('change', renderStatus);
  $('.s-find').addEventListener('input', renderStatus);
  async function retryStreams(urls) {
    if (!urls.length) return;
    try { await api('site/retry', 'POST', { urls }); } catch (err) { toast(esc(err.message), 3500); return; }
    toast(`Checking ${urls.length} channel${urls.length === 1 ? '' : 's'}…`);
    for (const s of state.status) if (urls.includes(s.url)) s.status = 'checking';
    statusWasChecking = true;
    renderStatus();
    statusTimer = setTimeout(refreshStatus, 1500);
  }

  // Users (admin): roles, removal, and whether new people can sign up.
  async function openUsers() {
    showManageView('users');
    $('.u-open').checked = CFG.registrationOpen !== false;
    let list;
    try { list = await api('site/users'); } catch (err) { $('.u-table tbody').innerHTML = `<tr><td colspan="4">${esc(err.message)}</td></tr>`; return; }
    $('.u-table tbody').innerHTML = list.sort((a, b) => b.admin - a.admin || a.name.localeCompare(b.name)).map(u => {
      const self = u.name.toLowerCase() === me.name.toLowerCase();
      return `<tr><td><b>${esc(u.name)}</b>${self ? ' <small class="tag">you</small>' : ''}</td>
        <td>${u.admin ? '<span class="pill ok">Admin</span>' : 'Viewer'}</td>
        <td class="when">${new Date(u.created).toLocaleDateString()}</td>
        <td class="acts">${self ? '' : `<button class="btn small" data-act="user-admin" data-name="${esc(u.name)}" data-admin="${u.admin ? 0 : 1}">${u.admin ? 'Remove admin' : 'Make admin'}</button>
          <button class="btn small ghost" data-act="user-del" data-name="${esc(u.name)}">Delete</button>`}</td></tr>`;
    }).join('');
  }
  async function setUser(name, change) {
    try {
      if (change) await api(`site/users?name=${encodeURIComponent(name)}`, 'PATCH', change);
      else await api(`site/users?name=${encodeURIComponent(name)}`, 'DELETE');
    } catch (err) { toast(esc(err.message), 3500); return; }
    openUsers();
  }
  $('.a-mode').addEventListener('change', e => {
    if ((e.target.value === 'dvr') !== dvrOn) toggleDvr();
  });
  $('.a-head').addEventListener('change', e => {
    headStart = +e.target.value;
    store.set('dvrHead', headStart);
    toast(`Head start: ${headStart} minutes`);
  });
  $('.a-ads').addEventListener('change', e => {
    blockAds = e.target.checked;
    store.set('blockAds', blockAds);
    if (!blockAds) setAdCover(false);
    toast(blockAds ? 'Ads will be covered where they can be detected' : 'Ads will play normally');
  });
  $('.u-open').addEventListener('change', async e => {
    try { Object.assign(CFG, await api('site/settings', 'PUT', { registrationOpen: e.target.checked })); toast(e.target.checked ? 'New accounts allowed' : 'New accounts switched off'); }
    catch (err) { toast(esc(err.message), 3500); e.target.checked = !e.target.checked; }
  });

  function openAccount() {
    showManageView('account');
    $('.a-who').innerHTML = `Signed in as <b>${esc(me.name)}</b>${me.admin ? ' <span class="pill ok">Admin</span>' : ''}`;
    $('.a-ads').checked = blockAds;
    syncDvrUI();
  }

  /* ================= Sign in / register ================= */

  function showAuth(acct) {
    setMode('auth');
    const f = $('#auth form');
    let mode = acct.setup ? 'register' : 'login';
    const sync = () => {
      $('.a-title').textContent = acct.setup ? 'Create the admin account' : mode === 'login' ? 'Sign in' : 'Create an account';
      $('.a-note').textContent = acct.setup ? 'This is the first account, so it will run the site: lineup, countries, channel status and users.' : '';
      f.querySelector('button[type=submit]').textContent = mode === 'login' ? 'Sign in' : 'Create account';
      f.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
      $('.a-switch').innerHTML = acct.setup ? '' : mode === 'login'
        ? (acct.registrationOpen ? 'New here? <a href="#" data-to="register">Create an account</a>' : '')
        : 'Have an account? <a href="#" data-to="login">Sign in</a>';
      $('.a-err').textContent = '';
    };
    $('.a-switch').addEventListener('click', e => { const a = e.target.closest('[data-to]'); if (a) { e.preventDefault(); mode = a.dataset.to; sync(); } });
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api(`account/${mode}`, 'POST', { name: f.name.value.trim(), password: f.password.value });
        location.reload();
      } catch (err) { $('.a-err').textContent = err.message; btn.disabled = false; }
    });
    sync();
    f.name.focus();
  }

  /* ================= Countries (iptv-org) ================= */

  async function openCountries() {
    showManageView('countries');
    const box = $('.c-list');
    if (!proxy) { box.innerHTML = '<p class="m-note">Needs the XTV server — start it with <code>node server.js</code>.</p>'; return; }
    box.innerHTML = '<p class="m-note">Loading countries…</p>';
    try {
      const list = await (await fetch('api/iptv/countries')).json();
      const on = new Set(pickedCountries());
      $('.c-hide').checked = CFG.hideBroken !== false;
      box.innerHTML = list.sort((a, b) => on.has(b.code) - on.has(a.code)).map(c => `<label class="check c-item" data-name="${esc(c.name.toLowerCase())} ${c.code.toLowerCase()}">
        <input type="checkbox" value="${c.code}"${on.has(c.code) ? ' checked' : ''}> <span><code>${c.code}</code> ${esc(c.name)}</span> <small>${c.count}</small></label>`).join('');
      countrySummary();
    } catch (err) { box.innerHTML = `<p class="m-note">Couldn't load countries (${esc(err.message)}).</p>`; }
  }
  function countrySummary() {
    const picked = $$('.c-list input:checked');
    const total = picked.reduce((n, i) => n + (+i.closest('label').querySelector('small').textContent || 0), 0);
    $('.c-sum').textContent = picked.length ? `${picked.length} selected · about ${total} channels` : 'None selected — only your own channels';
  }
  $('.c-list').addEventListener('change', countrySummary);
  $('.c-filter').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    for (const l of $$('.c-item')) l.hidden = !!q && !l.dataset.name.includes(q);
  });
  async function applyCountries() {
    try {
      Object.assign(CFG, await api('site/settings', 'PUT', { countries: $$('.c-list input:checked').map(i => i.value), hideBroken: $('.c-hide').checked }));
    } catch (err) { toast(`Couldn't save: ${esc(err.message)}`, 4000); return; }
    const curUrl = state.channels[state.cur]?.url, prevUrl = state.channels[state.prev]?.url;
    toast('Loading channels…');
    await loadLineup();
    reindex(curUrl, prevUrl);
    enrichChannels();
    loadEpg();
    toast(`Lineup now has <b>${state.channels.length}</b> channels`, 3000);
    healthDead = -1;
    watchHealth();
    showManageView('table');
  }

  (async () => {
    let acct;
    try { acct = await api('account/me'); } catch {
      setSignal('nosignal', 'Server not running', 'Start it with: node server.js — then reload this page');
      return;
    }
    if (!acct.user) { showAuth(acct); return; }
    try { await loadConfig(); } catch (err) { setSignal('nosignal', 'Couldn\'t load the site', err.message); return; }
    if (CFG.networkName) $$('.brand-name').forEach(el => { el.textContent = CFG.networkName; });
    document.title = CFG.networkName || 'XTV';
    proxy = true;
    try { caps = await api('caps'); } catch {}
    await loadLineup();
    enrichChannels();
    watchHealth();
    syncVolumeUI();
    applyCC();
    syncDvrUI();
    tick();
    loadEpg();
    setInterval(loadEpg, 30 * MIN);
    if (!window.Hls) console.warn('XTV: hls.js failed to load; only native HLS (Safari) and direct video links will play.');
  })();
})();
