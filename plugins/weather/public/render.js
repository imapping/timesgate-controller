// Draws the weather screens from an Open-Meteo forecast. Shared by the page (previews) and the
// server (engine.js). Screen 1 shows current conditions; screens 2-5 today + the next 3 days.
// Icons are animated as short loops. Needs a global makeCanvas(w, h).

const WX_FRAMES = 8, WX_SPEED = 180;

// Open-Meteo query for a place ({ lat, lon, tz }).
function weatherUrl(place) {
  return 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: place.lat, longitude: place.lon, timezone: place.tz || 'auto', forecast_days: 5,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  });
}

// WMO weather codes → icon kind + label
function wxInfo(code) {
  if (code === 0) return ['clear', 'Clear'];
  if (code === 1) return ['clear', 'Mainly clear'];
  if (code === 2) return ['partly', 'Partly cloudy'];
  if (code === 3) return ['cloud', 'Overcast'];
  if (code === 45 || code === 48) return ['fog', 'Fog'];
  if (code >= 51 && code <= 57) return ['drizzle', 'Drizzle'];
  if (code >= 61 && code <= 67) return ['rain', code >= 65 ? 'Heavy rain' : 'Rain'];
  if (code >= 71 && code <= 77) return ['snow', 'Snow'];
  if (code >= 80 && code <= 82) return ['rain', 'Showers'];
  if (code === 85 || code === 86) return ['snow', 'Snow showers'];
  if (code >= 95) return ['storm', 'Thunderstorm'];
  return ['cloud', 'Cloudy'];
}
const compass = deg => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];

// ---------- icon drawing (t = 0..1 animation phase) ----------
function drawSun(c, x, y, r, t) {
  c.save(); c.translate(x, y); c.rotate(t * Math.PI / 4);
  c.strokeStyle = '#ffc93c'; c.lineWidth = r * 0.14; c.lineCap = 'round';
  const pulse = 1 + 0.08 * Math.sin(t * Math.PI * 2);
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    c.beginPath(); c.moveTo(Math.cos(a) * r * 0.72, Math.sin(a) * r * 0.72);
    c.lineTo(Math.cos(a) * r * pulse, Math.sin(a) * r * pulse); c.stroke();
  }
  c.restore();
  c.fillStyle = '#ffb000'; c.beginPath(); c.arc(x, y, r * 0.5, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#ffd95a'; c.beginPath(); c.arc(x - r * 0.1, y - r * 0.1, r * 0.34, 0, Math.PI * 2); c.fill();
}
function drawMoon(c, x, y, r, t) {
  c.fillStyle = '#e8e6d0'; c.beginPath(); c.arc(x, y, r * 0.55, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#0b1530'; c.beginPath(); c.arc(x + r * 0.28, y - r * 0.18, r * 0.48, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#fff';
  [[-0.9, -0.7, 0], [0.8, 0.6, 0.4], [-0.6, 0.8, 0.7]].forEach(([dx, dy, ph]) => {
    const a = 0.3 + 0.7 * Math.abs(Math.sin((t + ph) * Math.PI));
    c.globalAlpha = a; c.fillRect(x + dx * r - 1, y + dy * r - 1, 3, 3);
  });
  c.globalAlpha = 1;
}
function drawCloud(c, x, y, r, col = '#dfe6ee', shade = '#aab6c3') {
  const blob = (dx, dy, rr, fill) => { c.fillStyle = fill; c.beginPath(); c.arc(x + dx * r, y + dy * r, rr * r, 0, Math.PI * 2); c.fill(); };
  for (const fill of [shade, col]) {
    const o = fill === shade ? 0.06 : 0;
    blob(-0.45, 0.1 + o, 0.36, fill); blob(0.45, 0.1 + o, 0.36, fill); blob(-0.1, -0.2 + o, 0.46, fill); blob(0.28, -0.08 + o, 0.36, fill);
    c.fillStyle = fill; c.fillRect(x - 0.45 * r, y + o * r, 0.9 * r, 0.46 * r);
  }
}
function drawIcon(c, kind, x, y, r, t, night) {
  const drift = Math.sin(t * Math.PI * 2) * r * 0.06;
  if (kind === 'clear') return night ? drawMoon(c, x, y, r, t) : drawSun(c, x, y, r, t);
  if (kind === 'partly') {
    night ? drawMoon(c, x + r * 0.3, y - r * 0.3, r * 0.8, t) : drawSun(c, x + r * 0.3, y - r * 0.3, r * 0.8, t);
    return drawCloud(c, x - r * 0.1 + drift, y + r * 0.2, r * 0.85);
  }
  if (kind === 'cloud') { drawCloud(c, x + r * 0.25 - drift, y - r * 0.25, r * 0.6, '#9aa6b4', '#76828f'); return drawCloud(c, x - r * 0.1 + drift, y + r * 0.1, r * 0.85); }
  if (kind === 'fog') {
    drawCloud(c, x, y - r * 0.2, r * 0.8, '#b8c2cc', '#8e99a5');
    c.strokeStyle = '#cfd6dd'; c.lineWidth = r * 0.1; c.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const off = Math.sin((t + i * 0.3) * Math.PI * 2) * r * 0.15;
      c.beginPath(); c.moveTo(x - r * 0.8 + off, y + r * (0.35 + i * 0.22)); c.lineTo(x + r * 0.8 + off, y + r * (0.35 + i * 0.22)); c.stroke();
    }
    return;
  }
  const dark = kind === 'storm';
  drawCloud(c, x, y - r * 0.25, r * 0.85, dark ? '#7d8796' : '#c9d2dc', dark ? '#5a6370' : '#97a3b0');
  if (kind === 'snow') {
    c.fillStyle = '#fff';
    for (let i = 0; i < 6; i++) {
      const fx = x + (i % 3 - 1) * r * 0.45 + (i > 2 ? r * 0.2 : 0);
      const fy = y + r * 0.35 + ((t + i * 0.37) % 1) * r * 0.65;
      c.beginPath(); c.arc(fx + Math.sin((t + i) * 6) * 2, fy, r * 0.08, 0, Math.PI * 2); c.fill();
    }
    return;
  }
  const n = kind === 'drizzle' ? 4 : 6, len = kind === 'drizzle' ? 0.12 : 0.22;
  c.strokeStyle = '#5cb8ff'; c.lineWidth = r * (kind === 'drizzle' ? 0.07 : 0.09); c.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const dx = x + (i - (n - 1) / 2) * r * (1.4 / n) * 1.1;
    const dy = y + r * 0.35 + ((t + i * 0.41) % 1) * r * 0.6;
    c.beginPath(); c.moveTo(dx, dy); c.lineTo(dx - r * 0.06, dy + r * len); c.stroke();
  }
  if (kind === 'storm' && (t < 0.15 || (t > 0.3 && t < 0.4))) {
    c.fillStyle = '#ffe14d'; c.beginPath();
    c.moveTo(x + r * 0.05, y + r * 0.05); c.lineTo(x - r * 0.25, y + r * 0.55); c.lineTo(x, y + r * 0.5);
    c.lineTo(x - r * 0.15, y + r * 0.95); c.lineTo(x + r * 0.3, y + r * 0.35); c.lineTo(x + r * 0.05, y + r * 0.4); c.closePath(); c.fill();
  }
}

// ---------- screen layouts ----------
function wxBackground(c, kind, night) {
  const g = c.createLinearGradient(0, 0, 0, 128);
  const [top, bottom] = night ? ['#0b1530', '#03060f']
    : kind === 'clear' || kind === 'partly' ? ['#12467a', '#071a30']
    : kind === 'storm' ? ['#2a2f3a', '#0c0e13'] : ['#26384b', '#0a121b'];
  g.addColorStop(0, top); g.addColorStop(1, bottom);
  c.fillStyle = g; c.fillRect(0, 0, 128, 128);
}
function wxText(c, s, x, y, size, color, weight = '600', align = 'center') {
  c.font = `${weight} ${size}px system-ui, "Segoe UI", sans-serif`;
  c.fillStyle = color; c.textAlign = align; c.textBaseline = 'alphabetic';
  c.fillText(s, x, y, 124);
}
function drawNow(c, d, placeName, t) {
  const cur = d.current, [kind, label] = wxInfo(cur.weather_code), night = !cur.is_day;
  wxBackground(c, kind, night);
  wxText(c, placeName, 64, 14, 12, '#9fc3e6');
  drawIcon(c, kind, 64, 42, 22, t, night);
  wxText(c, Math.round(cur.temperature_2m) + '°', 66, 96, 32, '#fff', '700');
  wxText(c, label, 64, 110, 11, '#dfe8f1', '500');
  wxText(c, `Feels ${Math.round(cur.apparent_temperature)}° · ${compass(cur.wind_direction_10m)} ${Math.round(cur.wind_speed_10m)}`, 64, 123, 10, '#9fb0c0', '500');
}
function drawDay(c, d, i, t) {
  const day = d.daily, [kind] = wxInfo(day.weather_code[i]);
  wxBackground(c, kind, false);
  const date = new Date(day.time[i] + 'T12:00:00');
  const name = i === 0 ? 'TODAY' : date.toLocaleDateString('en-NZ', { weekday: 'short' }).toUpperCase();
  wxText(c, name, 64, 16, 14, '#ffb37a', '700');
  drawIcon(c, kind, 64, 46, 21, t, false);
  wxText(c, Math.round(day.temperature_2m_max[i]) + '°', 62, 97, 26, '#fff', '700', 'right');
  wxText(c, Math.round(day.temperature_2m_min[i]) + '°', 68, 97, 18, '#8fa3b8', '600', 'left');
  const rain = day.precipitation_probability_max[i];
  c.fillStyle = '#5cb8ff'; c.beginPath(); c.moveTo(48, 108); c.quadraticCurveTo(43, 116, 48, 119); c.quadraticCurveTo(53, 116, 48, 108); c.fill();
  wxText(c, (rain ?? 0) + '%', 56, 119, 13, '#bfe2ff', '600', 'left');
}
// frames[screen][frame] → 128x128 canvas
function renderWeather(d, placeName) {
  return [0, 1, 2, 3, 4].map(s => Array.from({ length: WX_FRAMES }, (_, f) => {
    const cv = makeCanvas(128, 128);
    const c = cv.getContext('2d'), t = f / WX_FRAMES;
    s === 0 ? drawNow(c, d, placeName, t) : drawDay(c, d, s - 1, t);
    return cv;
  }));
}

if (typeof module === 'object') module.exports = { WX_SPEED, weatherUrl, renderWeather, wxInfo, compass };
