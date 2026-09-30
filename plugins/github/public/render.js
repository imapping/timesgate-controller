// Draws the GitHub screens. Shared by the page (previews) and the server (engine.js).
//   1: the repository and its stars (or a celebration when something new happens)
//   2: visitors over the last 14 days   3: clones over the last 14 days
//   4: forks, watchers, issues, pull requests, last commit, top referrer
//   5: your contribution graph (or the latest commit, without a token)
// Input is the server's view: { repo, contrib, party, now }. Needs a global makeCanvas(w, h).

const GH_SPEED = 120, GH_PARTY_FRAMES = 12;
const GH = {
  bg: '#0d1117', panel: '#161b22', text: '#e6edf3', muted: '#8b949e', line: '#30363d',
  star: '#e3b341', blue: '#58a6ff', green: '#3fb950', purple: '#a371f7', orange: '#f0883e',
  levels: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'],
};

function ghText(c, s, x, y, size, color, weight = '600', align = 'center', maxW = 124) {
  c.font = `${weight} ${size}px system-ui, "Segoe UI", sans-serif`;
  c.fillStyle = color; c.textAlign = align; c.textBaseline = 'alphabetic';
  c.fillText(String(s), x, y, maxW);
}
// Largest size (down to min) at which the text fits the width.
function ghFit(c, s, size, maxW, weight = '700', min = 9) {
  for (; size > min; size--) {
    c.font = `${weight} ${size}px system-ui, "Segoe UI", sans-serif`;
    if (c.measureText(s).width <= maxW) break;
  }
  return size;
}
// Word-wrap into at most maxLines lines ("…" on the last if it doesn't fit).
function ghWrap(c, s, size, maxW, maxLines, weight = '600') {
  c.font = `${weight} ${size}px system-ui, "Segoe UI", sans-serif`;
  const words = String(s).split(/\s+/).filter(Boolean), lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (c.measureText(t).width <= maxW || !line) line = t;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last.length > 1 && c.measureText(last + '…').width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  }
  return lines;
}
function ghNum(n) {
  if (n == null) return '–';
  if (n >= 10000) return Math.round(n / 1000) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}
function ghAgo(iso, now) {
  if (!iso) return '';
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (m < 2) return 'just now';
  if (m < 60) return m + 'm ago';
  if (m < 48 * 60) return Math.round(m / 60) + 'h ago';
  return Math.round(m / 1440) + 'd ago';
}
function ghStar(c, x, y, r, color) {
  c.fillStyle = color; c.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r;
    c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  c.closePath(); c.fill();
}
// Small icons for the activity list (drawn, so no font glyphs are needed).
function ghIcon(c, kind, x, y, color) {
  c.strokeStyle = color; c.fillStyle = color; c.lineWidth = 2; c.lineCap = 'round';
  const dot = (dx, dy, r) => { c.beginPath(); c.arc(x + dx, y + dy, r, 0, Math.PI * 2); c.stroke(); };
  if (kind === 'fork') {
    dot(-3, -4, 1.8); dot(3, -4, 1.8); dot(0, 5, 1.8);
    c.beginPath(); c.moveTo(x - 3, y - 2); c.lineTo(x - 3, y); c.lineTo(x, y + 1.5); c.lineTo(x + 3, y); c.lineTo(x + 3, y - 2); c.moveTo(x, y + 1.5); c.lineTo(x, y + 3); c.stroke();
  } else if (kind === 'eye') {
    c.beginPath(); c.ellipse(x, y, 6, 3.8, 0, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(x, y, 1.6, 0, Math.PI * 2); c.fill();
  } else if (kind === 'issue') {
    dot(0, 0, 5.2); c.beginPath(); c.arc(x, y, 1.4, 0, Math.PI * 2); c.fill();
  } else if (kind === 'pr') {
    dot(-3, -4, 1.8); dot(-3, 5, 1.8); dot(4, 5, 1.8);
    c.beginPath(); c.moveTo(x - 3, y - 2); c.lineTo(x - 3, y + 3); c.moveTo(x + 4, y + 3); c.lineTo(x + 4, y - 3); c.lineTo(x + 1, y - 3); c.stroke();
  } else if (kind === 'commit') {
    dot(0, 0, 2.6); c.beginPath(); c.moveTo(x - 7, y); c.lineTo(x - 3, y); c.moveTo(x + 3, y); c.lineTo(x + 7, y); c.stroke();
  } else if (kind === 'link') {
    c.beginPath(); c.arc(x, y, 5.2, 0, Math.PI * 2); c.moveTo(x - 5, y); c.lineTo(x + 5, y); c.moveTo(x, y - 5.2); c.ellipse(x, y, 2.2, 5.2, 0, 0, Math.PI * 2); c.stroke();
  } else if (kind === 'lock') {
    c.beginPath(); c.arc(x, y - 3, 4, Math.PI, 0); c.stroke(); c.fillRect(x - 6, y - 2, 12, 9);
  }
}
function ghBack(c) { c.fillStyle = GH.bg; c.fillRect(0, 0, 128, 128); }
function ghTitle(c, s, color = GH.muted) { ghText(c, s, 64, 15, 11, color, '700'); }

// Stable pseudo-random numbers, so the confetti looks the same on the page and the device.
function ghRand(seed) { let x = seed * 9301 + 49297; return () => ((x = (x * 9301 + 49297) % 233280) / 233280); }

// ---------- screen 1 ----------
function ghDrawRepo(c, r) {
  ghBack(c);
  ghText(c, r.owner, 64, 17, 11, GH.muted, '600');
  const size = ghFit(c, r.repo, 18, 120);
  if (size > 11) ghText(c, r.repo, 64, 37, size, GH.text, '700');
  else {  // wrap long names after - _ or .
    const lines = ghWrap(c, r.repo.replace(/([-_.])/g, '$1 '), 12, 120, 2, '700').map(l => l.replace(/([-_.]) /g, '$1'));
    lines.forEach((l, i) => ghText(c, l, 64, 31 + i * 13, 12, GH.text, '700'));
  }
  ghStar(c, 64, 62, 13, GH.star);
  const n = ghNum(r.stars);
  ghText(c, n, 64, 102, ghFit(c, n, 30, 120), GH.text, '700');
  if (r.today > 0) {
    const s = `+${r.today} today`;
    c.font = '700 11px system-ui, "Segoe UI", sans-serif';
    const w = c.measureText(s).width + 12;
    c.fillStyle = '#1a3d24'; c.beginPath(); c.roundRect ? c.roundRect(64 - w / 2, 108, w, 16, 8) : c.rect(64 - w / 2, 108, w, 16); c.fill();
    ghText(c, s, 64, 120, 11, GH.green, '700');
  } else ghText(c, r.stars === 1 ? 'star' : 'stars', 64, 120, 11, GH.muted, '600');
}
const GH_PARTY = {
  star: { title: 'NEW STAR!', color: GH.star, icon: 'star' },
  fork: { title: 'NEW FORK!', color: GH.blue, icon: 'fork' },
  issue: { title: 'NEW ISSUE', color: GH.green, icon: 'issue' },
  pr: { title: 'NEW PR!', color: GH.purple, icon: 'pr' },
};
function ghDrawParty(c, p, f) {
  const k = GH_PARTY[p.kind] || GH_PARTY.star, t = f / GH_PARTY_FRAMES;
  ghBack(c);
  // confetti falling in a loop
  const rnd = ghRand(7), colors = [GH.star, GH.blue, GH.green, GH.purple, GH.orange, '#ff7b72'];
  for (let i = 0; i < 26; i++) {
    const x = rnd() * 128, speed = 0.6 + rnd() * 0.8, ph = rnd(), col = colors[i % colors.length];
    const y = ((ph + t * speed) % 1) * 140 - 8, sway = Math.sin((t + ph) * Math.PI * 2) * 4;
    c.fillStyle = col; c.save(); c.translate(x + sway, y); c.rotate((t + ph) * Math.PI * 2);
    c.fillRect(-2.5, -1.5, 5, 3); c.restore();
  }
  const pulse = 1 + 0.12 * Math.sin(t * Math.PI * 2);
  if (k.icon === 'star') ghStar(c, 64, 48, 22 * pulse, k.color);
  else { c.save(); c.translate(64, 48); c.scale(2.6 * pulse, 2.6 * pulse); ghIcon(c, k.icon, 0, 0, k.color); c.restore(); }
  ghText(c, k.title, 64, 94, ghFit(c, k.title, 20, 122), k.color, '800');
  if (p.who) ghText(c, '@' + p.who, 64, 116, ghFit(c, '@' + p.who, 13, 120, '600'), GH.text, '600');
}

// ---------- screens 2 and 3 ----------
function ghDrawTraffic(c, title, tr, color, status) {
  ghBack(c); ghTitle(c, title);
  if (!tr || tr.error) {
    ghIcon(c, 'lock', 64, 50, GH.muted);
    const msg = status === 'no token' ? 'Add a GitHub token to see this' : status === 'no access' ? 'The token needs Administration: read' : 'Not available right now';
    ghWrap(c, msg, 12, 116, 3, '600').forEach((l, i) => ghText(c, l, 64, 80 + i * 15, 12, GH.muted, '600'));
    return;
  }
  ghText(c, ghNum(tr.total), 64, 50, ghFit(c, ghNum(tr.total), 30, 120), color, '700');
  ghText(c, `${ghNum(tr.uniques)} unique · 14 days`, 64, 66, 10, GH.muted, '600');
  const max = Math.max(1, ...tr.days), n = tr.days.length, w = 7, gap = 2, x0 = (128 - (n * (w + gap) - gap)) / 2;
  tr.days.forEach((v, i) => {
    const h = v ? Math.max(3, Math.round(v / max * 44)) : 1;
    c.fillStyle = i === n - 1 ? color : v ? color + 'b0' : GH.line;
    c.fillRect(x0 + i * (w + gap), 122 - h, w, h);
  });
}

// ---------- screen 4 ----------
function ghDrawActivity(c, r, now) {
  ghBack(c); ghTitle(c, 'ACTIVITY');
  const rows = [
    ['fork', GH.blue, `${ghNum(r.forks)} ${r.forks === 1 ? 'fork' : 'forks'}`],
    ['eye', GH.muted, `${ghNum(r.watchers)} watching`],
    ['issue', GH.green, `${ghNum(r.issues)} open ${r.issues === 1 ? 'issue' : 'issues'}`],
    ['pr', GH.purple, `${ghNum(r.prs)} open ${r.prs === 1 ? 'PR' : 'PRs'}`],
  ];
  rows.forEach(([icon, col, s], i) => { const y = 32 + i * 17; ghIcon(c, icon, 12, y, col); ghText(c, s, 24, y + 4, 12, GH.text, '600', 'left', 100); });
  c.fillStyle = GH.line; c.fillRect(6, 97, 116, 1);
  if (r.commit) { ghIcon(c, 'commit', 12, 108, GH.orange); ghText(c, 'commit ' + ghAgo(r.commit.at, now), 24, 112, 11, GH.muted, '600', 'left', 100); }
  if (r.referrer) { ghIcon(c, 'link', 12, 122, GH.blue); ghText(c, r.referrer.name, 24, 126, 11, GH.muted, '600', 'left', 100); }
}

// ---------- screen 5 ----------
function ghDrawContrib(c, k) {
  ghBack(c); ghTitle(c, 'CONTRIBUTIONS');
  ghText(c, '@' + k.login, 64, 30, ghFit(c, '@' + k.login, 12, 120, '600'), GH.text, '600');
  const weeks = k.weeks, cell = 7, step = 8, x0 = Math.round((128 - (weeks.length * step - 1)) / 2);
  const max = Math.max(1, ...weeks.flat());
  weeks.forEach((w, wi) => w.forEach((v, d) => {
    const lvl = v === 0 ? 0 : Math.min(4, 1 + Math.floor(v / max * 3.999));
    c.fillStyle = GH.levels[lvl]; c.fillRect(x0 + wi * step, 38 + d * step, cell, cell);
  }));
  ghText(c, ghNum(k.total), 64, 114, 18, GH.green, '700');
  ghText(c, 'this year', 64, 126, 10, GH.muted, '600');
}
function ghDrawCommit(c, r, now) {
  ghBack(c); ghTitle(c, 'LATEST COMMIT');
  if (!r.commit) { ghText(c, 'No commits yet', 64, 70, 12, GH.muted); return; }
  ghWrap(c, r.commit.msg, 13, 118, 5, '600').forEach((l, i) => ghText(c, l, 64, 38 + i * 16, 13, GH.text, '600'));
  ghText(c, ghAgo(r.commit.at, now), 64, 122, 11, GH.orange, '600');
}

// view → [{ key, frames }] for the five screens
function renderGithub(v) {
  const r = v.repo, now = v.now || Date.now();
  const one = draw => { const cv = makeCanvas(128, 128); draw(cv.getContext('2d')); return [cv]; };
  const k = (...a) => 'gh|' + r.name + '|' + JSON.stringify(a);
  const screens = [];
  if (v.party) screens.push({ key: k('party', v.party.kind, v.party.who, v.party.at),
    frames: Array.from({ length: GH_PARTY_FRAMES }, (_, f) => { const cv = makeCanvas(128, 128); ghDrawParty(cv.getContext('2d'), v.party, f); return cv; }) });
  else screens.push({ key: k('repo', r.stars, r.today), frames: one(c => ghDrawRepo(c, r)) });
  screens.push({ key: k('views', r.views, r.traffic), frames: one(c => ghDrawTraffic(c, 'VISITORS', r.views, GH.blue, r.traffic)) });
  screens.push({ key: k('clones', r.clones, r.traffic), frames: one(c => ghDrawTraffic(c, 'CLONES', r.clones, GH.green, r.traffic)) });
  screens.push({ key: k('act', r.forks, r.watchers, r.issues, r.prs, r.commit && ghAgo(r.commit.at, now), r.referrer), frames: one(c => ghDrawActivity(c, r, now)) });
  const kc = v.contrib && !v.contrib.error ? v.contrib : null;
  screens.push(kc ? { key: k('contrib', kc.login, kc.total, kc.weeks), frames: one(c => ghDrawContrib(c, kc)) }
    : { key: k('commit', r.commit, r.commit && ghAgo(r.commit.at, now)), frames: one(c => ghDrawCommit(c, r, now)) });
  return screens;
}

if (typeof module === 'object') module.exports = { GH_SPEED, renderGithub, ghNum, ghAgo };
