// Draws the Claude Code status screens. Shared by the page (previews) and the server (engine.js).
//  Screen 1: overall state (the most urgent across sessions) with an animated Claude spark
//  Screen 2: session (5-hour) usage      Screen 3: weekly (7-day) usage
//  Screens 4-5: your sessions and what each is doing
// Needs a global makeCanvas(w, h).

// `flash` marks states where Claude is waiting on an answer from you; only those pulse.
const CL_STATES = {
  permission: { label: 'APPROVE?', short: 'Needs OK', color: '#ffb020', rank: 5, flash: true },
  question:   { label: 'QUESTION', short: 'Asked you', color: '#5cb8ff', rank: 4, flash: true },
  error:      { label: 'ERROR',    short: 'Error',    color: '#ff453a', rank: 3 },
  done:       { label: 'YOUR TURN', short: 'Your turn', color: '#30d158', rank: 2 },
  working:    { label: 'WORKING',  short: 'Working',  color: '#d97757', rank: 1 },
  idle:       { label: 'IDLE',     short: 'Idle',     color: '#8e8e93', rank: 0 },
};
const CL_FRAMES = 8, CL_SPEED = 120;

// ---------- drawing helpers ----------
function clText(c, s, x, y, size, color, weight = 700, align = 'center', maxW = 120) {
  c.font = `${weight} ${size}px system-ui, "Segoe UI", sans-serif`;
  while (size > 8 && c.measureText(s).width > maxW) { size--; c.font = `${weight} ${size}px system-ui, "Segoe UI", sans-serif`; }
  c.fillStyle = color; c.textAlign = align; c.textBaseline = 'alphabetic';
  c.fillText(s, x, y);
}
function clSpark(c, x, y, r, color, rot = 0) {
  // Claude's starburst: rounded rays around a centre.
  c.save(); c.translate(x, y); c.rotate(rot);
  c.strokeStyle = color; c.lineCap = 'round';
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6, len = i % 2 ? r * 0.72 : r;
    c.lineWidth = r * (i % 2 ? 0.16 : 0.2);
    c.beginPath(); c.moveTo(Math.cos(a) * r * 0.18, Math.sin(a) * r * 0.18); c.lineTo(Math.cos(a) * len, Math.sin(a) * len); c.stroke();
  }
  c.restore();
}
function clBg(c, color = '#0d0d0f') { c.fillStyle = color; c.fillRect(0, 0, 128, 128); }
const clCanvas = draw => { const cv = makeCanvas(128, 128); draw(cv.getContext('2d')); return cv; };

function resetText(epoch) {
  if (!epoch) return '';
  const mins = Math.max(0, Math.round((epoch * 1000 - Date.now()) / 60000));
  if (mins < 60) return `resets in ${mins}m`;
  if (mins < 24 * 60) { const h = Math.floor(mins / 60), m = Math.floor((mins % 60) / 10) * 10; return `resets in ${h}h${m ? ' ' + m + 'm' : ''}`; }
  const d = new Date(epoch * 1000);
  return 'resets ' + d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric' }).replace(' ', '').toLowerCase();
}

// ---------- screens ----------
function overall(sessions) {
  return sessions.reduce((best, s) => (CL_STATES[s.state]?.rank ?? 0) > (CL_STATES[best?.state]?.rank ?? -1) ? s : best, null);
}
function screenState(d) {
  const top = overall(d.sessions), st = CL_STATES[top?.state || 'idle'];
  const count = d.sessions.filter(s => s.state === top?.state).length;
  const sub = !top ? 'no sessions' : count > 1 ? `${count} sessions` : top.name;
  const key = `state|${top?.state}|${sub}`;
  const animated = st.flash || top?.state === 'working';
  const frames = Array.from({ length: animated ? CL_FRAMES : 1 }, (_, f) => clCanvas(c => {
    const t = f / CL_FRAMES;
    clBg(c);
    if (st.flash) {  // pulsing ring: Claude is waiting on an answer from you
      c.strokeStyle = st.color; c.globalAlpha = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2));
      c.lineWidth = 6; c.strokeRect(3, 3, 122, 122); c.globalAlpha = 1;
    }
    const rot = top?.state === 'working' ? t * Math.PI / 3 : 0;
    const r = st.flash ? 26 * (0.92 + 0.08 * Math.sin(t * Math.PI * 2)) : 26;
    clSpark(c, 64, 48, r, top?.state === 'idle' || !top ? '#6e6e73' : '#d97757', rot);
    clText(c, st.label, 64, 98, 22, st.color, 800);
    clText(c, sub, 64, 117, 12, '#b8b8bd', 500);
  }));
  return { key, frames };
}
function screenUsage(win, title) {
  const used = win ? Math.round(win.used) : null;
  const reset = win ? resetText(win.resets_at) : 'no data yet';
  const key = `usage|${title}|${used}|${reset}`;
  const color = used == null ? '#6e6e73' : used >= 80 ? '#ff453a' : used >= 50 ? '#ffb020' : '#30d158';
  const frame = clCanvas(c => {
    clBg(c);
    clText(c, title, 64, 16, 12, '#b8b8bd', 700);
    const cx = 64, cy = 64, rr = 36, a0 = Math.PI * 0.75, sweep = Math.PI * 1.5;
    c.lineCap = 'round'; c.lineWidth = 10;
    c.strokeStyle = '#2a2a2e'; c.beginPath(); c.arc(cx, cy, rr, a0, a0 + sweep); c.stroke();
    if (used != null) { c.strokeStyle = color; c.beginPath(); c.arc(cx, cy, rr, a0, a0 + sweep * Math.min(1, used / 100)); c.stroke(); }
    clText(c, used == null ? '—' : used + '%', 64, 74, 26, '#fff', 800, 'center', 60);
    clText(c, reset, 64, 120, 11, '#9a9aa0', 500);
  });
  return { key, frames: [frame] };
}
// Session list layout: each entry is a coloured dot, the name word-wrapped (up to 2 lines) and its state.
const SL = { nameFont: '700 11px system-ui, "Segoe UI", sans-serif', nameLine: 12, stateH: 11, gap: 4,
             left: 16, width: 110, maxLines: 2, top: 24 };
const slCtx = makeCanvas(1, 1).getContext('2d');

// Break text into lines that fit maxW, splitting over-long words mid-word; ellipsis on the last line.
function wrapLines(text, maxW, maxLines) {
  slCtx.font = SL.nameFont;
  const fits = s => slCtx.measureText(s).width <= maxW;
  const words = text.split(/(?<=[\s\-_/])/).map(w => w.replace(/\s+$/, ' '));
  const lines = [];
  let cur = '';
  for (let w of words) {
    if (fits(cur + w)) { cur += w; continue; }
    if (cur.trim()) { lines.push(cur.trim()); cur = ''; }
    while (!fits(w)) {  // word longer than a whole line: split it by characters
      let n = w.length;
      while (n > 1 && !fits(w.slice(0, n))) n--;
      lines.push(w.slice(0, n)); w = w.slice(n);
    }
    cur = w;
  }
  if (cur.trim()) lines.push(cur.trim());
  if (lines.length > maxLines) {
    let last = lines[maxLines - 1] + '…';
    while (last.length > 1 && !fits(last)) last = last.slice(0, -2) + '…';
    lines.length = maxLines; lines[maxLines - 1] = last;
  }
  return lines;
}
const blockHeight = lines => lines.length * SL.nameLine + SL.stateH + SL.gap;

// Fill screens 4 and 5 top to bottom with as many sessions as fit; the rest become "+N more".
function packSessions(sessions) {
  const blocks = sessions.map(s => ({ s, lines: wrapLines(s.name, SL.width, SL.maxLines) }));
  const pack = lastBottom => {
    const screens = [[], []];
    let scr = 0, y = SL.top;
    for (const b of blocks) {
      const h = blockHeight(b.lines);
      if (y + h > (scr ? lastBottom : 126)) { if (scr === 1) break; scr = 1; y = 6; if (y + h > lastBottom) break; }
      screens[scr].push({ ...b, y }); y += h;
    }
    return { screens, more: sessions.length - screens[0].length - screens[1].length };
  };
  const full = pack(126);
  return full.more > 0 ? pack(112) : full;  // leave room for the "+N more" line
}

function screenSessions(entries, heading, more) {
  const key = 'list|' + heading + '|' + more + '|' + entries.map(e => e.s.name + ':' + e.s.state).join(',');
  const frame = clCanvas(c => {
    clBg(c);
    if (heading) clText(c, 'SESSIONS', 64, 16, 12, '#b8b8bd');
    if (!entries.length) {
      if (heading) clText(c, 'none yet', 64, 70, 13, '#6e6e73', 500);
      else { clSpark(c, 64, 52, 22, '#d97757'); clText(c, 'Claude Code', 64, 102, 14, '#d0d0d4', 700); }
      return;
    }
    c.textAlign = 'left'; c.textBaseline = 'top';
    for (const { s, lines, y } of entries) {
      const st = CL_STATES[s.state] || CL_STATES.idle;
      c.fillStyle = st.color; c.beginPath(); c.arc(8, y + 6, 4, 0, Math.PI * 2); c.fill();
      c.font = SL.nameFont; c.fillStyle = '#f2f2f5';
      lines.forEach((l, i) => c.fillText(l, SL.left, y + i * SL.nameLine));
      c.font = '600 10px system-ui, "Segoe UI", sans-serif'; c.fillStyle = st.color;
      c.fillText(st.short, SL.left, y + lines.length * SL.nameLine);
    }
    if (more > 0) clText(c, `+${more} more`, 124, 124, 10, '#9a9aa0', 600, 'right');
  });
  return { key, frames: [frame] };
}

// [{ key, frames }] for screens 1-5.
function renderClaude(d) {
  const { screens, more } = packSessions(d.sessions);
  return [screenState(d), screenUsage(d.usage?.five_hour, 'SESSION'), screenUsage(d.usage?.seven_day, 'WEEK'),
          screenSessions(screens[0], true, screens[1].length ? 0 : more), screenSessions(screens[1], false, more)];
}

if (typeof module === 'object') module.exports = { CL_STATES, CL_SPEED, renderClaude, resetText };
