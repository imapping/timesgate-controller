// Identifies records playing near the microphone with AudD (audd.io) and/or ACRCloud (acrcloud.com),
// and shows them like Spotify.
// Built to stay inside a monthly request budget:
//  - only runs when switched on, and switches itself off after a set time
//  - one request per track: after a match it waits for the quiet gap before the next track
//    (or the track's expected end), and only tries when music has been playing for a few seconds
//  - misses wait 30 s; after 3 in a row it waits for the next track
//  - a monthly counter with a hard stop at the cap (resets on the 1st)
//  - skips identifying while the Spotify plugin says Spotify is playing (that's not the record)
// It also learns the records as they play (prints.js) and recognises them itself next time, so a
// record only needs a service the first time it's played.
// With a Discogs collection set up (discogs.js), each match gets the album, year, cover and side/track
// of the record the user owns.
const crypto = require('crypto');
const { renderVinyl, vnArtColours } = require('./public/render.js');
const discogsFor = require('./discogs.js');
const printsFor = require('./prints.js');

const CLIP_SECS = [10, 12];      // choices for the sound sent per request (AudD's standard API uses about 12 s at most)
const MUSIC_MS = 3000;           // music this long before trying
const GAP_MS = 1200;             // quiet this long = gap between tracks
const MIN_TRACK_MS = 45000;      // ignore "gaps" this soon after a match (quiet passages)
const RETRY_MS = 30000;
const LOUD_DB = -45;

// Cleans up a clip before it's sent (on by default): cuts everything below 120 Hz (boom from big
// speakers, turntable rumble, mains hum), lifts 2-4 kHz a little, and raises the level so peaks reach
// -1 dBFS (by at most 18 dB). AudD matches mostly on the mids and highs.
// Corrects a turntable running at the wrong speed: a deck turning at 34.1 instead of 33⅓ plays
// everything 2.3% fast and sharp, which is enough to stop fingerprint matching (though nobody hears
// it). ratio = actual speed / correct speed; the clip is stretched by that much (slower and lower).
function fixSpeed(wav, ratio) {
  const at = 44, n = (wav.length - at) >> 1, m = Math.round(n * ratio);
  const out = Buffer.alloc(at + m * 2);
  wav.copy(out, 0, 0, at);
  out.writeUInt32LE(36 + m * 2, 4); out.writeUInt32LE(m * 2, 40);
  for (let i = 0; i < m; i++) {
    const p = i / ratio, j = Math.floor(p), f = p - j;
    const a = wav.readInt16LE(at + Math.min(j, n - 1) * 2), b = wav.readInt16LE(at + Math.min(j + 1, n - 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * f), at + i * 2);
  }
  return out;
}

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
const PROVIDERS = ['audd', 'acr', 'both'];
const HUMMING_MIN = 0.7;   // the least confidence to accept an ACRCloud cover-song (humming) match   // both: AudD first, ACRCloud when AudD finds nothing

const monthKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

module.exports = tg => {
  const s = tg.settings;
  s.token ??= ''; s.cap ??= 1000; s.autoOffMin ??= 60; s.autoShow ??= true; s.cleanClip ??= true; if (!CLIP_SECS.includes(s.clipSec)) s.clipSec = 12;
  s.rpm ??= 33.33;   // the turntable's measured speed at 33⅓ (see fixSpeed)
  const speedRatio = () => (Math.abs(s.rpm / (100 / 3) - 1) > 0.002 ? s.rpm / (100 / 3) : 1);
  s.usage ??= { month: monthKey(), count: 0 }; s.history ??= [];
  s.provider ??= 'audd'; s.acr ??= { host: '', key: '', secret: '' }; s.acrCap ??= 300;
  s.acrUsage ??= { month: monthKey(), count: 0 };
  const discogs = discogsFor(tg, s);   // the user's record collection (see discogs.js)
  const prints = printsFor(tg, s);     // tracks learned from earlier plays (see prints.js)
  const canOwn = () => s.learn && prints.state().tracks > 0;   // it can recognise something without a service
  // A side chosen by hand from the Discogs collection: its tracks name what plays, in order, without
  // a service. { id, album, artist, year, cover, link, side, tracks: [{ pos, where, title, artist, dur }], index }
  // index: the track the next music will be.
  let cue = null, cueEnded = false;   // cueEnded: the chosen side ran out while listening
  const canGo = () => canOwn() || !!cue;
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
  let loudSince = 0, quietSince = 0, soundSince = 0, avgDb = null, power = 0;  // power: smoothed loudness (linear)
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
    // Fingerprint matches come under "music". With cover-song (humming) identification switched on in
    // the project, looser matches come under "humming", with a score: use the best if it's sure enough.
    let m = d.metadata?.music?.[0], note = '';
    if (!m) {
      const h = (d.metadata?.humming || []).map(x => ({ ...x, sure: Number(x.score) > 1 ? Number(x.score) / 100 : Number(x.score) || 0 }))
        .sort((a, b) => b.sure - a.sure)[0];
      if (!h) return { result: null };
      const guess = `${Math.round(h.sure * 100)}% cover-song match`;
      if (h.sure < HUMMING_MIN) return { result: null, note: ` (best guess: ${h.title} — ${(h.artists || []).map(a => a.name).join(', ')}, ${guess}, too unsure)` };
      m = h; note = ` (${guess})`;
    }
    const spId = m.external_metadata?.spotify?.track?.id;
    return { result: {
      title: m.title, artist: (m.artists || []).map(a => a.name).join(', '), album: m.album?.name || '',
      year: (m.release_date || '').slice(0, 4), durationMs: m.duration_ms || null, posMs: m.play_offset_ms ?? null,
      isrc: m.external_ids?.isrc || null, label: m.label || null,
      spotify: spId ? `https://open.spotify.com/track/${spId}` : null, link: null, art: null,   // art: looked up from Spotify
      note,
    } };
  }

  function turnOn(unit) {
    showOn = unit;
    failed = {};
    const why = blocked();
    if (why && !canGo()) throw Object.assign(new Error(why), { status: 400 });
    active = true; phase = 'waiting'; misses = 0; retryAt = 0; loudSince = quietSince = soundSince = 0; power = 0; cueEnded = false;
    until = Date.now() + s.autoOffMin * 60000;
    tg.clear(offTimer);
    offTimer = tg.after(s.autoOffMin * 60000, () => turnOff(`Switched off after ${s.autoOffMin} minutes.`));
    status = 'Waiting for music…';
    if (!stopMic) stopMic = tg.mic.listen(onFrame, { samples: true });
    tg.log('Listening for records.');
    if (s.autoShow) tg.setLive(true, showOn);
  }
  function turnOff(reason) {
    active = false; phase = 'off'; status = reason || 'Off';
    segClose();
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
    if (quiet) { quietSince ||= now; soundSince = 0; } else { quietSince = 0; soundSince ||= now; }
    const music = loudSince && now - loudSince > MUSIC_MS;
    const gap = quietSince && now - quietSince > GAP_MS;
    segAdd(f, quiet, gap, now);

    if (phase === 'identifying') return;
    // A chosen track's length is known: a gap well before its end is a quiet passage, not the next track.
    const early = phase === 'playing' && track.expectMs && now - track.identifiedAt < 0.6 * track.expectMs;
    if (early && seg && seg.endAt != null && seg.resumed != null) segLabel(track);   // (so keep recording it as one track)
    if ((phase === 'playing' && gap && !early && now - track.identifiedAt > MIN_TRACK_MS) || (phase === 'gaveup' && gap)) {
      phase = 'waiting'; status = 'Between tracks — waiting for the next one…';
      return;
    }
    if (phase === 'playing' && now > track.checkAt && music) return void identify(false, true);
    // (Steady sound for a second, so a track isn't named in the gap before it or by a click.)
    if (phase === 'waiting' && music && soundSince && now - soundSince > 1000 && now >= retryAt) identify();
  }

  // ---- learning: the sound of each track is kept (in memory, at 11 kHz) from its start until the
  // gap after it, then fingerprinted under the name it was identified as (prints.learn).
  //  - A gap ends the track. If the sound after the gap is identified as the same track, it was a
  //    quiet passage and the recording carries on.
  //  - Sound that was identified as two different tracks with no gap between isn't learned.
  let seg = null;   // { chunks, n, label, mixed, endAt, endTime, resumed }: n, endAt, resumed in samples
  const sameSong = (a, b) => a.title === b.title && a.artist === b.artist;
  function segAdd(f, quiet, gap, now) {
    if (!s.learn || !prints.available() || !f.samples) { seg = null; return; }
    if (!seg) { if (quiet) return; seg = { chunks: [], n: 0, label: null, mixed: false, endAt: null, endTime: 0, resumed: null }; }
    const half = new Int16Array(f.samples.length >> 1);
    for (let i = 0; i < half.length; i++) half[i] = (f.samples[2 * i] + f.samples[2 * i + 1]) >> 1;
    seg.chunks.push(half); seg.n += half.length;
    if (seg.n > prints.RATE * 26 * 60) { seg = null; return; }   // far too long to be one track
    if (seg.endAt == null) {
      if (gap) { seg.endAt = Math.max(0, seg.n - Math.round(GAP_MS / 1000 * prints.RATE)); seg.endTime = now; }
    } else if (seg.resumed == null) {
      if (!quiet) seg.resumed = seg.n - half.length;
      else if (now - seg.endTime > 30000) segClose();   // the end of the side
    } else if (gap) segClose();   // the next track came and went without a name
  }
  // The track has ended (or listening stopped): learn it, if it has a name.
  function segClose() {
    const g = seg;
    seg = null;
    if (!g || !g.label || g.mixed) return;
    const all = new Int16Array(g.n);
    let at = 0;
    for (const c of g.chunks) { all.set(c, at); at += c.length; }
    prints.learn(all.subarray(0, g.endAt ?? g.n), g.label);
  }
  // t: what the sound playing now was just identified as. fix: it corrects the name given before.
  function segLabel(t, fix) {
    if (!seg) return;
    if (seg.endAt != null && seg.resumed != null) {   // identified after a gap
      if (seg.label && !seg.mixed && sameSong(seg.label, t)) { seg.endAt = seg.resumed = null; return; }   // a quiet passage: the same track
      const g = seg, rest = [];
      let at = 0, n = 0;
      for (const c of g.chunks) { if (at >= g.resumed) { rest.push(c); n += c.length; } at += c.length; }
      segClose();
      seg = { chunks: rest, n, label: t, mixed: false, endAt: null, endTime: 0, resumed: null };
      return;
    }
    if (!seg.label || fix) seg.label = t;
    else if (!sameSong(seg.label, t)) seg.mixed = true;
  }

  async function spotifyPlaying() {
    try {
      const r = await fetch(`http://127.0.0.1:${tg.port}/api/spotify/now`, { signal: AbortSignal.timeout(3000) });
      return r.ok && !!(await r.json()).playing;
    } catch { return false; }
  }

  // The next track of the chosen side, as a match. recheck (no gap was heard): only once the current
  // track's time is up, otherwise 'stay'. null when the side has no more tracks.
  function cueTake(recheck) {
    if (recheck && track && !(track.expectMs && Date.now() - track.identifiedAt > track.expectMs)) return 'stay';
    if (cue.index >= cue.tracks.length) { cue = null; cueEnded = true; return null; }
    const tr = cue.tracks[cue.index++];
    return { title: tr.title, artist: tr.artist, album: cue.album, year: cue.year, durationMs: tr.dur ? tr.dur * 1000 : null, posMs: 0,
      service: 'the record you chose', picked: true, rec: { album: cue.album, year: cue.year, pos: tr.pos, where: tr.where, cover: cue.cover, link: cue.link } };
  }
  // A track recognised from your own recordings: the chosen side carries on from it, or is dropped if it's another record.
  function cueSync(title) {
    if (!cue) return;
    const i = cue.tracks.findIndex(t => t.title.toLowerCase() === String(title).toLowerCase());
    if (i < 0) cue = null; else cue.index = i + 1;
  }

  // manual: "Identify now" — skips the music / gap / Spotify checks, and works while switched off (once).
  // recheck: the current track's expected end has passed with no gap heard.
  async function identify(manual = false, recheck = false) {
    const cancelled = () => !manual && !active;
    phase = 'identifying';
    try {
      if (!manual && await spotifyPlaying()) {
        status = 'Spotify is playing, so not identifying.'; retryAt = Date.now() + RETRY_MS; phase = 'waiting';
        return;
      }
      const why = blocked();
      if (why && !canGo()) { if (active) return turnOff(cueEnded ? 'Stopped: the side you chose has finished.' : 'Stopped: ' + why); phase = 'off'; status = why; return; }
      let raw = null;
      if (!cue || canOwn()) {   // (with a chosen side and nothing learned, there's nothing to listen for)
        status = 'Listening to identify…';
        raw = await tg.mic.record(s.clipSec * 1000);
      }
      // Your own recordings first: a track learned from an earlier play needs no request.
      const own = s.learn && raw ? prints.match(raw, fixSpeed) : null;
      if (own) {
        if (cancelled()) return;
        cueSync(own.title);
        lastClip = { wav: raw, at: Date.now(), outcome: `recognised from your own recordings: ${own.title} — ${own.artist} (score ${own.score})`, cleaned: false, speedFixed: null };
        s.localHits++; tg.save();
        misses = 0;
        matched({ title: own.title, artist: own.artist, album: own.album || '', year: own.year || '', art: own.art, link: own.link, spotify: own.spotify,
          isrc: own.isrc, label: own.label, durationMs: Math.round(own.secs * 1000), posMs: Math.round(own.offsetS * 1000), realTime: true,
          service: 'your own recordings', own: true }).catch(e => tg.log('Saving the match failed:', e.message));
        if (!active) phase = 'off';
        if (manual && s.autoShow && !tg.isLive()) tg.setLive(true, showOn);
        return;
      }
      // A side chosen by hand: its next track is what's playing. No service is asked.
      if (cue) {
        if (cancelled()) return;
        const res = cueTake(recheck);
        if (res === 'stay') { track.checkAt = Date.now() + 60000; phase = 'playing'; return; }
        if (res) {
          if (raw) lastClip = { wav: raw, at: Date.now(), outcome: `not in your own recordings · named from the record you chose: ${res.title}`, cleaned: false, speedFixed: null };
          misses = 0;
          matched(res).catch(e => tg.log('Saving the match failed:', e.message));
          if (!active) phase = 'off';
          if (manual && s.autoShow && !tg.isLive()) tg.setLive(true, showOn);
          return;
        }
        tg.log('The chosen side has finished.');   // (carry on as usual)
        if (why && !canOwn()) { phase = active ? 'gaveup' : 'off'; status = 'That side has finished. Choose the next one.'; return; }
      }
      if (!raw) { status = 'Listening to identify…'; raw = await tg.mic.record(s.clipSec * 1000); }
      const sped = speedRatio() !== 1 ? fixSpeed(raw, speedRatio()) : raw;
      const wav = s.cleanClip ? cleanClip(sped) : sped;
      lastClip = { wav, at: Date.now(), outcome: 'sending…', cleaned: s.cleanClip, speedFixed: speedRatio() !== 1 ? s.rpm : null };
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
        if (a.result) { found = { ...a.result, service: sv.name }; notes.push(`${sv.name}: matched ${found.title} — ${found.artist}${found.note || ''}`); break; }
        notes.push(`${sv.name}: no match${a.note || ''}`);
      }
      lastClip.outcome = notes.join(' · ') || 'not sent';
      if (cancelled()) return;
      if (why && !usable().length) { answered = true; lastClip.outcome = 'not in your own recordings · ' + why; }   // (only own recognition is possible)
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
    if (why && !canGo()) throw Object.assign(new Error(why), { status: 400 });
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
      spotify: res.spotify, service: res.service, own: !!res.own, picked: !!res.picked, isrc: res.isrc, label: res.label, identifiedAt: now,
      expectMs: res.picked && res.durationMs ? res.durationMs / speedRatio() : null };   // how long a chosen track should last on this deck
    const same = track && track.title === t.title && track.artist === t.artist;
    // The record in the Discogs collection with this song: its album, year and cover replace the
    // service's (which often names a compilation), and it says where the song is on the record.
    const own = res.rec || (same ? null : discogs.match(t.title, t.artist, now));
    if (own) {
      t.album = own.album; t.year = own.year || t.year; t.pos = own.pos; t.where = own.where; t.discogs = own.link;
      if (own.cover) { t.artAlt = t.art; t.art = own.cover; }
    }
    // Check again around the track's end if no gap is heard (e.g. tracks that run into each other).
    const checkAt = duration => now + Math.max(same ? 2 * 60000 : 60000,
      (duration && pos != null && duration < 20 * 60000 ? (duration - pos) / (res.realTime ? 1 : speedRatio()) - s.clipSec * 1000 : 4 * 60000) + 15000);   // a fast deck ends songs sooner
    t.checkAt = checkAt(res.durationMs);
    segLabel(t, res.fix);   // (for learning: this is what's playing)
    track = t; phase = 'playing';
    status = `${t.title} — ${t.artist}`;
    if (same) return;
    tg.log(`Identified ${t.own || t.picked ? 'from' : 'by'} ${t.service}: ${t.title} — ${t.artist}${own ? ` [${own.album}, ${own.pos || 'no position'}]` : ''} (AudD ${used()}/${s.cap}, ACRCloud ${acrUsed()}/${s.acrCap} this month)`);
    tg.update();
    if (t.artAlt !== undefined && !(await artFor(t.art))) { t.art = t.artAlt; delete t.artAlt; }   // the Discogs cover didn't load
    const extra = !t.art || !t.spotify ? await fillIn(t) : {};
    if (!res.durationMs && extra.duration) t.checkAt = checkAt(extra.duration);
    s.history = [{ title: t.title, artist: t.artist, album: t.album, year: t.year, spotify: t.spotify, pos: t.pos, discogs: t.discogs, own: t.own || undefined, picked: t.picked || undefined, at: now }, ...s.history].slice(0, 20);
    // The all-time listening log (data/listening.db).
    try {
      tg.listening.add({ at: now, title: t.title, artist: t.artist, album: t.album, year: t.year, duration_ms: res.durationMs || extra.duration,
        isrc: res.isrc || extra.isrc, spotify_url: t.spotify, label: res.label, position: t.pos });
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
  // The history with each song's play in the listening log (its id, and your marks and comment on it),
  // and whether the song is a favourite.
  function historyWithNotes() {
    const list = s.history.slice(0, 8);
    if (!tg.listening.available) return list;
    try {
      return list.map(h => {
        const p = tg.listening.query('SELECT id, tags, note FROM plays WHERE source = ? AND at = ? AND title = ? AND artist = ?', ['vinyl', h.at, h.title, h.artist])[0];
        const fav = tg.listening.query('SELECT 1 FROM favourites WHERE title = ? AND artist = ?', [h.title, h.artist]).length > 0;
        return p ? { ...h, id: p.id, tags: p.tags, note: p.note, fav } : { ...h, fav };
      });
    } catch { return list; }
  }
  const state = () => ({
    active, phase, status, until: active ? until : null,
    provider: s.provider, auddSet: SERVICES.audd.ready(), acrSet: SERVICES.acr.ready(), acrHost: s.acr.host,
    hasToken: chosen().length > 0 || canGo(),   // a service can be used, or there are learned tracks or a chosen side
    cue: cue && { id: cue.id, album: cue.album, artist: cue.artist, side: cue.side, index: cue.index, tracks: cue.tracks.map(t => ({ pos: t.pos, title: t.title, dur: t.dur })) },
    learn: prints.state(),
    used: used(), cap: s.cap, acrUsed: acrUsed(), acrCap: s.acrCap,
    autoOffMin: s.autoOffMin, autoShow: s.autoShow, cleanClip: s.cleanClip, clipSec: s.clipSec, rpm: s.rpm,
    track: track && { title: track.title, artist: track.artist, album: track.album, year: track.year, art: track.art, link: track.link,
      where: track.where, discogs: track.discogs },
    discogs: discogs.state(),
    history: historyWithNotes(),
    lastClip: lastClip && { at: lastClip.at, outcome: lastClip.outcome, cleaned: lastClip.cleaned, speedFixed: lastClip.speedFixed },
    logged: tg.listening.available ? tg.listening.stats().plays : null,   // plays in the listening log, from every source
  });

  return {
    render: async () => renderVinyl(track, track ? await artFor(track.art) : null, active ? status : 'Switched off'),
    state,
    routes: {
      'GET /state': () => state(),
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
        if (b.discogs && typeof b.discogs === 'object') { localOnly(ctx); discogs.configure(b.discogs); }   // { user, token }, or {} to remove
        if (PROVIDERS.includes(b.provider)) { s.provider = b.provider; failed = {}; }
        if (Number.isFinite(b.acrCap) && b.acrCap >= 0) s.acrCap = Math.round(b.acrCap);
        if (Number.isFinite(b.cap) && b.cap >= 0) s.cap = Math.round(b.cap);
        if (Number.isFinite(b.autoOffMin) && b.autoOffMin >= 5 && b.autoOffMin <= 720) s.autoOffMin = Math.round(b.autoOffMin);
        if (typeof b.autoShow === 'boolean') s.autoShow = b.autoShow;
        if (typeof b.cleanClip === 'boolean') s.cleanClip = b.cleanClip;
        if (typeof b.learn === 'boolean') { s.learn = b.learn; if (!b.learn) seg = null; }
        if (CLIP_SECS.includes(b.clipSec)) s.clipSec = b.clipSec;
        if (Number.isFinite(b.rpm) && b.rpm >= 30 && b.rpm <= 37) s.rpm = Math.round(b.rpm * 100) / 100;
        tg.save();
        return state();
      },
      // The records in the Discogs collection, for choosing what's about to play.
      'GET /records': () => ({ records: discogs.records() }),
      // Choose a side: { id, side }. Its tracks then name what plays, in order. { index } says which track is
      // playing now (or is next, when nothing's playing). {} stops using it.
      'POST /cue': ctx => {
        const b = ctx.body || {};
        if (b.id != null) {
          const side = discogs.side(b.id, String(b.side ?? ''));
          if (!side) throw Object.assign(new Error('That record or side isn\'t in the saved collection.'), { status: 404 });
          cue = { ...side, index: 0 }; cueEnded = false;
          tg.log(`Chosen: ${cue.album}${cue.side ? ', side ' + cue.side : ''} (${cue.tracks.length} tracks).`);
        } else if (Number.isInteger(b.index) && cue) {
          cue.index = Math.max(0, Math.min(cue.tracks.length - 1, b.index));
          if (phase === 'playing') matched({ ...cueTake(false), fix: true }).catch(e => tg.log('Saving the match failed:', e.message));
        } else cue = null;
        return state();
      },
      // The tracks learned from earlier plays (the latest 50; ?q= filters by title, artist or album).
      'GET /learned': ctx => ({ tracks: prints.list(ctx.query.get('q')) }),
      // Forget a learned track: { id }, or { id: 'all' } (from the controller's computer or a trusted one).
      'POST /forget': ctx => {
        const id = ctx.body?.id;
        if (id === 'all') localOnly(ctx);
        prints.forget(id);
        return { ...state(), tracks: prints.list(ctx.body?.q) };
      },
      // Read the Discogs collection again now (it's also checked once a day).
      'POST /discogs': () => { discogs.refresh(); return state(); },
      // ?q=text: the records in the saved collection whose artist or album contains it (trusted computers only).
      'GET /discogs/find': ctx => { localOnly(ctx); return { records: discogs.find(ctx.query.get('q') || '') }; },
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
    stop: () => { discogs.stop(); seg = null; prints.stop(); active = false; stopMic = null; stopWave = null; for (const res of waveClients) res.end(); waveClients.clear(); },
  };
};
