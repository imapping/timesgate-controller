// Vinyl's own recognition: it learns the records you play and recognises them next time without
// asking a recognition service.
//  - A fingerprint is a set of hashes: the spectrogram's strongest peaks, paired with a few later
//    peaks (two pitches and the time between them), each stored with its time in the track. A clip
//    matches a track when many of its hashes line up at one time offset. (The method Shazam
//    published; its original patent expired in 2024.)
//  - Tracks are learned from what the turntable plays, labelled by the recognition service (and
//    Discogs) the first time. They're kept in data/vinyl-prints.db (SQLite, through better-sqlite3;
//    without it, this is simply off).
//  - Fingerprints are of the sound as your deck plays it, at its speed (`rpm` is saved with each
//    track). If the speed setting changes later, clips are converted to the old speed before matching.
const fs = require('fs');
const path = require('path');
let Database = null;
try { Database = require('better-sqlite3'); } catch {}

const RATE = 11025, N = 1024, HOP = 512, BINS = 256;   // 93 ms windows, 46 ms apart; pitches up to 2.75 kHz
const FRAME_S = HOP / RATE, PER_SEC = Math.round(1 / FRAME_S);
const DF = 12, DT = 6, MIN_BIN = 6, PEAKS_PER_SEC = 24;   // a peak: the loudest within ±DF bins and ±DT frames
const MAX_DT = 63, MAX_DB = 63;
const FAN_STORE = 3, FAN_QUERY = 6;   // later peaks paired with each peak: fewer are stored than are looked up
const MIN_SCORE = 12, MIN_RATIO = 4;  // hashes agreeing on one offset, and how far ahead of the next track
const MIN_LEARN_S = 30, MAX_LEARN_S = 25 * 60;

const hann = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
const cosT = new Float32Array(N / 2), sinT = new Float32Array(N / 2), rev = new Uint16Array(N);
for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / N); sinT[i] = Math.sin(2 * Math.PI * i / N); }
for (let i = 0; i < N; i++) { let r = 0; for (let b = 0, x = i; b < 10; b++, x >>= 1) r = (r << 1) | (x & 1); rev[i] = r; }
function fft(re, im) {
  for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let i = 0; i < N; i += size) for (let k = 0; k < half; k++) {
      const c = cosT[k * step], s = -sinT[k * step], a = i + k, b = a + half;
      const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}

// samples: Int16Array (or Float32Array on the same scale) at 11.025 kHz → [{ hash, t }], t in frames.
function fingerprint(x, fan) {
  const frames = Math.max(0, Math.floor((x.length - N) / HOP) + 1), mag = new Float32Array(frames * BINS);
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) { re[i] = x[f * HOP + i] * hann[i]; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < BINS; b++) mag[f * BINS + b] = Math.log(re[b] * re[b] + im[b] * im[b] + 1e-3);
  }
  const found = [];
  for (let f = 0; f < frames; f++) for (let b = MIN_BIN; b < BINS - 1; b++) {
    const v = mag[f * BINS + b];
    if (v < 4) continue;   // near silence
    let top = true;
    for (let g = Math.max(0, f - DT); top && g <= Math.min(frames - 1, f + DT); g++)
      for (let c = Math.max(MIN_BIN, b - DF); c <= Math.min(BINS - 1, b + DF); c++) {
        const w = mag[g * BINS + c];
        if (w > v || (w === v && (g < f || (g === f && c < b)))) { top = false; break; }
      }
    if (top) found.push({ f, b, v });
  }
  // The strongest in each second, in time order.
  const pk = [];
  for (let i = 0; i < found.length;) {
    const sec = Math.floor(found[i].f / PER_SEC);
    let j = i;
    while (j < found.length && Math.floor(found[j].f / PER_SEC) === sec) j++;
    pk.push(...found.slice(i, j).sort((a, b) => b.v - a.v).slice(0, PEAKS_PER_SEC));
    i = j;
  }
  pk.sort((a, b) => a.f - b.f || a.b - b.b);
  const out = [];
  for (let i = 0; i < pk.length; i++) {
    let n = 0;
    for (let j = i + 1; j < pk.length && n < fan; j++) {
      const dt = pk[j].f - pk[i].f, db = pk[j].b - pk[i].b;
      if (dt < 2) continue;
      if (dt > MAX_DT) break;
      if (Math.abs(db) > MAX_DB) continue;
      out.push({ hash: (pk[i].b << 13) | ((db + 64) << 6) | dt, t: pk[i].f });
      n++;
    }
  }
  return out;
}

// A long recording, fingerprinted in pieces so the controller keeps running meanwhile.
async function fingerprintLong(x) {
  const STEP = PER_SEC * 20, PAD = PER_SEC, EXTRA = PER_SEC * 4, out = [];
  const frames = Math.floor((x.length - N) / HOP) + 1;
  for (let start = 0; start < frames; start += STEP) {
    const from = Math.max(0, start - PAD), to = Math.min(x.length, (start + STEP + EXTRA) * HOP + N);
    for (const p of fingerprint(x.subarray(from * HOP, to), FAN_STORE)) {
      const t = p.t + from;
      if (t >= start && t < start + STEP) out.push({ hash: p.hash, t });
    }
    await new Promise(r => setImmediate(r));
  }
  return out;
}

// A 16-bit mono WAV at 22.05 kHz (mic.record's) → samples at 11.025 kHz.
function halve(wav) {
  const n = (wav.length - 44) >> 2, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (wav.readInt16LE(44 + i * 4) + wav.readInt16LE(46 + i * 4)) / 2;
  return x;
}

const keyOf = t => [t.title, t.artist, t.album || ''].map(v => String(v).toLowerCase().trim()).join('|');

module.exports = (tg, s) => {
  s.learn ??= true;          // learn records as they play, and recognise them here first
  s.localHits ??= 0;         // identifications answered here instead of by a service
  const file = path.join(tg.dir, '..', '..', 'data', 'vinyl-prints.db');
  let db = null, error = Database ? null : 'better-sqlite3 is not installed';
  if (Database) {
    try {
      db = new Database(file);
      db.pragma('journal_mode = WAL');
      db.exec(`
        CREATE TABLE IF NOT EXISTS tracks (
          id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE,     -- key: title|artist|album, lowercase
          title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT, year TEXT, position TEXT,
          discogs TEXT, spotify TEXT, art TEXT, link TEXT, isrc TEXT, label TEXT,
          secs REAL NOT NULL,            -- how much of it was heard and learned
          rpm REAL NOT NULL,             -- the turntable speed setting when it was learned
          hashes INTEGER NOT NULL, learned_at INTEGER NOT NULL, service TEXT
        );
        -- (No index by track: it would double the size. Forgetting a track scans the table, which is rare.)
        CREATE TABLE IF NOT EXISTS prints (hash INTEGER NOT NULL, track INTEGER NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (hash, track, t)) WITHOUT ROWID;
      `);
    } catch (e) { error = e.message; db = null; tg.log('Own recognition is off:', e.message); }
  }
  const available = () => !!db;
  let counts = null;   // { tracks, secs }, cached
  const count = () => (counts ||= db ? db.prepare('SELECT COUNT(*) tracks, COALESCE(SUM(secs), 0) secs, COALESCE(SUM(hashes), 0) hashes FROM tracks').get() : { tracks: 0, secs: 0, hashes: 0 });

  // The learned track this clip (mic.record's WAV, at the deck's own speed) comes from, or null:
  //   { ...the track's saved details, score, offsetS }
  // fixSpeed(wav, ratio): the plugin's resampler, for tracks learned at another speed setting.
  function match(wav, fixSpeed) {
    if (!db || !count().tracks) return null;
    let best = null;
    for (const { rpm } of db.prepare('SELECT DISTINCT rpm FROM tracks').all()) {
      const clip = Math.abs(rpm / s.rpm - 1) > 0.002 ? fixSpeed(wav, s.rpm / rpm) : wav;
      const votes = new Map(), rows = db.prepare('SELECT track, t FROM prints WHERE hash = ?');
      for (const p of fingerprint(halve(clip), FAN_QUERY))
        for (const r of rows.iterate(p.hash)) { const k = r.track * 1e6 + (r.t - p.t + 5e5); votes.set(k, (votes.get(k) || 0) + 1); }
      const top = new Map();   // track → its best offset (counting the neighbouring offsets too)
      for (const [k, n] of votes) {
        if (n < 2) continue;
        const track = Math.floor(k / 1e6), score = n + (votes.get(k - 1) || 0) + (votes.get(k + 1) || 0);
        if (!top.has(track) || score > top.get(track).score) top.set(track, { track, score, off: k - track * 1e6 - 5e5 });
      }
      const ranked = [...top.values()].sort((a, b) => b.score - a.score);
      const m = ranked[0];
      if (m && m.score >= MIN_SCORE && m.score >= MIN_RATIO * (ranked[1]?.score || 1) && (!best || m.score > best.score)) best = m;
    }
    if (!best) return null;
    const t = db.prepare('SELECT * FROM tracks WHERE id = ?').get(best.track);
    return t && { ...t, score: best.score, offsetS: Math.max(0, best.off * FRAME_S) };
  }

  // Learning runs one track at a time, in the background.
  let queue = Promise.resolve();
  // samples: Int16Array at 11.025 kHz, the whole track as heard; info: the match's details.
  // Skipped if it's already learned from at least as much sound (20 s more replaces it).
  function learn(samples, info) {
    if (!db || !s.learn || !info?.title || !info.artist) return;
    const secs = samples.length / RATE;
    if (secs < MIN_LEARN_S || secs > MAX_LEARN_S) return;
    queue = queue.then(async () => {
      const key = keyOf(info), old = db.prepare('SELECT id, secs FROM tracks WHERE key = ?').get(key);
      if (old && old.secs >= secs - 20) return;
      const prints = await fingerprintLong(samples);
      if (prints.length < secs * 5) return;   // mostly silence
      db.transaction(() => {
        if (old) { db.prepare('DELETE FROM prints WHERE track = ?').run(old.id); db.prepare('DELETE FROM tracks WHERE id = ?').run(old.id); }
        const id = Number(db.prepare(`INSERT INTO tracks (key, title, artist, album, year, position, discogs, spotify, art, link, isrc, label, secs, rpm, hashes, learned_at, service)
          VALUES (@key, @title, @artist, @album, @year, @position, @discogs, @spotify, @art, @link, @isrc, @label, @secs, @rpm, @hashes, @at, @service)`).run({
          key, title: info.title, artist: info.artist, album: info.album || null, year: info.year ? String(info.year) : null, position: info.pos || null,
          discogs: info.discogs || null, spotify: info.spotify || null, art: info.art || null, link: info.link || null, isrc: info.isrc || null,
          label: info.label || null, secs, rpm: s.rpm, hashes: prints.length, at: Date.now(), service: info.service || null }).lastInsertRowid);
        const ins = db.prepare('INSERT OR IGNORE INTO prints (hash, track, t) VALUES (?, ?, ?)');
        for (const p of prints) ins.run(p.hash, id, p.t);
      })();
      counts = null;
      tg.log(`Learned ${info.title} — ${info.artist} (${Math.round(secs)} s${old ? ', replacing a shorter recording' : ''}).`);
    }).catch(e => tg.log('Learning failed:', e.message));
  }

  function forget(id) {
    if (!db) return;
    db.transaction(() => {
      if (id === 'all') { db.exec('DELETE FROM prints; DELETE FROM tracks;'); return; }
      db.prepare('DELETE FROM prints WHERE track = ?').run(Number(id)); db.prepare('DELETE FROM tracks WHERE id = ?').run(Number(id));
    })();
    counts = null;
  }
  // The learned tracks, newest first; q filters by title, artist or album.
  const list = q => (!db ? [] : db.prepare(`SELECT id, title, artist, album, position, secs, learned_at FROM tracks
    WHERE ? = '' OR title LIKE ? OR artist LIKE ? OR album LIKE ? ORDER BY learned_at DESC LIMIT 50`)
    .all(...(q = String(q || '').trim().slice(0, 60), [q, `%${q}%`, `%${q}%`, `%${q}%`])));

  return {
    available, match, learn, forget, list, RATE,
    known: info => !!db && !!db.prepare('SELECT 1 FROM tracks WHERE key = ?').get(keyOf(info)),
    state: () => {
      const c = count();
      let mb = 0;
      try { mb = Math.round(fs.statSync(file).size / 1e5) / 10; } catch {}
      return { available: !!db, error, on: s.learn, tracks: c.tracks, minutes: Math.round(c.secs / 60), mb, saved: s.localHits };
    },
    idle: () => queue,
    stop: () => { try { db?.close(); } catch {} db = null; },
  };
};
module.exports.fingerprint = fingerprint;
