// Listening reports: reads the listening log (data/listening.db, filled by Vinyl and Spotify)
// through tg.listening.query, and summarises it for the card and the screens: totals, top artists,
// songs and albums, plays over time, plays by hour of the day, and the latest plays.
// Settings in data/reports.json: { range, source } (what the card and screens show).
const { rpRender, RP_SPEED } = require('./public/render.js');

const RANGES = { '7d': 7, '30d': 30, '365d': 365, all: null };   // days back, counting today
const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;   // matches SQLite's date(…, 'localtime')

module.exports = tg => {
  const s = tg.settings;
  if (!(s.range in RANGES)) s.range = '30d';
  s.source ??= 'all';

  // The plays you've marked or commented on (it skips, crackles…), newest first, and how many have each mark.
  function notes(q) {
    const rows = q(`SELECT id, at, source, title, artist, album, position, tags, note FROM plays
      WHERE {W} AND (tags IS NOT NULL OR note IS NOT NULL) ORDER BY at DESC LIMIT 200`);
    const count = {};
    for (const r of rows) for (const t of String(r.tags || '').split(',').filter(Boolean)) count[t] = (count[t] || 0) + 1;
    return { total: rows.length, byTag: Object.entries(count).map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)), rows: rows.slice(0, 50) };
  }

  function summary(range = s.range, source = s.source) {
    if (!tg.listening.available) throw Object.assign(new Error('The listening log isn\'t available on this computer.'), { status: 503 });
    if (!(range in RANGES)) range = '30d';
    if (!/^[a-z0-9-]{1,32}$/.test(source)) source = 'all';
    const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // Counted back in calendar days, not hours, so a daylight-saving change doesn't shift the start.
    const since = RANGES[range] ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - (RANGES[range] - 1)).getTime() : 0;
    const WHERE = `at >= ? AND (? = 'all' OR source = ?)`, P = [since, source, source];
    const q = sql => tg.listening.query(sql.replace('{W}', WHERE), P);
    const LOCAL = `at / 1000, 'unixepoch', 'localtime'`;

    const t = q(`SELECT COUNT(*) plays, COUNT(DISTINCT artist) artists, COUNT(DISTINCT title || '|' || artist) songs,
      SUM(duration_ms) ms, COUNT(duration_ms) timed, MIN(at) first, MAX(at) last FROM plays WHERE {W}`)[0];
    // Listening time: the known lengths, plus the average length for plays without one.
    const ms = t.timed ? Math.round(t.ms + (t.plays - t.timed) * (t.ms / t.timed)) : null;

    // Plays over time: by day for a week or a month, by month for a year or everything.
    const byMonth = range === '365d' || range === 'all';
    const rows = q(`SELECT ${byMonth ? `strftime('%Y-%m', ${LOCAL})` : `date(${LOCAL})`} k, COUNT(*) n FROM plays WHERE {W} GROUP BY k`);
    const count = Object.fromEntries(rows.map(r => [r.k, r.n])), points = [];
    if (byMonth) {
      const from = new Date(range === 'all' ? (t.first || now.getTime()) : since);
      for (let d = new Date(from.getFullYear(), from.getMonth(), 1); d <= now; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
        const k = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
        points.push({ key: k, label: d.toLocaleDateString('en-NZ', { month: 'short', year: '2-digit' }), n: count[k] || 0 });
      }
    } else {
      for (let d = new Date(since); d <= today; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1))
        points.push({ key: dayKey(d), label: d.toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' }), n: count[dayKey(d)] || 0 });
    }

    const hours = Array(24).fill(0);
    for (const r of q(`SELECT CAST(strftime('%H', ${LOCAL}) AS INTEGER) h, COUNT(*) n FROM plays WHERE {W} GROUP BY h`)) hours[r.h] = r.n;

    return {
      range, source, since, generatedAt: now.getTime(),
      totals: { plays: t.plays, artists: t.artists, songs: t.songs, ms, first: t.first, last: t.last },
      // Every source with plays in this period (whatever the source filter), for the card's picker.
      sources: tg.listening.query('SELECT source, COUNT(*) n FROM plays WHERE at >= ? GROUP BY source ORDER BY n DESC', [since]),
      topArtists: q(`SELECT artist, COUNT(*) n FROM plays WHERE {W} GROUP BY artist COLLATE NOCASE ORDER BY n DESC, MAX(at) DESC LIMIT 10`),
      topSongs: q(`SELECT title, artist, COUNT(*) n, MAX(spotify_url) spotify,
        EXISTS (SELECT 1 FROM favourites f WHERE f.title = plays.title AND f.artist = plays.artist) fav FROM plays WHERE {W}
        GROUP BY title COLLATE NOCASE, artist COLLATE NOCASE ORDER BY n DESC, MAX(at) DESC LIMIT 10`),
      topAlbums: q(`SELECT album, artist, COUNT(*) n FROM plays WHERE {W} AND album IS NOT NULL AND album != ''
        GROUP BY album COLLATE NOCASE, artist COLLATE NOCASE ORDER BY n DESC, MAX(at) DESC LIMIT 10`),
      series: { unit: byMonth ? 'month' : 'day', points },
      hours,
      recent: q(`SELECT id, at, source, title, artist, album, spotify_url spotify, tags, note,
        EXISTS (SELECT 1 FROM favourites f WHERE f.title = plays.title AND f.artist = plays.artist) fav FROM plays WHERE {W} ORDER BY at DESC LIMIT 12`),
      // Your favourite songs (all of them), with their plays in this period.
      favourites: q(`SELECT f.title, f.artist, 1 fav, (SELECT COUNT(*) FROM plays WHERE f.title = plays.title AND f.artist = plays.artist AND {W}) n,
        (SELECT MAX(spotify_url) FROM plays WHERE f.title = plays.title AND f.artist = plays.artist) spotify
        FROM favourites f ORDER BY n DESC, f.at DESC LIMIT 100`),
      notes: notes(q),
    };
  }

  return {
    render: () => ({ speed: RP_SPEED, parts: rpRender(summary()).map((sc, i) => ({ key: sc.key, jobs: [{ screen: i, frames: sc.frames }] })) }),
    // New plays arrive from other plugins: look again every minute (only changed screens are re-sent).
    poll: { every: 60 * 1000, run: () => tg.update() },
    state: () => ({ available: tg.listening.available, range: s.range, source: s.source, plays: tg.listening.available ? tg.listening.stats().plays : 0,
      // (changes when a note is added, changed or removed anywhere, so the card reloads)
      noted: tg.listening.available ? tg.listening.query(`SELECT (SELECT COUNT(*) || ':' || COALESCE(MAX(at), 0) FROM favourites) || ':' || COUNT(*) || ':' || COALESCE(SUM(LENGTH(COALESCE(tags, '')) + LENGTH(COALESCE(note, ''))), 0) k FROM plays WHERE tags IS NOT NULL OR note IS NOT NULL`)[0].k : '' }),
    routes: {
      // ?range=7d|30d|365d|all&source=all|vinyl|spotify (defaults: the saved choice)
      'GET /summary': ({ query }) => summary(query.get('range') || undefined, query.get('source') || undefined),
      // What the card and the screens show: { range, source }
      'POST /options': ({ body }) => {
        const b = body || {};
        if (b.range in RANGES) s.range = b.range;
        if (typeof b.source === 'string' && /^[a-z0-9-]{1,32}$/.test(b.source)) s.source = b.source;
        tg.save(); tg.update();
        return summary();
      },
    },
  };
};
