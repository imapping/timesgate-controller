// Weather from Open-Meteo (free, no API key): now + the next 4 days. The place is saved in
// data/weather.json; the page's place search sets it through POST /api/weather/place.
const { renderWeather, weatherUrl, WX_SPEED } = require('./public/render.js');

const DEFAULT_PLACE = { name: 'Warkworth', region: 'Auckland, New Zealand', lat: -36.4, lon: 174.66667, tz: 'Pacific/Auckland' };
const MAX_AGE = 30 * 60 * 1000;

module.exports = tg => {
  if (!tg.settings.place) { tg.settings.place = DEFAULT_PLACE; tg.save(); }
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
      const d = await forecast(), place = tg.settings.place;
      const key = `wx|${place.name}|${d.current.time}`;
      return { speed: WX_SPEED, parts: renderWeather(d, place.name).map((frames, i) => ({ key, jobs: [{ screen: i, frames }] })) };
    },
    poll: { every: MAX_AGE, run: () => { data = null; tg.update(); } },
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
    },
  };
};
