// Draws the 3D printer screens from the server's view. Shared by the page (previews) and the server.
// Needs a global makeCanvas(w, h).
//   1: the state and a progress ring   2: time left and when it'll be done   3: the layer
//   4: nozzle, bed and chamber temperatures   5: the filament slots, the one in use marked

const PR_SPEED = 1000;
const PR = { bg: '#0f1214', text: '#f2f4f5', muted: '#8a949c', line: '#2a3036', hot: '#ff8a3d',
  printing: '#00ae42', preparing: '#3d9be9', paused: '#d99a00', finished: '#00ae42', failed: '#d23f3f', idle: '#6b7680', offline: '#d23f3f', setup: '#6b7680' };
const PR_WORD = { printing: 'PRINTING', preparing: 'STARTING', paused: 'PAUSED', finished: 'DONE', failed: 'FAILED', idle: 'IDLE', offline: 'OFFLINE', setup: 'NOT SET UP' };

function prFont(size, weight) { return `${weight} ${size}px system-ui, "Segoe UI", sans-serif`; }
function prText(c, s, x, y, size, color, weight = '600', align = 'center', maxW = 120) {
  c.font = prFont(size, weight); c.fillStyle = color; c.textAlign = align; c.textBaseline = 'alphabetic';
  c.fillText(String(s), x, y, maxW);
}
function prClip(c, s, size, maxW, weight = '600') {
  c.font = prFont(size, weight);
  s = String(s);
  if (c.measureText(s).width <= maxW) return s;
  while (s.length > 1 && c.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}
function prClock(ms) {
  const d = new Date(ms), h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}
function prLeft(min) { return min >= 60 ? `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}` : `${min}`; }
const prBusy = v => v.state === 'printing' || v.state === 'preparing' || v.state === 'paused';
function prBlank(c) { c.fillStyle = PR.bg; c.fillRect(0, 0, 128, 128); }
function prHead(c, label) { prText(c, label, 64, 15, 11, PR.muted, '700'); }

// Screen 1: the state and the progress ring.
function prStatus(c, v) {
  prBlank(c);
  const col = PR[v.state] || PR.idle;
  prText(c, PR_WORD[v.state] || v.state.toUpperCase(), 64, 15, 12, col, '800');
  if (v.state === 'offline' || v.state === 'setup') {
    prText(c, v.state === 'setup' ? 'Set up in the card' : 'No printer', 64, 62, 13, PR.text, '700');
    if (v.error) {
      const words = String(v.error).split(' '), lines = [''];
      c.font = prFont(10, '600');
      for (const w of words) { const t = (lines[lines.length - 1] + ' ' + w).trim(); if (c.measureText(t).width > 118 && lines[lines.length - 1]) lines.push(w); else lines[lines.length - 1] = t; }
      lines.slice(0, 3).forEach((l, i) => prText(c, l, 64, 84 + i * 12, 10, PR.muted, '600'));
    }
    return;
  }
  const pct = v.state === 'finished' ? 100 : v.percent ?? 0;
  c.lineWidth = 9; c.lineCap = 'round';
  c.strokeStyle = PR.line; c.beginPath(); c.arc(64, 62, 34, 0, Math.PI * 2); c.stroke();
  if (pct > 0 && v.state !== 'idle') {
    c.strokeStyle = col; c.beginPath(); c.arc(64, 62, 34, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(100, pct) / 100); c.stroke();
  }
  if (v.state === 'idle') prText(c, 'Ready', 64, 67, 15, PR.muted, '700');
  else if (v.state === 'failed') prText(c, '✕', 64, 72, 30, col, '800');
  else { prText(c, pct, 64, 70, pct === 100 ? 24 : 28, PR.text, '800'); prText(c, '%', 64, 83, 10, PR.muted, '700'); }
  if (v.job) prText(c, prClip(c, v.job, 11, 120), 64, 120, 11, PR.text, '600');
}

// Screen 2: time left, and when it'll be done.
function prTime(c, v) {
  prBlank(c);
  if (v.state === 'finished') {
    prHead(c, 'FINISHED');
    prText(c, v.finishedAt ? prClock(v.finishedAt) : 'Done', 64, 70, 24, PR.finished, '800');
    prText(c, 'take it off the plate', 64, 100, 10, PR.muted, '600');
    return;
  }
  if (!prBusy(v) || v.remainingMin == null) {
    prHead(c, 'TIME LEFT');
    prText(c, '–', 64, 72, 30, PR.muted, '800');
    return;
  }
  prHead(c, v.state === 'paused' ? 'PAUSED · LEFT' : 'TIME LEFT');
  prText(c, prLeft(v.remainingMin), 64, 68, v.remainingMin >= 600 ? 34 : 40, v.state === 'paused' ? PR.paused : PR.text, '800');
  prText(c, v.remainingMin >= 60 ? 'hours : min' : 'min', 64, 84, 10, PR.muted, '600');
  if (v.finishAt && v.state !== 'paused') {
    prText(c, 'done at', 64, 104, 10, PR.muted, '600');
    prText(c, prClock(v.finishAt), 64, 121, 15, PR.text, '700');
  }
}

// Screen 3: the layer, with a stack that fills up; or what it's doing while getting ready.
function prLayer(c, v) {
  prBlank(c);
  prHead(c, 'LAYER');
  if (v.state === 'preparing' || (prBusy(v) && v.stage && !v.layer)) {
    const words = (v.stage || 'Getting ready').split(' ');
    words.forEach((w, i) => prText(c, w, 64, 60 + i * 18 - (words.length - 1) * 9, 15, PR.preparing, '700'));
    return;
  }
  if (!v.layers) { prText(c, '–', 64, 72, 30, PR.muted, '800'); return; }
  const n = Math.min(v.layer || 0, v.layers), done = v.state === 'finished' ? 1 : n / v.layers;
  // the stack
  const bars = 14, h = 6;
  for (let i = 0; i < bars; i++) {
    c.fillStyle = (i + 0.5) / bars <= done ? PR[v.state] || PR.printing : PR.line;
    c.fillRect(8, 116 - i * (h + 1) - h, 22, h);
  }
  prText(c, v.state === 'finished' ? v.layers : n, 80, 66, n >= 1000 ? 26 : 32, PR.text, '800', 'center', 90);
  prText(c, `of ${v.layers}`, 80, 86, 13, PR.muted, '700', 'center', 90);
}

// Screen 4: temperatures.
function prTemps(c, v) {
  prBlank(c);
  prHead(c, 'TEMPERATURES');
  const rows = [['Nozzle', v.nozzle], ['Bed', v.bed]];
  if (v.chamber) rows.push(['Chamber', v.chamber]);
  // each row: the name (and the target below it) on the left, the temperature large on the right
  const gap = rows.length === 3 ? 33 : 42, top = rows.length === 3 ? 26 : 32;
  rows.forEach(([label, t], i) => {
    const y = top + i * gap;
    prText(c, label, 8, y + 14, 12, PR.text, '700', 'left', 60);
    if (!t) { prText(c, '–', 120, y + 20, 20, PR.muted, '800', 'right'); return; }
    const heating = t.target > 0;
    if (heating) prText(c, `→ ${Math.round(t.target)}°`, 8, y + 27, 10, PR.muted, '700', 'left', 60);
    prText(c, `${Math.round(t.cur)}°`, 122, y + 22, 24, heating ? PR.hot : PR.text, '800', 'right', 64);
  });
}

// Screen 5: the filament slots; the one in use is outlined.
function prFilament(c, v) {
  prBlank(c);
  prHead(c, 'FILAMENT');
  const t = (v.trays || []).slice(0, 8);
  if (!t.length) { prText(c, '–', 64, 72, 30, PR.muted, '800'); return; }
  const cols = t.length > 4 ? 4 : t.length, size = cols <= 2 ? 40 : 24, gap = cols <= 2 ? 14 : 6;
  const rows = Math.ceil(t.length / cols), w = cols * size + (cols - 1) * gap, x0 = (128 - w) / 2;
  const rowH = size + 18, y0 = rows === 1 ? 40 : 24;
  t.forEach((tr, i) => {
    const x = x0 + (i % cols) * (size + gap), y = y0 + Math.floor(i / cols) * rowH;
    c.fillStyle = tr.color || PR.line; c.fillRect(x, y, size, size);
    c.strokeStyle = PR.muted; c.lineWidth = 1; c.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);   // (so black filament shows)
    if (tr.active) { c.strokeStyle = '#ffffff'; c.lineWidth = 3; c.strokeRect(x - 2.5, y - 2.5, size + 5, size + 5); }
    prText(c, prClip(c, tr.type || tr.slot, 9, size + gap, '700'), x + size / 2, y + size + 11, 9, tr.active ? PR.text : PR.muted, '700', 'center', size + gap);
  });
  const a = t.find(x => x.active);
  if (a && rows === 1) prText(c, `in use: ${a.slot}`, 64, 120, 10, PR.text, '700');
}

// view → [{ key, jobs }] for the five screens
function prParts(v) {
  const one = draw => { const cv = makeCanvas(128, 128); draw(cv.getContext('2d')); return [cv]; };
  const k = (...a) => 'pr|' + JSON.stringify(a);
  const off = v.state === 'offline' || v.state === 'setup';
  const parts = [{ key: k('st', v.state, v.error, v.percent, v.job), jobs: [{ screen: 0, frames: one(c => prStatus(c, v)) }] }];
  if (off) {
    for (let i = 1; i < 5; i++) parts.push({ key: k('off', i), jobs: [{ screen: i, frames: one(prBlank) }] });
    return parts;
  }
  parts.push({ key: k('time', v.state, v.remainingMin, v.finishAt && prClock(v.finishAt), v.finishedAt), jobs: [{ screen: 1, frames: one(c => prTime(c, v)) }] });
  parts.push({ key: k('layer', v.state, v.stage, v.layer, v.layers), jobs: [{ screen: 2, frames: one(c => prLayer(c, v)) }] });
  const t = x => x && [Math.round(x.cur), Math.round(x.target || 0)];
  parts.push({ key: k('temp', t(v.nozzle), t(v.bed), t(v.chamber)), jobs: [{ screen: 3, frames: one(c => prTemps(c, v)) }] });
  parts.push({ key: k('fil', v.trays), jobs: [{ screen: 4, frames: one(c => prFilament(c, v)) }] });
  return parts;
}

if (typeof module === 'object') module.exports = { PR_SPEED, PR, prParts };
