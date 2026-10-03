// Draws the Baseball (MLB) screens from the server's view. Shared by the page (previews) and the server.
// Needs a global makeCanvas(w, h).
//   During a game:   1: away team and runs   2: home team and runs   3: inning, bases, outs and count
//                    4: batter and pitcher   5: runs, hits and errors, and the series
//   Before:          1–2: the teams and their records   3: when it starts (local time)   4–5: the series, and the venue
//   After:           1–2: the final score   3: FINAL   4: runs, hits, errors   5: the series and the next game

const MB_SPEED = 1000;
const MB = { bg: '#0e1116', text: '#f3f5f8', muted: '#8d96a3', line: '#2b313b', base: '#f5c542', out: '#e04848' };
// Each team's main colour, by MLB team id (for its band; the abbreviation is always written on it).
const MB_COLOURS = {
  108: '#ba0021', 109: '#a71930', 110: '#df4601', 111: '#bd3039', 112: '#0e3386', 113: '#c6011f', 114: '#00385d', 115: '#33006f',
  116: '#0c2340', 117: '#eb6e1f', 118: '#004687', 119: '#005a9c', 120: '#ab0003', 121: '#002d72', 133: '#003831', 134: '#27251f',
  135: '#2f241d', 136: '#005c5c', 137: '#fd5a1e', 138: '#c41e3a', 139: '#092c5c', 140: '#003278', 141: '#134a8e', 142: '#002b5c',
  143: '#e81828', 144: '#ce1141', 145: '#27251f', 146: '#00a3e0', 147: '#0c2340', 158: '#12284b',
};
const mbColour = id => MB_COLOURS[id] || '#3a4250';

function mbFont(size, weight) { return `${weight} ${size}px system-ui, "Segoe UI", sans-serif`; }
function mbText(c, s, x, y, size, color, weight = '600', align = 'center', maxW = 120) {
  c.font = mbFont(size, weight); c.fillStyle = color; c.textAlign = align; c.textBaseline = 'alphabetic';
  c.fillText(String(s), x, y, maxW);
}
// The largest size (max down to min) at which one line of text fits the width.
function mbFit(c, s, maxW, max, min, weight = '700') {
  let size = max;
  for (; size > min; size--) { c.font = mbFont(size, weight); if (c.measureText(String(s)).width <= maxW) break; }
  return size;
}
function mbWrap(c, s, size, maxW, maxLines, weight = '600') {
  c.font = mbFont(size, weight);
  const lines = [];
  let line = '';
  for (const w of String(s).split(/\s+/).filter(Boolean)) {
    const t = line ? line + ' ' + w : w;
    if (c.measureText(t).width <= maxW || !line) line = t; else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}
const mbLast = name => String(name || '').split(' ').slice(1).join(' ') || String(name || '');
function mbWhen(iso, now) {
  const d = new Date(iso), today = new Date(now);
  const day = d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === new Date(now + 864e5).toDateString() ? 'Tomorrow'
    : d.toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });
  return { day, time: d.toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' }) };
}
const mbSeries = v => [v.series.desc, v.series.game && v.series.type !== 'R' ? 'Game ' + v.series.game : ''].filter(Boolean).join(' · ');

// Screens 1 and 2: a team. Its colour band with the abbreviation, then the runs (or its record before the game).
function mbTeam(c, v, t, where) {
  c.fillStyle = MB.bg; c.fillRect(0, 0, 128, 128);
  c.fillStyle = mbColour(t.id); c.fillRect(0, 0, 128, 40);
  mbText(c, t.abbr, 64, 31, 26, '#ffffff', '800');
  const ours = t.id === v.team;
  if (v.phase === 'pre') {
    mbText(c, t.name, 64, 70, mbFit(c, t.name, 118, 18, 10), MB.text, '700', 'center', 118);
    if (t.record) mbText(c, t.record, 64, 96, 16, MB.muted, '600');
  } else {
    const other = t === v.home ? v.away : v.home, ahead = (t.score ?? 0) > (other.score ?? 0);
    mbText(c, String(t.score ?? 0), 64, 104, 60, ahead || v.phase === 'live' ? MB.text : MB.muted, '800');
  }
  mbText(c, (where + (ours ? ' · YOURS' : '')).toUpperCase(), 64, 122, 10, ours ? MB.base : MB.muted, '700');
}
// The diamond: second at the top, first on the right, third on the left. Filled = a runner.
function mbDiamond(c, cx, cy, bases) {
  const pos = [[cx + 22, cy], [cx, cy - 22], [cx - 22, cy]];
  pos.forEach(([x, y], i) => {
    c.save(); c.translate(x, y); c.rotate(Math.PI / 4);
    c.fillStyle = bases[i] ? MB.base : MB.bg; c.fillRect(-9, -9, 18, 18);
    c.strokeStyle = bases[i] ? MB.base : MB.muted; c.lineWidth = 2; c.strokeRect(-9, -9, 18, 18);
    c.restore();
  });
}
// Screen 3: the inning, bases, outs and count (live); when it starts (before); FINAL (after).
function mbState(c, v, now) {
  c.fillStyle = MB.bg; c.fillRect(0, 0, 128, 128);
  if (v.phase === 'pre') {
    const w = mbWhen(v.start, now);
    mbText(c, 'FIRST PITCH', 64, 22, 11, MB.muted, '700');
    mbText(c, w.day, 64, 58, mbFit(c, w.day, 120, 22, 12), MB.text, '700');
    mbText(c, w.time, 64, 92, 26, MB.base, '800');
    if (/Delay|Postpon/.test(v.status)) mbText(c, v.status, 64, 118, 11, MB.out, '700');
    return;
  }
  if (v.phase === 'final') {
    mbText(c, 'FINAL', 64, 62, 30, MB.text, '800');
    const n = v.inning?.n;
    if (n && n !== v.scheduled) mbText(c, `${n} innings`, 64, 88, 13, MB.muted, '600');
    return;
  }
  const i = v.inning || {}, mid = /Middle|End/.test(i.state);
  mbText(c, (mid ? (i.state === 'Middle' ? 'MID ' : 'END ') : i.half === 'Top' ? '▲ ' : '▼ ') + String(i.ordinal || '').toUpperCase(), 64, 22, 18, MB.text, '800');
  mbDiamond(c, 64, 66, mid ? [false, false, false] : v.bases);
  for (let k = 0; k < 3; k++) {   // outs
    c.beginPath(); c.arc(46 + k * 18, 104, 6, 0, Math.PI * 2);
    c.fillStyle = k < v.count.o && !mid ? MB.out : MB.line; c.fill();
  }
  mbText(c, mid ? '' : `${v.count.b}-${v.count.s}`, 64, 125, 12, MB.muted, '700');
}
// Screen 4: who's batting and pitching (live); runs, hits and errors (after); the series (before).
function mbPeople(c, v) {
  c.fillStyle = MB.bg; c.fillRect(0, 0, 128, 128);
  if (v.phase === 'live' && (v.batter || v.pitcher)) {
    mbText(c, 'AT BAT', 64, 18, 10, MB.muted, '700');
    const b = mbLast(v.batter) || '–', p = mbLast(v.pitcher) || '–';
    mbText(c, b, 64, 46, mbFit(c, b, 120, 20, 10), MB.text, '700');
    mbText(c, 'PITCHING', 64, 76, 10, MB.muted, '700');
    mbText(c, p, 64, 104, mbFit(c, p, 120, 20, 10), MB.text, '700');
    return;
  }
  if (v.phase === 'final' || v.phase === 'live') { mbLine(c, v); return; }
  const lines = mbWrap(c, mbSeries(v) || 'Regular season', 15, 118, 3, '700');
  lines.forEach((l, k) => mbText(c, l, 64, 40 + k * 20, 15, MB.text, '700'));
  if (v.venue) mbWrap(c, v.venue, 11, 118, 2).forEach((l, k) => mbText(c, l, 64, 104 + k * 14, 11, MB.muted, '600'));
}
// Runs, hits and errors for both teams.
function mbLine(c, v) {
  mbText(c, 'R', 70, 30, 12, MB.muted, '700'); mbText(c, 'H', 94, 30, 12, MB.muted, '700'); mbText(c, 'E', 116, 30, 12, MB.muted, '700');
  [v.away, v.home].forEach((t, k) => {
    const y = 64 + k * 34;
    c.fillStyle = mbColour(t.id); c.fillRect(4, y - 20, 46, 26);
    mbText(c, t.abbr, 27, y, 15, '#ffffff', '800', 'center', 44);
    mbText(c, t.score ?? 0, 70, y, 18, MB.text, '800'); mbText(c, t.hits ?? 0, 94, y, 15, MB.text, '600'); mbText(c, t.errors ?? 0, 116, y, 15, MB.text, '600');
  });
}
// Screen 5: the series (and, after a game, the next one).
function mbMore(c, v, now) {
  c.fillStyle = MB.bg; c.fillRect(0, 0, 128, 128);
  if (v.phase === 'live') { mbLine(c, v); return; }
  let y = 24;
  const series = mbSeries(v);
  if (series) { mbWrap(c, series, 11, 120, 2, '700').forEach(l => { mbText(c, l, 64, y, 11, MB.muted, '700'); y += 14; }); }
  if (v.series.status) { mbWrap(c, v.series.status, 14, 120, 2, '700').forEach(l => { mbText(c, l, 64, y + 8, 14, MB.base, '700'); y += 18; }); y += 8; }
  if (v.next) {
    const w = mbWhen(v.next.start, now);
    mbText(c, 'NEXT', 64, Math.max(y + 18, 76), 10, MB.muted, '700');
    mbText(c, (v.next.home ? 'v ' : '@ ') + v.next.opp.abbr, 64, Math.max(y + 38, 96), 16, MB.text, '800');
    mbText(c, `${w.day} ${w.time}`, 64, Math.max(y + 56, 116), 11, MB.muted, '600', 'center', 124);
  }
}

// view, now → [{ key, jobs }] for the five screens
function mbParts(v, now) {
  const one = draw => { const cv = makeCanvas(128, 128); draw(cv.getContext('2d')); return [cv]; };
  if (!v || v.phase === 'none' || !v.home) {
    return [{ key: 'mb|none', jobs: [0, 1, 2, 3, 4].map(i => ({ screen: i, frames: one(c => { c.fillStyle = MB.bg; c.fillRect(0, 0, 128, 128); if (i === 2) mbText(c, 'No games soon', 64, 68, 12, MB.muted); }) })) }];
  }
  const w = v.phase === 'pre' ? mbWhen(v.start, now) : null;
  const k = (...a) => 'mb|' + JSON.stringify(a);
  return [
    { key: k('away', v.phase, v.away), jobs: [{ screen: 0, frames: one(c => mbTeam(c, v, v.away, 'Away')) }] },
    { key: k('home', v.phase, v.home), jobs: [{ screen: 1, frames: one(c => mbTeam(c, v, v.home, 'Home')) }] },
    { key: k('state', v.phase, v.inning, v.count, v.bases, w, v.status), jobs: [{ screen: 2, frames: one(c => mbState(c, v, now)) }] },
    { key: k('people', v.phase, v.batter, v.pitcher, v.away.score, v.home.score, v.away.hits, v.home.hits, v.away.errors, v.home.errors, v.series, v.venue), jobs: [{ screen: 3, frames: one(c => mbPeople(c, v)) }] },
    { key: k('more', v.phase, v.series, v.next, v.away.score, v.home.score, v.away.hits, v.home.hits, v.next && mbWhen(v.next.start, now)), jobs: [{ screen: 4, frames: one(c => mbMore(c, v, now)) }] },
  ];
}

if (typeof module === 'object') module.exports = { MB_SPEED, MB, mbParts, mbColour };
