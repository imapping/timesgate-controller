// Weather panel: place search, the forecast summary and previews. The screens are drawn by
// render.js (also used by server.js to keep the device updated). The place is kept in the server.
(() => {
  const p = TG.plugin('weather');
  const $p = sel => p.el(sel);
  let place = null, data = null;

  async function fetchWeather() {
    const r = await fetch(weatherUrl(place));
    if (!r.ok) throw new Error('Weather service returned ' + r.status);
    data = await r.json();
    summarise();
  }
  function summarise() {
    const cur = data.current, day = data.daily, [, label] = wxInfo(cur.weather_code);
    const rows = day.time.slice(0, 4).map((d, i) => {
      const name = i === 0 ? 'Today' : new Date(d + 'T12:00:00').toLocaleDateString('en-NZ', { weekday: 'long' });
      return `<tr><td>${name}</td><td>${wxInfo(day.weather_code[i])[1]}</td><td>${Math.round(day.temperature_2m_max[i])}° / ${Math.round(day.temperature_2m_min[i])}°</td><td>${day.precipitation_probability_max[i] ?? 0}% rain</td></tr>`;
    }).join('');
    $p('#wxSummary').innerHTML =
      `<p style="margin:0 0 8px"><b>Now:</b> ${Math.round(cur.temperature_2m)}°C, ${label.toLowerCase()} · feels ${Math.round(cur.apparent_temperature)}° · ` +
      `wind ${compass(cur.wind_direction_10m)} ${Math.round(cur.wind_speed_10m)} km/h · humidity ${cur.relative_humidity_2m}%</p>` +
      `<table class="wx">${rows}</table><p class="hint">Updated ${new Date().toLocaleTimeString()} · data by Open-Meteo</p>`;
  }
  async function refresh() {
    try { await fetchWeather(); } catch (e) { log('Weather: ' + e.message, 'e'); p.info('Could not load weather.'); }
  }

  // Preview always fetches fresh data (it's quick and free).
  p.preview = async () => {
    if (!place) return null;
    await refresh();
    return data && { speed: WX_SPEED, parts: renderWeather(data, place.name).map((frames, i) => ({ key: i, jobs: [{ screen: i, frames }] })) };
  };

  async function searchPlace() {
    const q = $p('#wxPlace').value.trim();
    if (!q) return;
    const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=8&name=' + encodeURIComponent(q.split(',')[0]));
    const list = (await r.json()).results || [];
    const box = $p('#wxResults');
    box.innerHTML = ''; box.hidden = false;
    if (!list.length) { box.innerHTML = '<div class="hint" style="padding:10px">No places found.</div>'; return; }
    for (const pl of list) {
      const b = document.createElement('button');
      b.innerHTML = '<b></b> <small></small>';
      b.firstChild.textContent = pl.name;
      b.lastChild.textContent = [pl.admin1, pl.country].filter(Boolean).join(', ');
      b.onclick = async () => {
        box.hidden = true; $p('#wxPlace').value = '';
        const s = await p.api('place', { place: { name: pl.name, region: b.lastChild.textContent, lat: pl.latitude, lon: pl.longitude, tz: pl.timezone } })
          .catch(e => log('Weather: ' + e.message, 'e'));
        if (s) setPlace(s.place, true);
      };
      box.append(b);
    }
  }

  // The place lives in the server; follow it (and reload the forecast) when it changes.
  function setPlace(pl, show) {
    if (!pl || (place && place.lat === pl.lat && place.lon === pl.lon)) return;
    place = pl;
    $p('#wxWhere').textContent = `${place.name}, ${place.region}`;
    if (show) p.runPreview(); else refresh();
  }
  p.onState(s => setPlace(s.place, false));

  $p('#wxSearch').onclick = searchPlace;
  $p('#wxPlace').onkeydown = e => { if (e.key === 'Enter') searchPlace(); };
})();
