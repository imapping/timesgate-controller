// Draws the Mowing screens from Mowing Tracker's status. Shared by the page (previews) and the server.
// Needs a global makeCanvas(w, h).
//   1: a map of the property, each area coloured by its status   2–3: the most urgent area
//   4: how many areas are overdue, due soon and up to date        5: the next few areas, and when it was last mowed
// Status colours are Mowing Tracker's own; each also comes with words, never colour alone.

const MW_SPEED = 1000;
const MW = { bg: '#0f1310', text: '#f1f4ef', muted: '#93a092', line: '#2a312a',
  status: { ok: '#2e9c4a', soon: '#d99a00', overdue: '#d23f3f', never: '#6b7a90' } };
const MW_LABEL = { overdue: 'OVERDUE', soon: 'DUE SOON', ok: 'UP TO DATE', never: 'NEVER MOWED' };

function mwFont(size, weight) { return `${weight} ${size}px system-ui, "Segoe UI", sans-serif`; }
function mwText(c, s, x, y, size, color, weight = '600', align = 'left', maxW = 120) {
  c.font = mwFont(size, weight); c.fillStyle = color; c.textAlign = align; c.textBaseline = 'alphabetic';
  c.fillText(String(s), x, y, maxW);
}
function mwClip(c, s, size, maxW, weight = '600') {
  c.font = mwFont(size, weight);
  s = String(s);
  if (c.measureText(s).width <= maxW) return s;
  while (s.length > 1 && c.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}
// The largest size (from max down to min) at which the text fits in maxLines lines; returns { size, lines }.
function mwFit(c, s, maxW, maxLines, max, min, weight = '700') {
  for (let size = max; ; size--) {
    c.font = mwFont(size, weight);
    const lines = [];
    let line = '';
    for (const w of String(s).split(/\s+/).filter(Boolean)) {
      const t = line ? line + ' ' + w : w;
      if (c.measureText(t).width <= maxW || !line) line = t; else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    const fits = lines.length <= maxLines && lines.every(l => c.measureText(l).width <= maxW);
    if (fits || size <= min) {
      if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = mwClip(c, lines[maxLines - 1] + '…', size, maxW, weight); }
      return { size, lines: lines.map(l => mwClip(c, l, size, maxW, weight)) };
    }
  }
}
// "17 d over", "today", "tomorrow", "in 3 d", "never"
function mwShort(a) {
  if (a.status === 'never' || a.daysUntilDue == null) return 'never';
  const n = a.daysUntilDue;
  return n < 0 ? `${-n} d over` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} d`;
}
function mwDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
}

// Screen 1: the photo (fitted, darkened) with each area's outline filled in its status colour.
// Without the photo, the outlines on their own. The most urgent area is drawn last, on top.
function mwDrawMap(c, d, photo) {
  c.fillStyle = MW.bg; c.fillRect(0, 0, 128, 128);
  const iw = photo ? photo.width : d.image?.width || 4, ih = photo ? photo.height : d.image?.height || 3;
  const k = Math.min(128 / iw, 128 / ih), w = iw * k, h = ih * k, x0 = (128 - w) / 2, y0 = (128 - h) / 2;
  if (photo) {
    c.drawImage(photo, x0, y0, w, h);
    c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(x0, y0, w, h);
  } else { c.strokeStyle = MW.line; c.lineWidth = 1; c.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1); }
  for (const a of [...d.areas].reverse()) {
    const pts = (a.outline || []).filter(p => Array.isArray(p) && p.length === 2);
    if (pts.length < 3) continue;
    c.beginPath();
    pts.forEach(([x, y], i) => (i ? c.lineTo(x0 + x * w, y0 + y * h) : c.moveTo(x0 + x * w, y0 + y * h)));
    c.closePath();
    const col = MW.status[a.status] || MW.status.never;
    c.globalAlpha = 0.55; c.fillStyle = col; c.fill(); c.globalAlpha = 1;
    c.strokeStyle = col; c.lineWidth = 1.5; c.lineJoin = 'round'; c.stroke();
  }
  if (!photo && !d.areas.some(a => (a.outline || []).length >= 3)) mwText(c, d.propertyName || 'Mowing', 64, 68, 12, MW.muted, '600', 'center');
}
// Screens 2–3 (256 wide): the most urgent area, or all clear.
function mwDrawNext(c, d) {
  c.fillStyle = MW.bg; c.fillRect(0, 0, 256, 128);
  const a = d.next;
  if (!a) { mwText(c, 'No areas yet', 128, 70, 18, MW.muted, '600', 'center', 240); return; }
  const col = MW.status[a.status] || MW.status.never;
  mwText(c, a.status === 'ok' ? 'NEXT TO MOW' : 'MOW NEXT', 10, 18, 11, col, '700');
  const f = mwFit(c, a.name, 236, 2, 34, 14);
  const lh = Math.round(f.size * 1.1), top = 30 + (2 - f.lines.length) * lh / 2 + f.size * 0.85;
  f.lines.forEach((l, i) => mwText(c, l, 10, top + i * lh, f.size, MW.text, '700', 'left', 236));
  c.fillStyle = col; c.fillRect(10, 100, 4, 18);
  mwText(c, mwClip(c, a.statusText, 15, 220, '700'), 20, 115, 15, col, '700', 'left', 226);
}
// Screen 4: the counts, as numbers with words.
function mwDrawCounts(c, d) {
  c.fillStyle = MW.bg; c.fillRect(0, 0, 128, 128);
  mwText(c, 'AREAS', 64, 15, 11, MW.muted, '700', 'center');
  const s = d.summary || {};
  const rows = [['overdue', s.overdue, 'overdue'], ['soon', s.dueSoon, 'due soon'], ['ok', s.ok, 'up to date']];
  if (s.neverMowed) rows.push(['never', s.neverMowed, 'never mowed']);
  const step = rows.length > 3 ? 25 : 31, y0 = rows.length > 3 ? 40 : 45;
  rows.forEach(([k, n, label], i) => {
    const y = y0 + i * step, col = MW.status[k];
    mwText(c, String(n ?? 0), 44, y, 24, n ? col : MW.muted, '700', 'right', 40);
    mwText(c, label, 50, y - 2, 12, n ? MW.text : MW.muted, '600', 'left', 76);
  });
}
// Screen 5: the next few areas after the most urgent, and when anything was last mowed.
function mwDrawList(c, d) {
  c.fillStyle = MW.bg; c.fillRect(0, 0, 128, 128);
  mwText(c, 'THEN', 64, 15, 11, MW.muted, '700', 'center');
  const rest = d.areas.slice(1, 5);
  if (!rest.length) mwText(c, 'Nothing else', 64, 62, 12, MW.muted, '600', 'center');
  rest.forEach((a, i) => {
    const y = 34 + i * 20, col = MW.status[a.status] || MW.status.never;
    c.fillStyle = col; c.beginPath(); c.arc(9, y - 4, 3.5, 0, Math.PI * 2); c.fill();
    const when = mwShort(a);
    c.font = mwFont(10, '600');
    const ww = c.measureText(when).width;
    mwText(c, mwClip(c, a.name, 11, 112 - 18 - ww, '600'), 17, y, 11, MW.text, '600', 'left', 112 - 18 - ww);
    mwText(c, when, 123, y, 10, col, '600', 'right', 60);
  });
  const last = d.summary?.lastMowed;
  mwText(c, last ? 'Last mowed ' + mwDate(last) : 'Not mowed yet', 64, 121, 10, MW.muted, '600', 'center', 120);
}

// status (the API's JSON), photo (an image, or null) → [{ key, frames }] for the five screens
function mwRender(d, photo) {
  const one = (w, draw) => { const cv = makeCanvas(w, 128); draw(cv.getContext('2d')); return [cv]; };
  const k = (...a) => 'mw|' + JSON.stringify(a);
  const areas = d.areas.map(a => [a.name, a.status, a.statusText, mwShort(a)]);
  return [
    { key: k('map', !!photo, d.image?.url, d.areas.map(a => [a.status, a.outline])), frames: one(128, c => mwDrawMap(c, d, photo)) },
    { key: k('next', d.next && [d.next.name, d.next.status, d.next.statusText]), frames: one(256, c => mwDrawNext(c, d)) },
    { key: k('counts', d.summary), frames: one(128, c => mwDrawCounts(c, d)) },
    { key: k('list', areas.slice(1, 5), d.summary?.lastMowed), frames: one(128, c => mwDrawList(c, d)) },
  ];
}

// The same, as { key, jobs } for the five screens (the wide one spans screens 2 and 3).
function mwParts(d, photo) {
  const [map, next, counts, list] = mwRender(d, photo);
  return [
    { key: map.key, jobs: [{ screen: 0, frames: map.frames }] },
    { key: next.key, jobs: [{ screen: 1, frames: next.frames, x: 0 }, { screen: 2, frames: next.frames, x: 128 }] },
    { key: counts.key, jobs: [{ screen: 3, frames: counts.frames }] },
    { key: list.key, jobs: [{ screen: 4, frames: list.frames }] },
  ];
}

if (typeof module === 'object') module.exports = { MW_SPEED, MW, mwRender, mwParts, mwShort };
