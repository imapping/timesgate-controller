// Spotify now playing. Authorization Code + PKCE, so only the app's Client ID is needed (no secret).
// The login is kept in data/spotify.json and refreshed automatically. Scope is read-only playback info.
const crypto = require('crypto');
const { renderSpotify, spArtColours } = require('./public/render.js');

const SCOPE = 'user-read-currently-playing user-read-playback-state';

module.exports = tg => {
  const redirect = () => `http://127.0.0.1:${tg.port}/api/spotify/callback`;
  let pending = null;                 // { state, verifier } while a login is in progress
  let cache = { at: 0, data: null };
  let lastKey = null;
  const artCache = new Map();         // art URL -> spArtColours(image)
  const sp = () => tg.settings;       // { clientId, accessToken, expiresAt, refreshToken }

  async function token(params) {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: sp().clientId, ...params }), signal: AbortSignal.timeout(10000),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error_description || d.error || `Spotify token error ${r.status}`);
    sp().accessToken = d.access_token;
    sp().expiresAt = Date.now() + (d.expires_in - 60) * 1000;
    if (d.refresh_token) sp().refreshToken = d.refresh_token;
    tg.save();
  }

  // A Spotify Web API GET with the saved login, refreshing it when needed.
  async function apiGet(url) {
    const get = async () => {
      if (!sp().accessToken || Date.now() > sp().expiresAt)
        await token({ grant_type: 'refresh_token', refresh_token: sp().refreshToken });
      return fetch(url, { headers: { Authorization: 'Bearer ' + sp().accessToken }, signal: AbortSignal.timeout(10000) });
    };
    let r = await get();
    if (r.status === 401) { sp().accessToken = null; r = await get(); }
    return r;
  }

  async function nowPlaying() {
    if (!sp().refreshToken) return { connected: false };
    if (Date.now() - cache.at < 3000) return cache.data;  // several tabs polling share one lookup
    const r = await apiGet('https://api.spotify.com/v1/me/player/currently-playing?additional_types=track,episode');
    let data;
    if (r.status === 204) data = { connected: true, item: null };
    else if (r.status === 429) return cache.data || { connected: true, item: null };  // rate limited: keep what we had
    else if (!r.ok) throw new Error(`Spotify error ${r.status}`);
    else {
      const d = await r.json(), it = d.item;
      const images = it ? (it.album?.images || it.images || []) : [];
      // Smallest image that's still at least 128px (Spotify lists them largest first).
      const art = images.filter(i => (i.width || 640) >= 128).pop() || images[0];
      data = { connected: true, playing: !!d.is_playing, item: it && {
        id: it.id, type: it.type, name: it.name,
        artist: it.artists ? it.artists.map(a => a.name).join(', ') : (it.show?.name || ''),
        album: it.album?.name || it.show?.name || '',
        art: art?.url || null, artLarge: images[0]?.url || null, duration: it.duration_ms, progress: d.progress_ms,
        url: it.external_urls?.spotify || null, isrc: it.external_ids?.isrc || null,
        year: (it.album?.release_date || '').slice(0, 4) || null,
      } };
    }
    cache = { at: Date.now(), data };
    return data;
  }

  async function artFor(url) {
    if (!url) return null;
    if (!artCache.has(url)) {
      artCache.set(url, spArtColours(await tg.loadImage(url)));
      if (artCache.size > 50) artCache.delete(artCache.keys().next().value);
    }
    return artCache.get(url);
  }

  // The listening log (data/listening.db): a song counts as played once it has played for 30 s
  // (Spotify's own rule). Checked every 20 s while logged in, whether or not Spotify is on the screens.
  let counted = null;   // { id, startedAt } of the play already logged
  tg.every(20000, async () => {
    if (!sp().refreshToken || !tg.listening.available) return;
    const d = await nowPlaying().catch(() => null), it = d && d.item;
    if (!it || !d.playing || it.type !== 'track' || !(it.progress >= 30000)) return;
    const startedAt = Date.now() - it.progress;
    // Same play if it started within a song's length of the one logged (allows for seeking).
    if (counted && counted.id === it.id && Math.abs(counted.startedAt - startedAt) < (it.duration || 180000)) return;
    counted = { id: it.id, startedAt };
    try {
      tg.listening.add({ at: startedAt, title: it.name, artist: it.artist, album: it.album, year: it.year,
        duration_ms: it.duration, isrc: it.isrc, spotify_url: it.url });
    } catch (e) { tg.log('Listening log:', e.message); }
  });

  const localOnly = ctx => {
    if (!ctx.local) throw Object.assign(new Error(`Open the page at http://127.0.0.1:${tg.port} on the computer running the controller to set up Spotify (for a Raspberry Pi, through an SSH tunnel: see the README).`), { status: 403 });
  };

  return {
    async render() {
      const d = await nowPlaying();
      if (d.connected === false) throw new Error('Spotify is not connected');
      return { speed: 1000, parts: renderSpotify(d, d.item ? await artFor(d.item.art) : null) };
    },
    // While live: redraw when the song changes or it's paused/played.
    poll: {
      every: 5000,
      async run() {
        const d = await nowPlaying();
        const key = d.item ? d.item.id + d.playing : 'none';
        if (key !== lastKey) { lastKey = key; tg.update(); }
      },
    },
    live: () => { lastKey = null; },
    state: () => ({ connected: !!sp().refreshToken }),
    routes: {
      'GET /status': () => ({ clientId: sp().clientId || '', connected: !!sp().refreshToken, redirect: redirect() }),
      'GET /now': () => nowPlaying(),
      // Find a song on Spotify (other plugins use this, e.g. Vinyl for links and covers):
      // ?title=&artist= → { found: { url, art, isrc, duration, title, artist } or null }
      'GET /search': async ctx => {
        if (!ctx.local) throw Object.assign(new Error('Only from the computer running the controller, or one it trusts.'), { status: 403 });
        const title = (ctx.query.get('title') || '').replace(/"/g, ''), artist = (ctx.query.get('artist') || '').replace(/"/g, '');
        if (!sp().refreshToken || !title) return { found: null };
        const q = `track:${title}` + (artist ? ` artist:${artist.split(/,|&| feat\.? /i)[0].trim()}` : '');
        const r = await apiGet('https://api.spotify.com/v1/search?type=track&limit=1&q=' + encodeURIComponent(q));
        if (!r.ok) return { found: null };
        const it = (await r.json()).tracks?.items?.[0];
        if (!it) return { found: null };
        const imgs = it.album?.images || [];
        return { found: { url: it.external_urls?.spotify || null, isrc: it.external_ids?.isrc || null, duration: it.duration_ms,
          art: (imgs.filter(i => (i.width || 640) >= 128).pop() || imgs[0])?.url || null,
          title: it.name, artist: (it.artists || []).map(a => a.name).join(', ') } };
      },
      // Album art, relayed so the page can draw it on a canvas (only Spotify's image CDN).
      'GET /art': async ({ query, res }) => {
        const u = query.get('u') || '';
        if (!/^https:\/\/i\.scdn\.co\/image\/[A-Za-z0-9]+$/.test(u)) throw Object.assign(new Error('Bad image URL'), { status: 400 });
        const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'max-age=86400' });
        res.end(Buffer.from(await r.arrayBuffer()));
      },
      // Setting up and logging in only from this computer (Spotify redirects back to 127.0.0.1 anyway).
      'POST /config': ctx => {
        localOnly(ctx);
        const { clientId } = ctx.body || {};
        if (!/^[0-9a-f]{32}$/i.test(clientId || '')) throw Object.assign(new Error('That doesn\'t look like a Spotify Client ID (32 letters/digits).'), { status: 400 });
        if (clientId !== sp().clientId) tg.settings = { clientId };  // new app: old login no longer applies
        tg.save();
        return { ok: true };
      },
      'POST /logout': ctx => {
        localOnly(ctx);
        tg.setLive(false);
        tg.settings = { clientId: sp().clientId }; tg.save(); cache = { at: 0, data: null };
        return { ok: true };
      },
      'GET /login': ctx => {
        localOnly(ctx);
        if (!sp().clientId) { ctx.res.writeHead(302, { Location: '/#plugin-spotify' }); return ctx.res.end(); }
        const verifier = crypto.randomBytes(48).toString('base64url');
        pending = { state: crypto.randomBytes(12).toString('hex'), verifier };
        const q = new URLSearchParams({ client_id: sp().clientId, response_type: 'code', redirect_uri: redirect(),
          scope: SCOPE, state: pending.state, code_challenge_method: 'S256',
          code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') });
        ctx.res.writeHead(302, { Location: 'https://accounts.spotify.com/authorize?' + q });
        ctx.res.end();
      },
      'GET /callback': async ctx => {
        localOnly(ctx);
        const code = ctx.query.get('code'), state = ctx.query.get('state');
        let msg = 'connected';
        if (!pending || state !== pending.state) msg = 'Login expired — try Connect again.';
        else if (!code) msg = ctx.query.get('error') || 'Login cancelled.';
        else {
          try { await token({ grant_type: 'authorization_code', code, redirect_uri: redirect(), code_verifier: pending.verifier }); }
          catch (e) { msg = e.message; }
        }
        pending = null; cache = { at: 0, data: null };
        ctx.res.writeHead(302, { Location: '/?spotify=' + encodeURIComponent(msg) + '#plugin-spotify' });
        ctx.res.end();
      },
    },
  };
};
