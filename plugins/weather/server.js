// Weather from Open-Meteo (free, no API key): now, the rain radar (radar.js: RainViewer over an
// OpenStreetMap land and sea map) and the next 3 days. The place is saved in data/weather.json; the
// page's place search sets it through POST /api/weather/place.
const { renderWeather, weatherUrl, WX_SPEED } = require('./public/render.js');

const DEFAULT_PLACE = { name: 'Warkworth', region: 'Auckland, New Zealand', lat: -36.4, lon: 174.66667, tz: 'Pacific/Auckland' };
const MAX_AGE = 30 * 60 * 1000, RADAR_EVERY = 10 * 60 * 1000;

module.exports = tg => {
  if (!tg.settings.place) { tg.settings.place = DEFAULT_PLACE; tg.save(); }
  const radar = require('./radar.js')(tg);
  let data = null, fetchedAt = 0;

  async function forecast() {
    if (data && Date.now() - fetchedAt < MAX_AGE) return data;
    const r = await fetch(weatherUrl(tg.settings.place), { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('Weather service returned ' + r.status);
    data = await r.json(); fetchedAt = Date.now();
    return data;
  }

  return {
    async render() {
      const place = tg.settings.place;
      const [d, rd] = await Promise.all([forecast(), radar.get(place).catch(e => ({ frames: [], error: e.message }))]);
      const key = `wx|${place.name}|${d.current.time}`, last = rd.frames.at(-1);
      const keys = [key, `wxr|${place.lat},${place.lon}|${last ? last.time : rd.error || 'none'}`, key, key, key];
      return { speed: WX_SPEED, parts: renderWeather(d, place.name, rd, place.tz).map((frames, i) => ({ key: keys[i], jobs: [{ screen: i, frames }] })) };
    },
    // While it's on a Times Gate: the radar every 10 minutes (the forecast is fetched again every 30).
    poll: { every: RADAR_EVERY, run: () => tg.update() },
    state: () => ({ place: tg.settings.place }),
    routes: {
      'POST /place': ({ body }) => {
        const p = body && body.place;
        if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number') throw Object.assign(new Error('place needs lat and lon'), { status: 400 });
        tg.settings.place = { name: String(p.name || ''), region: String(p.region || ''), lat: p.lat, lon: p.lon, tz: p.tz || 'auto' };
        tg.save(); data = null;
        tg.update();
        return { place: tg.settings.place };
      },
      // The radar's map and frames as images, for the page's previews.
      'GET /radar': () => radar.page(tg.settings.place),
    },
  };
};
