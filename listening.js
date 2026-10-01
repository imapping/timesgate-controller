// The listening log: every song heard or played, from any plugin (Vinyl, Spotify…), kept in an SQLite
// database (data/listening.db) for reports. Plugins use it through tg.listening (see PLUGINS.md).
// Uses better-sqlite3; if that isn't installed, the log is simply off.

const fs = require('fs');
const path = require('path');
let Database = null;
try { Database = require('better-sqlite3'); } catch {}

const FILE = path.join(__dirname, 'data', 'listening.db');
let db = null, reader = null, insert = null, lastSame = null, setNote = null, error = Database ? null : 'better-sqlite3 is not installed';

function open() {
  if (db || !Database) return db;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    db = new Database(FILE);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS plays (
        id          INTEGER PRIMARY KEY,
        at          INTEGER NOT NULL,   -- when it was heard or started, ms since 1970 (UTC)
        source      TEXT NOT NULL,      -- 'vinyl' (heard by the mic), 'spotify', …
        title       TEXT NOT NULL,
        artist      TEXT NOT NULL,
        album       TEXT,
        year        INTEGER,
        duration_ms INTEGER,
        isrc        TEXT,               -- the recording's international id, when known
        spotify_url TEXT,
        label       TEXT,
        position    TEXT,               -- where it is on the record ("B3"), when known
        tags        TEXT,               -- your marks on this play, comma-separated ("Skips,Crackles")
        note        TEXT                -- your comment on this play
      );
      CREATE INDEX IF NOT EXISTS plays_at ON plays (at);
      CREATE INDEX IF NOT EXISTS plays_artist ON plays (artist);
      CREATE UNIQUE INDEX IF NOT EXISTS plays_once ON plays (source, at, title, artist);
      -- Your favourite songs: by title and artist (whatever the capitals), so every play of the song counts.
      CREATE TABLE IF NOT EXISTS favourites (
        title  TEXT NOT NULL COLLATE NOCASE,
        artist TEXT NOT NULL COLLATE NOCASE,
        at     INTEGER NOT NULL,    -- when it was made a favourite
        PRIMARY KEY (title, artist)
      );
    `);
    // Logs made before notes existed get the new columns.
    const have = db.prepare('PRAGMA table_info(plays)').all().map(c => c.name);
    for (const col of ['position', 'tags', 'note']) if (!have.includes(col)) db.exec(`ALTER TABLE plays ADD COLUMN ${col} TEXT`);
    db.pragma('user_version = 2');
    insert = db.prepare(`INSERT OR IGNORE INTO plays (at, source, title, artist, album, year, duration_ms, isrc, spotify_url, label, position)
      VALUES (@at, @source, @title, @artist, @album, @year, @duration_ms, @isrc, @spotify_url, @label, @position)`);
    setNote = db.prepare('UPDATE plays SET tags = ?, note = ? WHERE id = ?');
    lastSame = db.prepare('SELECT at FROM plays WHERE source = ? AND title = ? AND artist = ? ORDER BY at DESC LIMIT 1');
    reader = new Database(FILE, { readonly: true });   // queries can only read
  } catch (e) { error = e.message; db = null; console.log('[listening] Could not open the log:', e.message); }
  return db;
}

const str = v => (v == null || v === '' ? null : String(v).slice(0, 300));
const int = v => (Number.isFinite(Number(v)) && v !== '' && v != null ? Math.round(Number(v)) : null);

// Add a play: { source, title, artist, at?, album?, year?, duration_ms?, isrc?, spotify_url?, label?, position? }.
// Skipped (returns null) if the same song from the same source was logged less than most of its
// length ago, e.g. when the controller restarts mid-song. Returns the new row id.
function add(p, source) {
  if (!open()) return null;
  const play = {
    at: int(p.at) || Date.now(), source: str(p.source || source) || 'unknown',
    title: str(p.title), artist: str(p.artist), album: str(p.album), year: int(p.year),
    duration_ms: int(p.duration_ms), isrc: str(p.isrc), spotify_url: str(p.spotify_url), label: str(p.label), position: str(p.position),
  };
  if (!play.title || !play.artist) return null;
  if (!p.force) {
    const prev = lastSame.get(play.source, play.title, play.artist);
    const window = play.duration_ms ? Math.min(play.duration_ms * 0.8, 10 * 60000) : 3 * 60000;
    if (prev && Math.abs(play.at - prev.at) < window) return null;
  }
  const r = insert.run(play);
  return r.changes ? Number(r.lastInsertRowid) : null;
}

// Run a read-only SQL query, e.g. query('SELECT artist, COUNT(*) n FROM plays GROUP BY artist ORDER BY n DESC LIMIT 10').
function query(sql, params = []) {
  if (!open()) throw new Error('The listening log is not available: ' + error);
  const stmt = reader.prepare(sql);
  return Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
}

// Your marks and comment on one play: annotate(id, { tags: ['Skips', …], note: 'jumps in the chorus' }).
// Empty tags and note clear them. Returns the play, or null if there's no such play.
const TAG = /^[\p{L}\p{N}][\p{L}\p{N} '-]{0,23}$/u;
function annotate(id, { tags, note } = {}) {
  if (!open()) throw new Error('The listening log is not available: ' + error);
  const list = [...new Set((Array.isArray(tags) ? tags : []).map(t => String(t).trim()).filter(t => TAG.test(t)))].slice(0, 8);
  const text = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!setNote.run(list.join(',') || null, text || null, int(id)).changes) return null;
  return db.prepare('SELECT id, at, source, title, artist, album, position, tags, note FROM plays WHERE id = ?').get(int(id));
}

// Make a song a favourite, or not: favourite('Walk of Life', 'Dire Straits', true). Returns { title, artist, favourite }.
function favourite(title, artist, on) {
  if (!open()) throw new Error('The listening log is not available: ' + error);
  title = str(title); artist = str(artist);
  if (!title || !artist) return null;
  if (on) db.prepare('INSERT OR IGNORE INTO favourites (title, artist, at) VALUES (?, ?, ?)').run(title, artist, Date.now());
  else db.prepare('DELETE FROM favourites WHERE title = ? AND artist = ?').run(title, artist);
  return { title, artist, favourite: !!on };
}

function stats() {
  if (!open()) return { available: false, error };
  const s = reader.prepare('SELECT COUNT(*) plays, MIN(at) first, MAX(at) last FROM plays').get();
  return { available: true, ...s };
}

module.exports = { add, query, annotate, favourite, stats, available: () => !!open(), FILE };
