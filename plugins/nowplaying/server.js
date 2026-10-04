// Now Playing: one answer to "what's playing?" for the full-screen page (public/now.html), from Spotify
// and Vinyl. It draws nothing on the Times Gate.
module.exports = tg => {
  const get = path => fetch(`http://127.0.0.1:${tg.port}/api/${path}`, { signal: AbortSignal.timeout(4000) })
    .then(r => (r.ok ? r.json() : null)).catch(() => null);

  // A bigger copy of a cover, where the address says the size: Spotify's 300px → 640px, Apple's 300px → 600px.
  const bigArt = u => (u || '')
    .replace(/^(https:\/\/i\.scdn\.co\/image\/ab67616d)00001e02/, '$10000b273')
    .replace(/\/\d+x\d+bb\.(jpg|png|webp)$/, '/600x600bb.$1') || null;

  const isFav = (title, artist) => {
    if (!title || !artist || !tg.listening.available) return false;
    try { return tg.listening.query('SELECT 1 FROM favourites WHERE title = ? AND artist = ?', [title, artist]).length > 0; } catch { return false; }
  };

  // Spotify while it plays; otherwise the record Vinyl is listening to; otherwise a paused Spotify song.
  async function now() {
    const [sp, vn] = await Promise.all([get('spotify/now'), get('vinyl/now')]);
    const base = { at: Date.now(), vinyl: !!vn, listening: !!vn?.active };
    const spotify = it => ({ ...base, source: 'spotify', playing: !!sp.playing, title: it.name, artist: it.artist, album: it.album,
      year: it.year, art: it.artLarge || bigArt(it.art), progressMs: it.progress ?? null, durationMs: it.duration || null });
    let out;
    if (sp?.item && sp.playing) out = spotify(sp.item);
    else if (vn?.active) {
      const t = vn.track;
      out = { ...base, source: 'vinyl', status: vn.status, between: vn.phase === 'waiting' };
      if (t) Object.assign(out, { playing: vn.phase === 'playing' || vn.phase === 'identifying', title: t.title, artist: t.artist,
        album: t.album, year: t.year, where: t.where, art: bigArt(t.art),
        progressMs: t.startedAt ? Date.now() - t.startedAt : null, durationMs: t.lengthMs });
    } else if (sp?.item) out = spotify(sp.item);
    else out = { ...base, source: null };
    out.fav = isFav(out.title, out.artist);
    return out;
  }

  return {
    routes: { 'GET /now': () => now() },
  };
};
