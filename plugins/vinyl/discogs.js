// Your Discogs collection (discogs.com), used to match an identified song to the record you own:
// the right album, year, cover, and where the song is on it (side and track).
//  - The list of records comes from /users/{user}/collection/folders/0/releases (100 a page).
//  - Each record's track list comes from /releases/{id}, one request every 1.1 s (Discogs allows
//    60 a minute with a token), so a big collection takes a few minutes the first time.
//  - Both are kept in data/vinyl-discogs.json; the list is checked again once a day.
//  - A private collection needs its owner's personal access token (Discogs → Settings → Developers).
//    The token stays in data/vinyl.json and is only ever sent to api.discogs.com.
const fs = require('fs');
const path = require('path');

const API = 'https://api.discogs.com';
const UA = 'TimesGateController/1.0 +https://github.com/imapping/timesgate-controller';
const GAP_MS = 1100, BUSY_MS = 60000, DAY_MS = 24 * 3600 * 1000;
const USER = /^[A-Za-z0-9._-]{1,60}$/;
const COVER = /^https:\/\/(i|img)\.discogs\.com\//;
const CONTINUE_MS = 45 * 60000;   // a match this soon after the last one prefers the same record

// ---- comparing names ----
const fold = v => String(v || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = v => v.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
// "Uptown Girl (Remastered)" / "Uptown Girl - 2011 Remaster" → "uptown girl"
function normTitle(v) {
  const f = fold(v);
  const cut = words(f.replace(/\s*[(\[][^)\]]*[)\]]/g, ' ')
    .replace(/\s+-\s+[^-]*\b(remaster(ed)?|version|edit|mix|live|mono|stereo|single|bonus|\d{4})\b.*$/, ''));
  return cut || words(f);   // "(Untitled)" keeps its words
}
// "Beatles, The" / "The Beatles" / "Billy Joel (2)" → "beatles" / "billy joel"
const normArtist = v => words(fold(v).replace(/\s*\(\d+\)$/, '').replace(/^(.*), the$/, '$1')).replace(/^the /, '');
const sameArtist = (a, b) => !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 3 && (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `))));

// "B3" → "Side B · track 3"; "2-05" → "Disc 2 · track 5"; "7" → "Track 7"
function wherePos(pos) {
  const p = String(pos || '').trim();
  let m;
  if ((m = /^([A-Za-z]{1,2})\.?(\d+)?[a-z]?$/.exec(p))) return 'Side ' + m[1].toUpperCase() + (m[2] ? ' · track ' + Number(m[2]) : '');
  if ((m = /^(\d+)[-.](\d+)$/.exec(p))) return `Disc ${Number(m[1])} · track ${Number(m[2])}`;
  if ((m = /^(\d+)$/.exec(p))) return 'Track ' + Number(m[1]);
  return p;
}

// "4:32" → 272 (seconds), or undefined
function seconds(v) {
  const p = String(v || '').trim().split(':').map(Number);
  return p.length >= 2 && p.length <= 3 && p.every(Number.isFinite) ? p.reduce((a, n) => a * 60 + n, 0) || undefined : undefined;
}
// The side a position is on: "B3" → "B", "2-05" → "Disc 2", "7" → "" (the whole record)
function sideOf(pos) {
  const p = String(pos || '').trim();
  let m;
  if ((m = /^([A-Za-z]{1,2})\.?\d*[a-z]?$/.exec(p))) return m[1].toUpperCase();
  if ((m = /^(\d+)[-.]\d+$/.exec(p))) return 'Disc ' + Number(m[1]);
  return '';
}
// A Discogs artist name as people write it: "Beatles, The" → "The Beatles", "Billy Joel (2)" → "Billy Joel"
const shown = v => String(v || '').replace(/\s*\(\d+\)$/, '').replace(/^(.*), The$/i, 'The $1');

module.exports = (tg, s) => {
  s.discogs ??= { user: '', token: '' };
  const file = path.join(tg.dir, '..', '..', 'data', 'vinyl-discogs.json');
  let cache = { v: 2, user: '', syncedAt: 0, releases: {} };
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  cache.releases ||= {};
  // (v2 added each track's length: track lists saved before that are loaded again.)
  if (cache.v !== 2) { for (const r of Object.values(cache.releases)) delete r.tracks; cache.v = 2; }
  let index = null, syncing = false, error = '', pumpTimer = null, stopped = false, unsaved = 0;
  let last = null;   // { id, at }: the record the last song was matched to

  const ready = () => USER.test(s.discogs.user) && !!s.discogs.token;
  const store = () => { try { fs.writeFileSync(file, JSON.stringify(cache)); unsaved = 0; } catch (e) { tg.log('Discogs: saving failed:', e.message); } };
  const sleep = ms => new Promise(r => tg.after(ms, r));
  const pending = () => Object.values(cache.releases).filter(r => !r.tracks && (r.fails || 0) < 3);

  async function get(url) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Authorization: 'Discogs token=' + s.discogs.token }, signal: AbortSignal.timeout(20000) });
    if (r.status === 429) throw Object.assign(new Error('Discogs is busy'), { busy: true });
    if (r.status === 401) throw Object.assign(new Error('Discogs didn\'t accept the token.'), { fatal: true });
    if (r.status === 403) throw Object.assign(new Error('Discogs says this token can\'t see that collection (is it the owner\'s token?).'), { fatal: true });
    if (r.status === 404) throw Object.assign(new Error('Discogs didn\'t find that (check the username).'), { missing: true });
    if (!r.ok) throw new Error('Discogs error ' + r.status);
    return r.json();
  }

  // The list of records. Keeps the track lists already loaded; drops records no longer in the collection.
  async function sync() {
    if (!ready() || syncing) return;
    syncing = true; error = '';
    const user = s.discogs.user;
    try {
      const seen = {};
      for (let page = 1, pages = 1; page <= pages && page <= 200; page++) {
        if (page > 1) await sleep(GAP_MS);
        if (stopped || s.discogs.user !== user) return;
        let d;
        try { d = await get(`${API}/users/${encodeURIComponent(user)}/collection/folders/0/releases?per_page=100&page=${page}`); }
        catch (e) { if (e.busy) { await sleep(BUSY_MS); page--; continue; } throw e; }
        pages = d.pagination?.pages || 1;
        for (const it of d.releases || []) {
          const b = it.basic_information || {}, id = b.id || it.id;
          if (!id) continue;
          const old = cache.user === user ? cache.releases[id] : null;
          const formats = (b.formats || []).flatMap(f => [f.name, ...(f.descriptions || [])]).filter(Boolean);
          seen[id] = { id, title: String(b.title || ''), year: b.year || null, artists: (b.artists || []).map(a => a.name).filter(Boolean),
            cover: COVER.test(b.cover_image || '') ? b.cover_image : null, formats,
            tracks: old?.tracks, fails: old?.tracks ? undefined : old?.fails };
        }
      }
      cache = { v: 2, user, syncedAt: Date.now(), releases: seen };
      index = null; store();
      tg.log(`Discogs: ${Object.keys(seen).length} records in ${user}'s collection, ${pending().length} track lists to load.`);
    } catch (e) {
      error = e.message; tg.log('Discogs:', e.message);
    } finally { syncing = false; }
    if (!error) pump();
  }

  // Loads the missing track lists, one at a time.
  function pump() {
    if (pumpTimer || stopped || !ready() || cache.user !== s.discogs.user) return;
    const step = async () => {
      pumpTimer = null;
      const rel = pending()[0];
      if (!rel || stopped || !ready() || cache.user !== s.discogs.user) { if (unsaved) store(); return; }
      let wait = GAP_MS;
      try {
        const d = await get(`${API}/releases/${rel.id}`);
        if (cache.releases[rel.id] !== rel) return pump();   // the list changed meanwhile
        rel.tracks = (d.tracklist || []).filter(t => t.title && (!t.type_ || t.type_ === 'track'))
          .map(t => ({ pos: String(t.position || ''), title: String(t.title), dur: seconds(t.duration), artists: t.artists?.length ? t.artists.map(a => a.name) : undefined }));
        delete rel.fails;
        if (!rel.cover) { const img = (d.images || []).find(i => COVER.test(i.uri || '')); if (img) rel.cover = img.uri; }
        index = null; error = '';
        if (++unsaved >= 25 || !pending().length) store();
      } catch (e) {
        if (e.busy) wait = BUSY_MS;
        else if (e.fatal) { error = e.message; tg.log('Discogs:', e.message); if (unsaved) store(); return; }
        else { rel.fails = e.missing ? 3 : (rel.fails || 0) + 1; wait = 5000; }
      }
      pumpTimer = tg.after(wait, step);
    };
    pumpTimer = tg.after(0, step);
  }

  function build() {
    index = new Map();
    for (const rel of Object.values(cache.releases)) {
      const relArtists = rel.artists.map(normArtist);
      for (const t of rel.tracks || []) {
        const k = normTitle(t.title);
        if (!k) continue;
        if (!index.has(k)) index.set(k, []);
        index.get(k).push({ rel, t, artists: t.artists ? [...t.artists.map(normArtist), ...relArtists] : relArtists });
      }
    }
  }

  // The record in the collection with this song, or null:
  //   { id, album, year, pos, where, cover, link }
  // With the song on several records, it prefers the one the last song came from (you're probably
  // still playing it), then albums over compilations, then vinyl.
  function match(title, artist, now = Date.now()) {
    if (!ready() || cache.user !== s.discogs.user) return null;
    if (!index) build();
    const a = normArtist(artist);
    const hits = (index.get(normTitle(title)) || []).filter(h => h.artists.some(x => sameArtist(a, x)));
    if (!hits.length) return null;
    const cont = last && now - last.at < CONTINUE_MS ? last.id : null;
    const score = h => (h.rel.id === cont ? 100 : 0) + (h.rel.formats.includes('Compilation') ? 0 : 20) + (h.rel.formats.includes('Vinyl') ? 10 : 0)
      + (h.rel.artists.some(x => sameArtist(a, normArtist(x))) ? 5 : 0);
    const best = hits.reduce((b, h) => (score(h) > score(b) ? h : b));
    last = { id: best.rel.id, at: now };
    return { id: best.rel.id, album: best.rel.title, year: best.rel.year || null, pos: best.t.pos, where: wherePos(best.t.pos),
      cover: best.rel.cover, link: 'https://www.discogs.com/release/' + best.rel.id };
  }

  // { user, token } saves them and loads the collection; anything else removes them and the saved copy.
  function configure(b) {
    const user = String(b?.user || '').trim(), token = String(b?.token || '').trim();
    if (user || token) {
      if (!USER.test(user)) throw Object.assign(new Error('That doesn\'t look like a Discogs username.'), { status: 400 });
      if (!token && user !== s.discogs.user) throw Object.assign(new Error('Add your Discogs personal access token too.'), { status: 400 });
      s.discogs = { user, token: token || s.discogs.token };
      if (cache.user !== user) { cache = { v: 2, user: '', syncedAt: 0, releases: {} }; index = null; }
      error = '';
      sync().catch(() => {});
    } else {
      s.discogs = { user: '', token: '' };
      cache = { v: 2, user: '', syncedAt: 0, releases: {} }; index = null; error = ''; last = null;
      try { fs.unlinkSync(file); } catch {}
    }
  }

  // Once a day, look for records added or removed. After a restart, carry on with the track lists.
  const check = () => { if (ready() && !syncing && (cache.user !== s.discogs.user || Date.now() - cache.syncedAt > DAY_MS)) sync().catch(() => {}); else pump(); };
  tg.after(5000, check);
  tg.every(3600 * 1000, check);

  // For checking why a song wasn't matched: the saved records whose artist or album contains the text.
  function find(q) {
    const k = words(fold(q));
    if (k.length < 2) return [];
    return Object.values(cache.releases).filter(r => words(fold(r.artists.join(' ') + ' ' + r.title)).includes(k)).slice(0, 20)
      .map(r => ({ id: r.id, title: r.title, year: r.year, artists: r.artists, formats: r.formats, tracks: r.tracks ? r.tracks.map(t => `${t.pos} ${t.title}`) : null, fails: r.fails }));
  }

  // Every record whose track list is loaded, for choosing one by hand: [{ id, title, artist, year, sides: [{ side, tracks }] }]
  function records() {
    if (!ready() || cache.user !== s.discogs.user) return [];
    return Object.values(cache.releases).filter(r => r.tracks?.length).map(r => {
      const sides = [];
      for (const t of r.tracks) { const k = sideOf(t.pos); const e = sides.find(x => x.side === k); if (e) e.tracks++; else sides.push({ side: k, tracks: 1 }); }
      return { id: r.id, title: r.title, artist: r.artists.map(shown).join(', '), year: r.year, sides };
    }).sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
  }
  // One side of a record, in playing order, or null:
  //   { id, album, artist, year, cover, link, side, tracks: [{ pos, where, title, artist, dur }] }
  function side(id, which) {
    const r = ready() && cache.user === s.discogs.user ? cache.releases[id] : null;
    const tracks = (r?.tracks || []).filter(t => sideOf(t.pos) === which);
    if (!tracks.length) return null;
    const artist = r.artists.map(shown).join(', ');
    return { id: r.id, album: r.title, artist, year: r.year || null, cover: r.cover, link: 'https://www.discogs.com/release/' + r.id, side: which,
      tracks: tracks.map(t => ({ pos: t.pos, where: wherePos(t.pos), title: t.title, artist: t.artists ? t.artists.map(shown).join(', ') : artist, dur: t.dur || null })) };
  }

  return {
    match, configure, wherePos, find, records, side,
    refresh: () => { if (!ready()) throw Object.assign(new Error('Add your Discogs username and token first.'), { status: 400 }); sync().catch(() => {}); },
    // (The token never goes to the page.)
    state: () => {
      const all = cache.user === s.discogs.user ? Object.values(cache.releases) : [];
      return { user: s.discogs.user, set: ready(), records: all.length, loaded: all.filter(r => r.tracks).length,
        syncing: syncing || (ready() && pending().length > 0 && !error), syncedAt: cache.syncedAt || null, error };
    },
    stop: () => { stopped = true; if (unsaved) store(); },
  };
};
module.exports.normTitle = normTitle; module.exports.normArtist = normArtist; module.exports.wherePos = wherePos;
