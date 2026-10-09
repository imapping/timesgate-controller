// Draws the Servers screens from the server's view. Shared by the page (previews) and the server.
// Needs a global makeCanvas(w, h).
//   1: how many are up, and the ones with problems   2–5: a server each, the worst first
// Colours: green fine, amber a warning, red a problem or down; always with words or numbers too.

const SV_SPEED = 1000;
const SV = { bg: '#0f1214', text: '#f2f4f5', muted: '#8a949c', line: '#2a3036',
  ok: '#2e9c4a', warn: '#d99a00', crit: '#d23f3f', none: '#4a5560' };

function svFont(size, weight) { return `${weight} ${size}px system-ui, "Segoe UI", sans-serif`; }
function svText(c, s, x, y, size, color, weight = '600', align = 'left', maxW = 120) {
  c.font = svFont(size, weight); c.fillStyle = color; c.textAlign = align; c.textBaseline = 'alphabetic';
  c.fillText(String(s), x, y, maxW);
}
function svFit(c, s, maxW, max, min, weight = '700') {
  let size = max;
  for (; size > min; size--) { c.font = svFont(size, weight); if (c.measureText(String(s)).width <= maxW) break; }
  return size;
}
function svClip(c, s, size, maxW, weight = '600') {
  c.font = svFont(size, weight);
  s = String(s);
  if (c.measureText(s).width <= maxW) return s;
  while (s.length > 1 && c.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}
function svAgo(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${Math.max(1, m)} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
}
const svColour = level => SV[level] || SV.none;

// Screen 1: the summary.
function svSummary(c, v) {
  c.fillStyle = SV.bg; c.fillRect(0, 0, 128, 128);
  svText(c, 'SERVERS', 64, 15, 11, SV.muted, '700', 'center');
  const all = v.servers, up = all.filter(s => !s.down).length, bad = all.filter(s => s.level === 'crit' || s.level === 'warn');
  const worst = all.some(s => s.level === 'crit') ? 'crit' : bad.length ? 'warn' : 'ok';
  svText(c, `${up}/${all.length}`, 64, 58, 36, SV.text, '800', 'center');
  svText(c, 'up', 64, 72, 11, SV.muted, '600', 'center');
  const word = !bad.length ? 'ALL OK' : `${bad.length} ${bad.length === 1 ? 'PROBLEM' : 'PROBLEMS'}`;
  c.fillStyle = svColour(worst); c.fillRect(8, 80, 112, 18);
  svText(c, word, 64, 94, 13, '#ffffff', '800', 'center', 108);
  bad.slice(0, 2).forEach((s, i) => svText(c, svClip(c, s.name, 10, 120), 64, 111 + i * 12, 10, svColour(s.level), '700', 'center'));
}

// A thin meter: label, value, and a bar coloured by the limits.
function svMeter(c, y, label, pct, warnAt, critAt, sub) {
  svText(c, label, 6, y, 11, SV.muted, '700');
  if (pct == null) { svText(c, '–', 122, y, 11, SV.muted, '700', 'right'); return; }
  const col = pct >= critAt ? SV.crit : pct >= warnAt ? SV.warn : SV.ok;
  svText(c, `${pct}%` + (sub ? ` ${sub}` : ''), 122, y, 11, SV.text, '700', 'right', 84);
  c.fillStyle = SV.line; c.fillRect(6, y + 4, 116, 4);
  c.fillStyle = col; c.fillRect(6, y + 4, Math.max(3, Math.round(116 * Math.min(100, pct) / 100)), 4);
}

// Screens 2–5: one server.
function svServer(c, s, v) {
  c.fillStyle = SV.bg; c.fillRect(0, 0, 128, 128);
  if (!s) return;
  c.fillStyle = svColour(s.level); c.fillRect(0, 0, 128, 24);
  svText(c, s.name, 64, 17, svFit(c, s.name, 120, 14, 9), '#ffffff', '800', 'center', 120);
  if (s.down) {
    svText(c, 'DOWN', 64, 62, 28, SV.crit, '800', 'center');
    if (s.downSince) svText(c, 'for ' + svAgo(v.now - s.downSince), 64, 80, 12, SV.text, '600', 'center');
    svText(c, svClip(c, s.error, 10, 120), 64, 102, 10, SV.muted, '600', 'center', 120);
    return;
  }
  if (!s.level) { svText(c, 'Checking…', 64, 70, 12, SV.muted, '600', 'center'); return; }
  const L = v.limits;
  svMeter(c, 42, 'CPU', s.cpu, L.cpu, 101);
  svMeter(c, 64, 'MEM', s.memory, L.memory, 97);
  svMeter(c, 86, s.disk ? s.disk.name : 'DISK', s.disk ? s.disk.percent : null, L.disk, L.diskCritical);
  const p = s.problems.find(x => !/CPU|memory|full/.test(x.text));   // (the meters show those)
  const foot = p ? p.text : s.databases.length ? `DB ok · up ${svAgo((s.uptime || 0) * 1000)}` : s.uptime != null ? `up ${svAgo(s.uptime * 1000)}` : '';
  svText(c, svClip(c, foot, 10, 120), 64, 121, 10, p ? svColour(p.level) : SV.muted, '700', 'center', 120);
}

// view → [{ key, jobs }] for the five screens
function svParts(v) {
  const one = draw => { const cv = makeCanvas(128, 128); draw(cv.getContext('2d')); return [cv]; };
  const k = (...a) => 'sv|' + JSON.stringify(a);
  const brief = s => s && [s.name, s.level, s.down, s.cpu, s.memory, s.disk, s.problems, s.error, s.down && svAgo(v.now - s.downSince), s.uptime && svAgo(s.uptime * 1000)];
  const parts = [{ key: k('sum', v.servers.map(s => [s.name, s.level, s.down])), jobs: [{ screen: 0, frames: one(c => svSummary(c, v)) }] }];
  for (let i = 0; i < 4; i++) {
    const s = v.servers[i];
    parts.push({ key: k('sv', i, brief(s), v.limits), jobs: [{ screen: i + 1, frames: one(c => svServer(c, s, v)) }] });
  }
  return parts;
}

if (typeof module === 'object') module.exports = { SV_SPEED, SV, svParts };
