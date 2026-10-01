// Identifies records playing near the microphone with AudD (audd.io) and/or ACRCloud (acrcloud.com),
// and shows them like Spotify.
// Built to stay inside a monthly request budget:
//  - only runs when switched on, and switches itself off after a set time
//  - one request per track: after a match it waits for the quiet gap before the next track
//    (or the track's expected end), and only tries when music has been playing for a few seconds
//  - misses wait 30 s; after 3 in a row it waits for the next track
//  - a monthly counter with a hard stop at the cap (resets on the 1st)
//  - skips identifying while the Spotify plugin says Spotify is playing (that's not the record)
const crypto = require('crypto');
const { renderVinyl, vnArtColours } = require('./public/render.js');

const CLIP_SECS = [10, 12];      // choices for the sound sent per request (AudD's standard API uses about 12 s at most)
const MUSIC_MS = 3000;           // music this long before trying
const GAP_MS = 1200;             // quiet this long = gap between tracks
const MIN_TRACK_MS = 45000;      // ignore "gaps" this soon after a match (quiet passages)
const RETRY_MS = 30000;
const LOUD_DB = -45;

// Cleans up a clip before it's sent (on by default): cuts everything below 120 Hz (boom from big
// speakers, turntable rumble, mains hum), lifts 2-4 kHz a little, and raises the level so peaks reach
// -1 dBFS (by at most 18 dB). AudD matches mostly on the mids and highs.
function cleanClip(wav) {
  const rate = wav.readUInt32LE(24), at = 44, n = (wav.length - at) >> 1;   // mic.record()'s 44-byte WAV header
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = wav.readInt16LE(at + i * 2);
  const biquad = (b0, b1, b2, a1, a2) => {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) { const v = x[i], y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = y; x[i] = y; }
  };
  const highPass = (f, q) => {
    const w = 2 * Math.PI * f / rate, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    biquad((1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0);
  };
  const lift = (f, q, gainDb) => {
    const A = 10 ** (gainDb / 40), w = 2 * Math.PI * f / rate, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al / A;
    biquad((1 + al * A) / a0, -2 * c / a0, (1 - al * A) / a0, -2 * c / a0, (1 - al / A) / a0);
  };
  highPass(120, 0.5412); highPass(120, 1.3065);   // two stages = 4th-order Butterworth
  lift(3000, 0.8, 4);
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const gain = peak ? Math.min(8, 0.89 * 32767 / peak) : 1;
  const out = Buffer.from(wav);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * gain))), at + i * 2);
  return out;
}

// ACRCloud project hosts look like identify-eu-west-1.acrcloud.com (keys are only ever sent there).
const ACR_HOST = /^identify-[a-z0-9-]+\.acrcloud\.com$/;
const PROVIDERS = ['audd', 'acr', 'both'];   // both: AudD first, ACRCloud when AudD finds nothing

const monthKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

module.exports = tg => {
  const s = tg.settings;
  s.token ??= ''; s.cap ??= 1000; s.autoOffMin ??= 60; s.autoShow ??= true; s.cleanClip ??= true; if (!CLIP_SECS.includes(s.clipSec)) s.clipSec = 12;
  s.usage ??= { month: monthKey(), count: 0 }; s.history ??= [];
  s.provider ??= 'audd'; s.acr ??= { host: '', key: '', secret: '' }; s.acrCap ??= 300;
  s.acrUsage ??= { month: monthKey(), count: 0 };
  // Start the listening log with the songs identified before it existed (once).
  if (!s.historyLogged && tg.listening.available) {
    for (const h of [...s.history].reverse()) {
      try { tg.listening.add({ at: h.at, title: h.title, artist: h.artist, album: h.album, year: h.year, spotify_url: h.spotify, force: true }); } catch {}
    }
    s.historyLogged = true; tg.save();
  }

  let active = false, until = 0, phase = 'off', status = 'Off', stopMic = null, offTimer = null;
  let track = null, misses = 0, retryAt = 0;
  // The last clip sent to AudD and its answer, for checking what it hears (memory only, replaced each time).
  let lastClip = null;   // { wav, at, outcome }
  let showOn;                    // the Times Gate it was started from (shown there if autoShow)
  let loudSince = 0, quietSince = 0, avgDb = null, power = 0;  // power: smoothed loudness (linear)
  const artCache = new Map();

  // Monthly request counters, one per service (reset on the 1st).
  const counter = k => { if (s[k].month !== monthKey()) { s[k] = { month: monthKey(), count: 0 }; tg.save(); } return s[k].count; };
  const used = () => counter('usage'), acrUsed = () => counter('acrUsage');

  // The recognition services. ask(wav) resolves to { result } (a match in the shape below, or null for
  // no match) or { error }. A service that answers with an error (bad key, trial used up…) is left out
  // until listening is switched on again.
  //   result: { title, artist, album, year, durationMs, posMs, isrc, label, spotify, art, link }
  const SERVICES = {
    audd: { name: 'AudD', ready: () => !!s.token, left: () => s.cap - used(), count: () => { s.usage.count++; }, ask: askAudd },
    acr: { name: 'ACRCloud', ready: () => !!(ACR_HOST.test(s.acr.host) && s.acr.key && s.acr.secret), left: () => s.acrCap - acrUsed(),
      count: () => { s.acrUsage.count++; }, ask: askAcr },
  };
  let failed = {};   // service → its error, for this listening session
  const chosen = () => (s.provider === 'both' ? ['audd', 'acr'] : [s.provider]).filter(k => SERVICES[k].ready());
  const usable = () => chosen().filter(k => !failed[k] && SERVICES[k].left() > 0);
  // Why nothing can be sent (or null if something can).
  function blocked() {
    if (!chosen().length) return s.provider === 'audd' ? 'Add your AudD API token first.' : s.provider === 'acr' ? 'Add your ACRCloud keys first.' : 'Add an AudD token or ACRCloud keys first.';
    if (usable().length) return null;
    const errs = chosen().filter(k => failed[k]).map(k => `${SERVICES[k].name}: ${failed[k]}`);
    return errs.length ? errs.join(' · ') : 'This month\'s request limit is used up.';
  }

  async function askAudd(wav) {
    const form = new FormData();
    form.append('api_token', s.token);
    form.append('return', 'apple_music,spotify');
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'clip.wav');
    const r = await fetch('https://api.audd.io/', { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
    const d = await r.json();
    if (d.status !== 'success') return { error: d.error?.error_message || `error ${r.status}` };
    const res = d.result;
    if (!res) return { result: null };
    const imgs = res.spotify?.album?.images || [];
    const [m, sec] = String(res.timecode || '').split(':').map(Number);
    return { result: {
      title: res.title, artist: res.artist, album: res.album || '', year: (res.release_date || '').slice(0, 4),
      durationMs: res.spotify?.duration_ms || res.apple_music?.durationInMillis || null,
      posMs: Number.isFinite(m) && Number.isFinite(sec) ? (m * 60 + sec) * 1000 : null,
      isrc: res.spotify?.external_ids?.isrc || res.apple_music?.isrc || null, label: res.label || null,
      spotify: res.spotify?.external_urls?.spotify || null, link: res.song_link || null,
      art: res.apple_music?.artwork?.url?.replace('{w}', '300').replace('{h}', '300')
        || (imgs.filter(i => (i.width || 640) >= 128).pop() || imgs[0])?.url || null,
    } };
  }

  // ACRCloud's identify API: a signed multipart POST to the project's host.
  async function askAcr(wav) {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac('sha1', s.acr.secret)
      .update(['POST', '/v1/identify', s.acr.key, 'audio', '1', ts].join('\n')).digest('base64');
    const form = new FormData();
    form.append('sample', new Blob([wav], { type: 'audio/wav' }), 'clip.wav');
    form.append('sample_bytes', String(wav.length));
    form.append('access_key', s.acr.key);
    form.append('data_type', 'audio');
    form.append('signature_version', '1');
    form.append('signature', signature);
    form.append('timestamp', ts);
    const r = await fetch(`https://${s.acr.host}/v1/identify`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
    const d = await r.json();
    const code = d.status?.code;
    if (code === 1001) return { result: null };   // no result
    if (code !== 0) return { error: `${d.status?.msg || 'error'} (${code ?? r.status})` };
    const m = d.metadata?.music?.[0];
    if (!m) return { result: null };
    const spId = m.external_metadata?.spotify?.track?.id;
    return { result: {
      title: m.title, artist: (m.artists || []).map(a => a.name).join(', '), album: m.album?.name || '',
      year: (m.release_date || '').slice(0, 4), durationMs: m.duration_ms || null, posMs: m.play_offset_ms ?? null,
      isrc: m.external_ids?.isrc || null, label: m.label || null,
      spotify: spId ? `https://open.spotify.com/track/${spId}` : null, link: null, art: null,   // art: looked up from Spotify
    } };
  }

  function turnOn(unit) {
    showOn = unit;
    failed = {};
    const why = blocked();
    if (why) throw Object.assign(new Error(why), { status: 400 });
    active = true; phase = 'waiting'; misses = 0; retryAt = 0; loudSince = quietSince = 0; power = 0;
    until = Date.now() + s.autoOffMin * 60000;
    tg.clear(offTimer);
    offTimer = tg.after(s.autoOffMin * 60000, () => turnOff(`Switched off after ${s.autoOffMin} minutes.`));
    status = 'Waiting for music…';
    if (!stopMic) stopMic = tg.mic.listen(onFrame);
    tg.log('Listening for records.');
    if (s.autoShow) tg.setLive(true, showOn);
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
    // "Music" goes by the loudness averaged over about a second, so the brief dips between beats
    // don't restart the count (quieter mics hover near LOUD_DB). Gaps still go by each moment.
    power = power * (1 - 1 / 43) + 10 ** (f.db / 10) / 43;
    const smoothDb = 10 * Math.log10(power || 1e-10);
    const quiet = f.db < Math.min(LOUD_DB, (avgDb ?? -30) - 12);
    const loud = smoothDb > LOUD_DB;
    if (loud) { loudSince ||= now; avgDb = avgDb == null ? smoothDb : avgDb * 0.995 + smoothDb * 0.005; }
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
      const why = blocked();
      if (why) { if (active) return turnOff('Stopped: ' + why); phase = 'off'; status = why; return; }
      status = 'Listening to identify…';
      const raw = await tg.mic.record(s.clipSec * 1000);
      const wav = s.cleanClip ? cleanClip(raw) : raw;
      lastClip = { wav, at: Date.now(), outcome: 'sending…', cleaned: s.cleanClip };
      if (cancelled()) return;
      // Ask each chosen service in turn until one matches.
      const notes = [];
      let found = null, answered = false;
      for (const k of usable()) {
        const sv = SERVICES[k];
        sv.count(); tg.save();   // counted before sending, so the budget is never exceeded
        status = `Identifying (${sv.name})…`;
        let a;
        try { a = await sv.ask(wav); }
        catch (e) { a = { error: e.name === 'TimeoutError' ? 'no answer (timeout)' : e.message, passing: true }; }  // network trouble: try again later
        if (a.error) {
          notes.push(`${sv.name}: ${a.error}`); tg.log(`${sv.name}: ${a.error}`);
          if (!a.passing) failed[k] = a.error;   // the service said no (bad key, trial used up…)
          continue;
        }
        answered = true;
        if (a.result) { found = { ...a.result, service: sv.name }; notes.push(`${sv.name}: matched ${found.title} — ${found.artist}`); break; }
        notes.push(`${sv.name}: no match`);
      }
      lastClip.outcome = notes.join(' · ') || 'not sent';
      if (cancelled()) return;
      if (!answered) {   // every service failed: a refusal stops listening, network trouble retries
        const msg = notes.join(' · ') || 'Nothing to send to';
        if (!usable().length) { if (active) return turnOff('Stopped: ' + msg); phase = 'off'; status = msg; return; }
        throw new Error(msg);
      }
      if (!found) {
        if (!active) { phase = 'off'; status = 'Not recognised.'; return; }
        misses++;
        if (misses >= 3) { phase = 'gaveup'; status = 'Couldn\'t identify it 3 times — waiting for the next track.'; }
        else { phase = 'waiting'; retryAt = Date.now() + RETRY_MS; status = 'Not recognised — trying again in 30 s.'; }
        return;
      }
      misses = 0;
      matched(found).catch(e => tg.log('Saving the match failed:', e.message));   // (finishes in the background)
      if (!active) phase = 'off';
      if (manual && s.autoShow && !tg.isLive()) tg.setLive(true, showOn);
    } catch (e) {
      if (cancelled()) return;
      if (lastClip && lastClip.outcome === 'sending…') lastClip.outcome = 'failed: ' + e.message;
      tg.log('Identify failed:', e.message);
      if (!active) { phase = 'off'; status = 'Problem: ' + e.message; return; }
      phase = 'waiting'; retryAt = Date.now() + RETRY_MS; status = 'Problem: ' + e.message + ' — trying again in 30 s.';
    }
  }
  function identifyNow(unit) {
    if (!active) showOn = unit;
    if (phase === 'identifying') throw Object.assign(new Error('Already identifying — give it a few seconds.'), { status: 409 });
    if (!active) failed = {};   // a fresh try
    const why = blocked();
    if (why) throw Object.assign(new Error(why), { status: 400 });
    identify(true);
  }

  // Names that arrive all in lowercase (some ACRCloud entries) get capitals: "bicycle race" → "Bicycle Race".
  // Anything with a capital already is left alone.
  const tidy = v => (v && v === v.toLowerCase() && /\p{Ll}/u.test(v)
    ? v.replace(/(^|[\s(\[\-"/&.])(\p{Ll})/gu, (m, before, c) => before + c.toUpperCase()) : v || '');

  // res: a match from either service (see SERVICES). Shown straight away; the Spotify link and cover
  // are filled in if missing, before it goes into the history and listening log.
  async function matched(res) {
    const now = Date.now(), pos = res.posMs;
    const t = { title: tidy(res.title), artist: tidy(res.artist), album: tidy(res.album), year: res.year, art: res.art, link: res.link,
      spotify: res.spotify, service: res.service, identifiedAt: now };
    const same = track && track.title === t.title && track.artist === t.artist;
    // Check again around the track's end if no gap is heard (e.g. tracks that run into each other).
    const checkAt = duration => now + Math.max(same ? 2 * 60000 : 60000,
      (duration && pos != null && duration < 20 * 60000 ? duration - pos - s.clipSec * 1000 : 4 * 60000) + 15000);
    t.checkAt = checkAt(res.durationMs);
    track = t; phase = 'playing';
    status = `${t.title} — ${t.artist}`;
    if (same) return;
    tg.log(`Identified by ${t.service}: ${t.title} — ${t.artist} (AudD ${used()}/${s.cap}, ACRCloud ${acrUsed()}/${s.acrCap} this month)`);
    tg.update();
    const extra = !t.art || !t.spotify ? await fillIn(t) : {};
    if (!res.durationMs && extra.duration) t.checkAt = checkAt(extra.duration);
    s.history = [{ title: t.title, artist: t.artist, album: t.album, year: t.year, spotify: t.spotify, at: now }, ...s.history].slice(0, 20);
    // The all-time listening log (data/listening.db).
    try {
      tg.listening.add({ at: now, title: t.title, artist: t.artist, album: t.album, year: t.year, duration_ms: res.durationMs || extra.duration,
        isrc: res.isrc || extra.isrc, spotify_url: t.spotify, label: res.label });
    } catch (e) { tg.log('Listening log:', e.message); }
    tg.save();
    if (track === t && t.art) tg.update();
  }

  // Fills in a match's missing Spotify link and cover, in this order: Spotify's oEmbed (the cover, from
  // a link), a search through the Spotify plugin (link, cover, ISRC and length, if Spotify is
  // connected), then Apple's iTunes Search (the cover only). Returns { isrc, duration } if found.
  async function fillIn(t) {
    const extra = {};
    const get = url => fetch(url, { signal: AbortSignal.timeout(6000) }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (t.spotify && !t.art) {
      const u = (await get('https://open.spotify.com/oembed?url=' + encodeURIComponent(t.spotify)))?.thumbnail_url;
      if (u && /^https:\/\/[a-z0-9.-]+\.(scdn\.co|spotifycdn\.com)\//.test(u)) t.art = u;
    }
    if (!t.spotify || !t.art) {
      const f = (await get(`http://127.0.0.1:${tg.port}/api/spotify/search?` + new URLSearchParams({ title: t.title, artist: t.artist })))?.found;
      if (f) { t.spotify ||= f.url; t.art ||= f.art; extra.isrc = f.isrc; extra.duration = f.duration; }
    }
    if (!t.art) {
      const it = (await get('https://itunes.apple.com/search?' + new URLSearchParams({ media: 'music', entity: 'song', limit: '1', term: `${t.artist} ${t.title}` })))?.results?.[0];
      if (it?.artworkUrl100) t.art = it.artworkUrl100.replace(/\/\d+x\d+bb\./, '/300x300bb.');
    }
    return extra;
  }

  async function artFor(url) {
    if (!url) return null;
    if (!artCache.has(url)) {
      try { artCache.set(url, vnArtColours(await tg.loadImage(url))); } catch { return null; }
      if (artCache.size > 30) artCache.delete(artCache.keys().next().value);
    }
    return artCache.get(url);
  }

  // Waveforms for the page while it's listening or identifying (never sent to the Times Gate).
  // GET /wave streams server-sent events, about 14 a second:
  //   { peaks: [0..100, one per 23 ms], lo, hi, avg: [-100..100 × 128], phase, db }
  // lo/hi/avg describe the last 70 ms in 128 slices: each slice's lowest, highest and average
  // sample, so the page can draw the full range as a band and a smooth line through the middle.
  // The mic is only tapped while a page is watching and Vinyl is listening or identifying.
  const WAVE_HOPS = 3, SLICES = 128;
  const waveClients = new Set();
  let stopWave = null, peaks = [], win = null, waveDb = -99, pingTick = 0;
  function onWave(f) {
    const n = f.samples.length;
    win ||= new Int16Array(n * WAVE_HOPS);
    win.set(f.samples, peaks.length * n);   // f.samples is only valid during this call
    let peak = 0;
    for (const v of f.samples) { const a = v < 0 ? -v : v; if (a > peak) peak = a; }
    peaks.push(Math.round(peak / 327.68));
    waveDb = f.db;
    if (peaks.length < WAVE_HOPS) return;
    const lo = [], hi = [], avg = [], per = win.length / SLICES;
    for (let i = 0; i < SLICES; i++) {
      let mn = 32767, mx = -32768, sum = 0;
      for (let j = Math.floor(i * per), end = Math.floor((i + 1) * per); j < end; j++) { const v = win[j]; if (v < mn) mn = v; if (v > mx) mx = v; sum += v; }
      lo.push(Math.round(mn / 327.68)); hi.push(Math.round(mx / 327.68)); avg.push(Math.round(sum / Math.max(1, Math.floor((i + 1) * per) - Math.floor(i * per)) / 327.68));
    }
    const msg = `data: ${JSON.stringify({ peaks, lo, hi, avg, phase, db: waveDb })}\n\n`;
    peaks = [];
    for (const res of waveClients) res.write(msg);
  }
  function syncWave() {
    const want = waveClients.size > 0 && (active || phase === 'identifying');
    if (want && !stopWave) stopWave = tg.mic.listen(onWave, { samples: true });
    else if (!want && stopWave) {
      stopWave(); stopWave = null; peaks = [];
      for (const res of waveClients) res.write(`data: ${JSON.stringify({ peaks: [], lo: [], hi: [], avg: [], phase, db: -99 })}\n\n`);
    }
  }
  tg.every(1000, () => {
    syncWave();
    if (++pingTick % 15 === 0) for (const res of waveClients) res.write(': ping\n\n');  // keep idle connections open
  });

  const localOnly = ctx => { if (!ctx.local) throw Object.assign(new Error('Change the keys from the computer running the controller, or one it trusts.'), { status: 403 }); };
  // (The keys themselves never go to the page; only whether each service is set up.)
  const state = () => ({
    active, phase, status, until: active ? until : null,
    provider: s.provider, auddSet: SERVICES.audd.ready(), acrSet: SERVICES.acr.ready(), acrHost: s.acr.host,
    hasToken: chosen().length > 0,   // the chosen service(s) can be used
    used: used(), cap: s.cap, acrUsed: acrUsed(), acrCap: s.acrCap,
    autoOffMin: s.autoOffMin, autoShow: s.autoShow, cleanClip: s.cleanClip, clipSec: s.clipSec,
    track: track && { title: track.title, artist: track.artist, album: track.album, year: track.year, art: track.art, link: track.link },
    history: s.history.slice(0, 8),
    lastClip: lastClip && { at: lastClip.at, outcome: lastClip.outcome, cleaned: lastClip.cleaned },
    logged: tg.listening.available ? tg.listening.stats().plays : null,   // plays in the listening log, from every source
  });

  return {
    render: async () => renderVinyl(track, track ? await artFor(track.art) : null, active ? status : 'Switched off'),
    state,
    routes: {
      'POST /on': ctx => { turnOn(ctx.unit); return state(); },
      'POST /off': () => { turnOff(); return state(); },
      'POST /now': ctx => { identifyNow(ctx.unit); return state(); },
      'POST /options': ctx => {
        const b = ctx.body || {};
        if (typeof b.token === 'string') { localOnly(ctx); s.token = b.token.trim(); delete failed.audd; }
        if (b.acr && typeof b.acr === 'object') {   // { host, key, secret }, or {} to remove
          localOnly(ctx);
          const host = String(b.acr.host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
          if (host && !ACR_HOST.test(host)) throw Object.assign(new Error('The ACRCloud host looks like identify-eu-west-1.acrcloud.com (from your project page).'), { status: 400 });
          s.acr = { host, key: String(b.acr.key || '').trim(), secret: String(b.acr.secret || '').trim() };
          delete failed.acr;
        }
        if (PROVIDERS.includes(b.provider)) { s.provider = b.provider; failed = {}; }
        if (Number.isFinite(b.acrCap) && b.acrCap >= 0) s.acrCap = Math.round(b.acrCap);
        if (Number.isFinite(b.cap) && b.cap >= 0) s.cap = Math.round(b.cap);
        if (Number.isFinite(b.autoOffMin) && b.autoOffMin >= 5 && b.autoOffMin <= 720) s.autoOffMin = Math.round(b.autoOffMin);
        if (typeof b.autoShow === 'boolean') s.autoShow = b.autoShow;
        if (typeof b.cleanClip === 'boolean') s.cleanClip = b.cleanClip;
        if (CLIP_SECS.includes(b.clipSec)) s.clipSec = b.clipSec;
        tg.save();
        return state();
      },
      // The last clip sent to AudD, as a WAV file (only from the controller's computer or a trusted one).
      'GET /clip': ctx => {
        if (!ctx.local) throw Object.assign(new Error('Only from the computer running the controller, or one it trusts.'), { status: 403 });
        if (!lastClip) throw Object.assign(new Error('No clip yet — identify something first.'), { status: 404 });
        const name = 'vinyl-clip-' + new Date(lastClip.at).toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.wav';
        ctx.res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Disposition': `inline; filename="${name}"`, 'Cache-Control': 'no-store' });
        ctx.res.end(lastClip.wav);
      },
      'GET /wave': ({ req, res }) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        waveClients.add(res); syncWave();
        req.on('close', () => { waveClients.delete(res); syncWave(); });
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
      listen: { label: 'identify records on/off', run: ({ on, unit } = {}) => ((on ?? !active) ? turnOn(unit === 'all' ? undefined : unit) : turnOff()) },
      now: { label: 'identify what\'s playing now', run: ({ unit } = {}) => identifyNow(unit === 'all' ? undefined : unit) },
    },
    stop: () => { active = false; stopMic = null; stopWave = null; for (const res of waveClients) res.end(); waveClients.clear(); },
  };
};
