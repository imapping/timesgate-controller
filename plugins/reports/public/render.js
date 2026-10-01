// Draws the Listening reports screens from the server's summary. Shared by the page (previews) and
// the server. Needs a global makeCanvas(w, h).
//   1: plays and listening time for the period      2: top artists      3: top songs
//   4: plays over time (bars)                        5: the latest play

const RP_SPEED = 1000;
const RP = { bg: '#0f1115', text: '#f2f2f5', muted: '#8f949c', line: '#2a2e36', bar: '#ff7a45', barDim: '#7a3a22' };
const RP_RANGE = { '7d': '7 days', '30d': '30 days', '365d': '12 months', all: 'all time' };

function rpText(c, s, x, y, size, color, weight = '600', align = 'center', maxW = 122) {
  c.font = `${weight} ${size}px system-ui, "Segoe UI", sans-serif`;
  c.fillStyle = color; c.textAlign = align; c.textBaseline = 'alphabetic';
  c.fillText(String(s), x, y, maxW);
}
// The text cut to fit the width, with "…".
function rpClip(c, s, size, maxW, weight = '600') {
  c.font = `${weight} ${size}px system-ui, "Segoe UI", sans-serif`;
  s = String(s);
  if (c.measureText(s).width <= maxW) return s;
  while (s.length > 1 && c.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}
function rpWrap(c, s, size, maxW, maxLines, weight = '600') {
  c.font = `${weight} ${size}px system-ui, "Segoe UI", sans-serif`;
  const lines = [];
  let line = '';
  for (const w of String(s).split(/\s+/).filter(Boolean)) {
    const t = line ? line + ' ' + w : w;
    if (c.measureText(t).width <= maxW || !line) line = t; else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = rpClip(c, lines[maxLines - 1] + ' …', size, maxW, weight); }
  return lines.map(l => rpClip(c, l, size, maxW, weight));
}
function rpNum(n) { return n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n); }
function rpTime(ms) {
  if (ms == null) return '';
  const h = ms / 3600000;
  return h >= 10 ? Math.round(h) + ' h' : h >= 1 ? h.toFixed(1).replace(/\.0$/, '') + ' h' : Math.max(1, Math.round(ms / 60000)) + ' min';
}
function rpAgo(at, now) {
  const m = Math.max(0, Math.round((now - at) / 60000));
  return m < 2 ? 'just now' : m < 60 ? m + ' min ago' : m < 48 * 60 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago';
}
function rpBack(c, title) {
  c.fillStyle = RP.bg; c.fillRect(0, 0, 128, 128);
  if (title) rpText(c, title, 64, 15, 11, RP.muted, '700');
}

function rpDrawTotals(c, d) {
  rpBack(c, 'LISTENING');
  const n = rpNum(d.totals.plays);
  rpText(c, n, 64, 70, n.length > 4 ? 34 : 44, RP.text, '700');
  rpText(c, d.totals.plays === 1 ? 'play' : 'plays', 64, 88, 13, RP.muted, '600');
  rpText(c, [RP_RANGE[d.range], rpTime(d.totals.ms)].filter(Boolean).join(' · '), 64, 116, 12, RP.bar, '600');
}
// A ranked list: name, count, and a thin bar for the share of the top entry.
function rpDrawList(c, title, rows, two) {
  rpBack(c, title);
  if (!rows.length) { rpText(c, 'Nothing yet', 64, 70, 12, RP.muted); return; }
  const n = two ? 3 : 4, step = two ? 35 : 26, top = rows[0].n;
  rows.slice(0, n).forEach((r, i) => {
    const y = 34 + i * step;
    rpText(c, rpNum(r.n), 122, y, 12, RP.text, '700', 'right');
    rpText(c, rpClip(c, r.name, 12, 94, '600'), 6, y, 12, RP.text, '600', 'left', 94);
    if (two) rpText(c, rpClip(c, r.sub, 10, 116, '500'), 6, y + 12, 10, RP.muted, '500', 'left', 116);
    const by = y + (two ? 17 : 5);
    c.fillStyle = RP.line; c.fillRect(6, by, 116, 3);
    c.fillStyle = RP.bar; c.fillRect(6, by, Math.max(3, Math.round(116 * r.n / top)), 3);
  });
}
function rpDrawChart(c, d) {
  const pts = d.series.points.slice(-14);
  rpBack(c, d.series.unit === 'month' ? 'PLAYS BY MONTH' : 'PLAYS BY DAY');
  if (!pts.length || !pts.some(p => p.n)) { rpText(c, 'Nothing yet', 64, 70, 12, RP.muted); return; }
  const max = Math.max(...pts.map(p => p.n)), gap = 2, w = Math.max(3, Math.floor((116 - gap * (pts.length - 1)) / pts.length));
  const x0 = Math.round((128 - (pts.length * (w + gap) - gap)) / 2), base = 104, H = 70;
  pts.forEach((p, i) => {
    const h = p.n ? Math.max(3, Math.round(p.n / max * H)) : 0, x = x0 + i * (w + gap);
    c.fillStyle = RP.line; c.fillRect(x, base, w, 1);
    c.fillStyle = i === pts.length - 1 ? RP.bar : RP.barDim;
    if (h) c.fillRect(x, base - h, w, h);
  });
  rpText(c, 'most: ' + max, 6, 28, 10, RP.muted, '600', 'left');
  rpText(c, pts[0].label.replace(/^\w+, /, ''), 6, 120, 10, RP.muted, '600', 'left');   // "Sat, 19 Sept" → "19 Sept"
  rpText(c, d.series.unit === 'month' ? pts[pts.length - 1].label : 'today', 122, 120, 10, RP.bar, '600', 'right');
}
function rpDrawLatest(c, d) {
  rpBack(c, 'LAST PLAYED');
  const r = d.recent[0];
  if (!r) { rpText(c, 'Nothing yet', 64, 70, 12, RP.muted); return; }
  const lines = rpWrap(c, r.title, 14, 118, 3, '700');
  lines.forEach((l, i) => rpText(c, l, 64, 40 + i * 17, 14, RP.text, '700'));
  rpText(c, rpClip(c, r.artist, 12, 118, '600'), 64, 46 + lines.length * 17, 12, RP.muted, '600');
  rpText(c, rpAgo(r.at, d.generatedAt), 64, 106, 12, RP.bar, '600');
  rpText(c, r.source === 'vinyl' ? 'on the turntable' : 'on ' + r.source[0].toUpperCase() + r.source.slice(1), 64, 121, 10, RP.muted, '600');
}

// summary → [{ key, frames }] for the five screens
function rpRender(d) {
  const one = draw => { const cv = makeCanvas(128, 128); draw(cv.getContext('2d')); return [cv]; };
  const k = (...a) => 'rp|' + d.range + '|' + d.source + '|' + JSON.stringify(a);
  return [
    { key: k('totals', d.totals.plays, rpTime(d.totals.ms)), frames: one(c => rpDrawTotals(c, d)) },
    { key: k('artists', d.topArtists.slice(0, 4)), frames: one(c => rpDrawList(c, 'TOP ARTISTS', d.topArtists.map(r => ({ name: r.artist, n: r.n })), false)) },
    { key: k('songs', d.topSongs.slice(0, 3)), frames: one(c => rpDrawList(c, 'TOP SONGS', d.topSongs.map(r => ({ name: r.title, sub: r.artist, n: r.n })), true)) },
    { key: k('chart', d.series.unit, d.series.points.slice(-14)), frames: one(c => rpDrawChart(c, d)) },
    { key: k('latest', d.recent[0] && [d.recent[0].title, d.recent[0].artist, rpAgo(d.recent[0].at, d.generatedAt)]), frames: one(c => rpDrawLatest(c, d)) },
  ];
}

if (typeof module === 'object') module.exports = { RP_SPEED, rpRender, rpNum, rpTime, rpAgo };
