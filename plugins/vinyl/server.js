// Identifies records playing near the microphone with AudD (audd.io), and shows them like Spotify.
// Built to stay inside a monthly request budget:
//  - only runs when switched on, and switches itself off after a set time
//  - one request per track: after a match it waits for the quiet gap before the next track
//    (or the track's expected end), and only tries when music has been playing for a few seconds
//  - misses wait 30 s; after 3 in a row it waits for the next track
//  - a monthly counter with a hard stop at the cap (resets on the 1st)
//  - skips identifying while the Spotify plugin says Spotify is playing (that's not the record)
const { renderVinyl, vnArtColours } = require('./public/render.js');

const CLIP_MS = 10000;           // sound sent per request
const MUSIC_MS = 3000;           // music this long before trying
const GAP_MS = 1200;             // quiet this long = gap between tracks
const MIN_TRACK_MS = 45000;      // ignore "gaps" this soon after a match (quiet passages)
const RETRY_MS = 30000;
const LOUD_DB = -45;

const monthKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

module.exports = tg => {
  const s = tg.settings;
  s.token ??= ''; s.cap ??= 1000; s.autoOffMin ??= 60; s.autoShow ??= true;
  s.usage ??= { month: monthKey(), count: 0 }; s.history ??= [];

  let active = false, until = 0, phase = 'off', status = 'Off', stopMic = null, offTimer = null;
  let track = null, misses = 0, retryAt = 0;
  let loudSince = 0, quietSince = 0, avgDb = null;
  const artCache = new Map();

  const used = () => { if (s.usage.month !== monthKey()) { s.usage = { month: monthKey(), count: 0 }; tg.save(); } return s.usage.count; };

  function turnOn() {
    if (!s.token) throw Object.assign(new Error('Add your AudD API token first.'), { status: 400 });
    if (used() >= s.cap) throw Object.assign(new Error(`This month's limit of ${s.cap} requests is used up.`), { status: 400 });
    active = true; phase = 'waiting'; misses = 0; retryAt = 0; loudSince = quietSince = 0;
    until = Date.now() + s.autoOffMin * 60000;
    tg.clear(offTimer);
    offTimer = tg.after(s.autoOffMin * 60000, () => turnOff(`Switched off after ${s.autoOffMin} minutes.`));
    status = 'Waiting for music…';
    if (!stopMic) stopMic = tg.mic.listen(onFrame);
    tg.log('Listening for records.');
    if (s.autoShow) tg.setLive(true);
  }
  function turnOff(reason) {
    active = false; phase = 'off'; status = reason || 'Off';
    tg.clear(offTimer); offTimer = null;
    if (stopMic) { stopMic(); stopMic = null; }
    tg.log('Stopped:', status);
  }

  function onFrame(f) {
    if (!active) return;
    const now = Date.now();
    const quiet = f.db < Math.min(LOUD_DB, (avgDb ?? -30) - 12);
    const loud = f.db > LOUD_DB && !quiet;
    if (loud) { loudSince ||= now; avgDb = avgDb == null ? f.db : avgDb * 0.995 + f.db * 0.005; }
    else loudSince = 0;
    if (quiet) quietSince ||= now; else quietSince = 0;
    const music = loudSince && now - loudSince > MUSIC_MS;
    const gap = quietSince && now - quietSince > GAP_MS;

    if (phase === 'identifying') return;
    if ((phase === 'playing' && gap && now - track.identifiedAt > MIN_TRACK_MS) || (phase === 'gaveup' && gap)) {
      phase = 'waiting'; status = 'Between tracks — waiting for the next one…';
      return;
    }
    if (phase === 'playing' && now > track.checkAt && music) return void identify();
    if (phase === 'waiting' && music && now >= retryAt) identify();
  }

  async function spotifyPlaying() {
    try {
      const r = await fetch(`http://127.0.0.1:${tg.port}/api/spotify/now`, { signal: AbortSignal.timeout(3000) });
      return r.ok && !!(await r.json()).playing;
    } catch { return false; }
  }

  // manual: "Identify now" — skips the music / gap / Spotify checks, and works while switched off (once).
  async function identify(manual = false) {
    const cancelled = () => !manual && !active;
    phase = 'identifying';
    try {
      if (!manual && await spotifyPlaying()) {
        status = 'Spotify is playing, so not identifying.'; retryAt = Date.now() + RETRY_MS; phase = 'waiting';
        return;
      }
      if (used() >= s.cap) return turnOff(`Stopped: this month's limit of ${s.cap} requests is used up.`);
      status = 'Listening to identify…';
      const wav = await tg.mic.record(CLIP_MS);
      if (cancelled()) return;
      s.usage.count++; tg.save();  // counted before sending, so the budget is never exceeded
      status = 'Identifying…';
      const form = new FormData();
      form.append('api_token', s.token);
      form.append('return', 'apple_music,spotify');
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'clip.wav');
      const r = await fetch('https://api.audd.io/', { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
      const d = await r.json();
      if (cancelled()) return;
      if (d.status !== 'success') return turnOff('AudD: ' + (d.error?.error_message || `error ${r.status}`));
      if (!d.result) {
        if (!active) { phase = 'off'; status = 'Not recognised.'; return; }
        misses++;
        if (misses >= 3) { phase = 'gaveup'; status = 'Couldn\'t identify it 3 times — waiting for the next track.'; }
        else { phase = 'waiting'; retryAt = Date.now() + RETRY_MS; status = 'Not recognised — trying again in 30 s.'; }
        return;
      }
      misses = 0;
      matched(d.result);
      if (!active) phase = 'off';
      if (manual && s.autoShow && !tg.isLive()) tg.setLive(true);
    } catch (e) {
      if (cancelled()) return;
      tg.log('Identify failed:', e.message);
      if (!active) { phase = 'off'; status = 'Problem: ' + e.message; return; }
      phase = 'waiting'; retryAt = Date.now() + RETRY_MS; status = 'Problem: ' + e.message + ' — trying again in 30 s.';
    }
  }
  function identifyNow() {
    if (!s.token) throw Object.assign(new Error('Add your AudD API token first.'), { status: 400 });
    if (phase === 'identifying') throw Object.assign(new Error('Already identifying — give it a few seconds.'), { status: 409 });
    if (used() >= s.cap) throw Object.assign(new Error(`This month's limit of ${s.cap} requests is used up.`), { status: 400 });
    identify(true);
  }

  function matched(res) {
    const now = Date.now();
    const imgs = res.spotify?.album?.images || [];
    const art = res.apple_music?.artwork?.url?.replace('{w}', '300').replace('{h}', '300')
      || (imgs.filter(i => (i.width || 640) >= 128).pop() || imgs[0])?.url || null;
    const duration = res.spotify?.duration_ms || res.apple_music?.durationInMillis || null;
    const [m, sec] = String(res.timecode || '').split(':').map(Number);
    const pos = Number.isFinite(m) && Number.isFinite(sec) ? (m * 60 + sec) * 1000 : null;
    const t = { title: res.title, artist: res.artist, album: res.album || '', year: (res.release_date || '').slice(0, 4),
      art, link: res.song_link || null, identifiedAt: now };
    const same = track && track.title === t.title && track.artist === t.artist;
    // Check again around the track's end if no gap is heard (e.g. tracks that run into each other).
    const left = duration && pos != null && duration < 20 * 60000 ? duration - pos - CLIP_MS : 4 * 60000;
    t.checkAt = now + Math.max(same ? 2 * 60000 : 60000, left + 15000);
    track = t; phase = 'playing';
    status = `${t.title} — ${t.artist}`;
    if (!same) {
      tg.log(`Identified: ${t.title} — ${t.artist} (${used()}/${s.cap} this month)`);
      s.history = [{ title: t.title, artist: t.artist, album: t.album, year: t.year, at: now }, ...s.history].slice(0, 20);
      tg.save();
      tg.update();
    }
  }

  async function artFor(url) {
    if (!url) return null;
    if (!artCache.has(url)) {
      try { artCache.set(url, vnArtColours(await tg.loadImage(url))); } catch { return null; }
      if (artCache.size > 30) artCache.delete(artCache.keys().next().value);
    }
    return artCache.get(url);
  }

  const localOnly = ctx => { if (!ctx.local) throw Object.assign(new Error('Change the AudD token on the PC itself.'), { status: 403 }); };
  const state = () => ({
    active, phase, status, until: active ? until : null, hasToken: !!s.token,
    used: used(), cap: s.cap, autoOffMin: s.autoOffMin, autoShow: s.autoShow,
    track: track && { title: track.title, artist: track.artist, album: track.album, year: track.year, art: track.art, link: track.link },
    history: s.history.slice(0, 8),
  });

  return {
    render: async () => renderVinyl(track, track ? await artFor(track.art) : null, active ? status : 'Switched off'),
    state,
    routes: {
      'POST /on': () => { turnOn(); return state(); },
      'POST /off': () => { turnOff(); return state(); },
      'POST /now': () => { identifyNow(); return state(); },
      'POST /options': ctx => {
        const b = ctx.body || {};
        if (typeof b.token === 'string') { localOnly(ctx); s.token = b.token.trim(); }
        if (Number.isFinite(b.cap) && b.cap >= 0) s.cap = Math.round(b.cap);
        if (Number.isFinite(b.autoOffMin) && b.autoOffMin >= 5 && b.autoOffMin <= 720) s.autoOffMin = Math.round(b.autoOffMin);
        if (typeof b.autoShow === 'boolean') s.autoShow = b.autoShow;
        tg.save();
        return state();
      },
      // Album art for the page's previews (only the current track's image).
      'GET /art': async ({ query, res }) => {
        const u = query.get('u');
        if (!track || u !== track.art) throw Object.assign(new Error('Unknown image'), { status: 404 });
        const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'max-age=86400' });
        res.end(Buffer.from(await r.arrayBuffer()));
      },
    },
    actions: {
      listen: { label: 'identify records on/off', run: ({ on } = {}) => ((on ?? !active) ? turnOn() : turnOff()) },
      now: { label: 'identify what\'s playing now', run: () => identifyNow() },
    },
    stop: () => { active = false; stopMic = null; },
  };
};
