// The listening log: every song heard or played, from any plugin (Vinyl, Spotify…), kept in an SQLite
// database (data/listening.db) for reports. Plugins use it through tg.listening (see PLUGINS.md).
// Uses better-sqlite3; if that isn't installed, the log is simply off.

const fs = require('fs');
const path = require('path');
let Database = null;
try { Database = require('better-sqlite3'); } catch {}

const FILE = path.join(__dirname, 'data', 'listening.db');
let db = null, reader = null, insert = null, lastSame = null, error = Database ? null : 'better-sqlite3 is not installed';

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
        label       TEXT
      );
      CREATE INDEX IF NOT EXISTS plays_at ON plays (at);
      CREATE INDEX IF NOT EXISTS plays_artist ON plays (artist);
      CREATE UNIQUE INDEX IF NOT EXISTS plays_once ON plays (source, at, title, artist);
    `);
    db.pragma('user_version = 1');
    insert = db.prepare(`INSERT OR IGNORE INTO plays (at, source, title, artist, album, year, duration_ms, isrc, spotify_url, label)
      VALUES (@at, @source, @title, @artist, @album, @year, @duration_ms, @isrc, @spotify_url, @label)`);
    lastSame = db.prepare('SELECT at FROM plays WHERE source = ? AND title = ? AND artist = ? ORDER BY at DESC LIMIT 1');
    reader = new Database(FILE, { readonly: true });   // queries can only read
  } catch (e) { error = e.message; db = null; console.log('[listening] Could not open the log:', e.message); }
  return db;
}

const str = v => (v == null || v === '' ? null : String(v).slice(0, 300));
const int = v => (Number.isFinite(Number(v)) && v !== '' && v != null ? Math.round(Number(v)) : null);

// Add a play: { source, title, artist, at?, album?, year?, duration_ms?, isrc?, spotify_url?, label? }.
// Skipped (returns null) if the same song from the same source was logged less than most of its
// length ago, e.g. when the controller restarts mid-song. Returns the new row id.
function add(p, source) {
  if (!open()) return null;
  const play = {
    at: int(p.at) || Date.now(), source: str(p.source || source) || 'unknown',
    title: str(p.title), artist: str(p.artist), album: str(p.album), year: int(p.year),
    duration_ms: int(p.duration_ms), isrc: str(p.isrc), spotify_url: str(p.spotify_url), label: str(p.label),
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

function stats() {
  if (!open()) return { available: false, error };
  const s = reader.prepare('SELECT COUNT(*) plays, MIN(at) first, MAX(at) last FROM plays').get();
  return { available: true, ...s };
}

module.exports = { add, query, stats, available: () => !!open(), FILE };
