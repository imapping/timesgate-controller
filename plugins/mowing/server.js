// Mowing Tracker (www.mowingtracker.com): which areas of the property are due for mowing. Reads its
// read-only status API every 10 minutes with the user's API key, and shows a map of the property
// coloured by status, the most urgent area, the counts, and the next few areas.
// Settings in data/mowing.json: { key }. The key is set from this computer (or a trusted one) only,
// and never sent to the page. Nothing can be changed through the API.
const { mwParts, MW_SPEED } = require('./public/render.js');

// Exactly this host: the others redirect to it, and fetch drops the key on a redirect to another host.
// (TG_MOWING_API points it at a pretend server, for testing.)
const API = process.env.TG_MOWING_API || 'https://www.mowingtracker.com/api/status.ashx';
const ORIGIN = new URL(API).origin;
const CHECK_MS = 10 * 60 * 1000;     // the status only changes a few times a day
const KEY = /^mt_\S{8,300}$/;

module.exports = tg => {
  const s = tg.settings;
  s.key ??= '';
  let data = null, error = '', checkedAt = 0, checking = null;
  let photo = null;   // { url, img }: the property photo, for the map

  async function get(url, key = s.key) {
    return fetch(url, { headers: { Authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  }
  async function fetchStatus(key) {
    const r = await get(API, key);
    if (r.status === 404) throw new Error('Mowing Tracker\'s status API isn\'t available yet.');
    const d = await r.json().catch(() => null);
    if (r.status === 401) throw new Error('Mowing Tracker didn\'t accept the API key (it may have been deleted).');
    if (!r.ok) throw new Error(d?.message || `Mowing Tracker error ${r.status}`);
    if (!d || d.apiVersion !== 1 || !Array.isArray(d.areas)) throw new Error('Unexpected reply from Mowing Tracker.');
    return d;
  }
  // The photo comes from Mowing Tracker itself (sent with the key, in case it isn't public).
  const photoUrl = () => (data?.image?.url && data.image.url.startsWith(ORIGIN + '/') ? data.image.url : null);
  async function loadPhoto() {
    const url = photoUrl();
    if (!url) { photo = null; return; }
    if (photo?.url === url) return;
    try {
      const r = await get(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      photo = { url, img: await tg.loadImage(Buffer.from(await r.arrayBuffer())) };
    } catch (e) { photo = { url, img: null }; tg.log('The property photo didn\'t load:', e.message); }
  }

  function check() {
    if (!s.key) { data = null; error = ''; return Promise.resolve(); }
    if (checking) return checking;
    checking = (async () => {
      try { data = await fetchStatus(s.key); error = ''; await loadPhoto(); }
      catch (e) { error = e.message; tg.log('Check failed:', e.message); }
      checkedAt = Date.now();
      tg.update();
    })().finally(() => { checking = null; });
    return checking;
  }

  function view() {
    if (!s.key) throw Object.assign(new Error('Add your Mowing Tracker API key in the Mowing card first.'), { status: 400 });
    if (!data) throw Object.assign(new Error(error || 'Still loading from Mowing Tracker…'), { status: 503 });
    return data;
  }
  const state = () => ({
    hasKey: !!s.key, error, checkedAt,
    property: data?.propertyName || null, today: data?.today || null, summary: data?.summary || null, photo: !!photoUrl(),
    areas: (data?.areas || []).map(a => ({ name: a.name, status: a.status, statusText: a.statusText, lastMowed: a.lastMowed, intervalDays: a.intervalDays })),
  });
  const localOnly = ctx => { if (!ctx.local) throw Object.assign(new Error('Change the API key from the computer running the controller, or one it trusts.'), { status: 403 }); };

  tg.after(3000, check);
  tg.every(CHECK_MS, check);

  return {
    render: () => ({ speed: MW_SPEED, parts: mwParts(view(), photo?.img || null) }),
    state,
    routes: {
      'GET /view': () => view(),
      // The property photo, for the page's previews.
      'GET /image': async ({ res }) => {
        const url = photoUrl();
        if (!url) throw Object.assign(new Error('No photo'), { status: 404 });
        const r = await get(url);
        if (!r.ok) throw Object.assign(new Error('The photo didn\'t load'), { status: 502 });
        res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'max-age=3600' });
        res.end(Buffer.from(await r.arrayBuffer()));
      },
      'POST /check': async () => { await check(); return state(); },
      // { key } saves it (after checking it works); { key: '' } removes it.
      'POST /options': async ctx => {
        const b = ctx.body || {};
        if (typeof b.key === 'string') {
          localOnly(ctx);
          const key = b.key.trim();
          if (key && !KEY.test(key)) throw Object.assign(new Error('A Mowing Tracker API key starts with mt_ (from the Setup page on mowingtracker.com).'), { status: 400 });
          if (key) {
            try { data = await fetchStatus(key); } catch (e) { throw Object.assign(new Error(e.message), { status: 400 }); }
            error = ''; checkedAt = Date.now();
          } else { data = null; photo = null; error = ''; }
          s.key = key; tg.save();
          if (key) { await loadPhoto(); tg.update(); }
        }
        return state();
      },
    },
    actions: {
      check: { label: 'check Mowing Tracker now', run: () => check() },
    },
  };
};
