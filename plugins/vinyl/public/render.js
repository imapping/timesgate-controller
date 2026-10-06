// Draws the record that's playing: album art, title (across screens 2–3), artist, and a spinning
// record with the album and year. Same layout as the Spotify plugin.
// Shared by the page (previews) and server.js. Needs a global makeCanvas(w, h).

const VN_FONT = (size, weight = 800) => `${weight} ${size}px system-ui, "Segoe UI", sans-serif`;
const VN_FRAMES = 8, VN_SPEED = 120;

// Largest font (maxSize down to minSize) at which text word-wraps into maxLines within maxW × maxH.
function vnFit(g, text, maxW, maxH, maxLines, maxSize, minSize, weight = 800) {
  const wrap = size => {
    g.font = VN_FONT(size, weight);
    const lines = [];
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const line = lines.length ? lines[lines.length - 1] + ' ' + word : word;
      if (lines.length && g.measureText(line).width <= maxW) lines[lines.length - 1] = line;
      else lines.push(word);
    }
    return lines;
  };
  for (let size = maxSize; size >= minSize; size -= 2) {
    const lines = wrap(size);
    if (lines.length <= maxLines && lines.length * size * 1.15 <= maxH && lines.every(l => g.measureText(l).width <= maxW)) return { size, lines };
  }
  const all = wrap(minSize), lines = all.slice(0, maxLines), i = lines.length - 1;
  let cut = all.length > maxLines;
  while (lines[i].length > 1 && g.measureText(lines[i] + (cut ? '…' : '')).width > maxW) { lines[i] = lines[i].slice(0, -1); cut = true; }
  if (cut) lines[i] += '…';
  return { size: minSize, lines };
}
function vnText(g, text, x, top, maxW, maxH, maxLines, maxSize, minSize, color, weight) {
  const { size, lines } = vnFit(g, text, maxW, maxH, maxLines, maxSize, minSize, weight);
  g.font = VN_FONT(size, weight); g.fillStyle = color; g.textBaseline = 'middle';
  const lh = size * 1.15, y0 = top + (maxH - lines.length * lh) / 2 + lh / 2;
  lines.forEach((l, i) => g.fillText(l, x, y0 + i * lh));
}
function vnCanvas(w, bg) {
  const c = makeCanvas(w, 128), g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, w, 128);
  return [c, g];
}

// Colours from the album art: a dark tinted background and a bright accent of the same hue.
function vnArtColours(img) {
  const c = makeCanvas(1, 1), g = c.getContext('2d');
  g.drawImage(img, 0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
  const k = 235 / Math.max(r, gr, b, 1);
  return { img, bg: `rgb(${r * .22 | 0},${gr * .22 | 0},${b * .22 | 0})`,
    accent: `rgb(${Math.min(255, r * k + 40) | 0},${Math.min(255, gr * k + 40) | 0},${Math.min(255, b * k + 40) | 0})` };
}

// A record seen from above, turned by `angle`; the label shows the album art if there is any.
function vnRecord(g, cx, cy, r, angle, accent, art) {
  g.save(); g.translate(cx, cy); g.rotate(angle);
  g.fillStyle = '#0b0b0c'; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1;
  for (let rr = r * 0.45; rr < r - 2; rr += 3) { g.beginPath(); g.arc(0, 0, rr, 0, Math.PI * 2); g.stroke(); }
  // a sheen, so the turning shows
  g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = r * 0.5;
  g.beginPath(); g.arc(0, 0, r * 0.7, -0.35, 0.05); g.stroke();
  g.save(); g.beginPath(); g.arc(0, 0, r * 0.36, 0, Math.PI * 2); g.clip();
  if (art) g.drawImage(art.img, -r * 0.36, -r * 0.36, r * 0.72, r * 0.72);
  else { g.fillStyle = accent; g.fillRect(-r, -r, 2 * r, 2 * r); }
  g.restore();
  g.fillStyle = '#0b0b0c'; g.beginPath(); g.arc(0, 0, 2.5, 0, Math.PI * 2); g.fill();
  g.restore();
}

// t: { title, artist, album, year, where, last } or null (last: the last track on its side); art: vnArtColours(image) or null; status: text when nothing's identified.
// Returns [{ key, jobs }] for screen 1, screens 2–3, screen 4 and screen 5.
function renderVinyl(t, art, status) {
  if (!t) art = null;
  const bg = art ? art.bg : '#141210', accent = art ? art.accent : '#f0b44c';
  const id = t ? `${t.title}|${t.artist}` : 'none';
  const parts = [];
  { // Screen 1: album art, or a record
    const [c, g] = vnCanvas(128, bg);
    if (art) g.drawImage(art.img, 0, 0, 128, 128);
    else vnRecord(g, 64, 64, 54, 0, accent, null);
    parts.push({ key: 'art:' + id + !!art, jobs: [{ screen: 0, frames: [c] }] });
  }
  { // Screens 2–3: title
    const [c, g] = vnCanvas(256, bg);
    g.font = VN_FONT(11, 700); g.fillStyle = accent; g.textBaseline = 'middle';
    g.fillText(t ? 'ON THE TURNTABLE' : 'VINYL', 10, 14);
    vnText(g, t ? t.title : (status || 'Listening…'), 10, 26, 236, 96, 3, t ? 40 : 24, 14, t ? '#ffffff' : '#c8c8cc');
    parts.push({ key: 'title:' + id + (t ? '' : status) + bg, jobs: [{ screen: 1, frames: [c], x: 0 }, { screen: 2, frames: [c], x: 128 }] });
  }
  { // Screen 4: artist
    const [c, g] = vnCanvas(128, bg);
    if (t && t.artist) {
      g.font = VN_FONT(11, 700); g.fillStyle = accent; g.textBaseline = 'middle';
      g.fillText('ARTIST', 8, 14);
      vnText(g, t.artist, 8, 26, 112, 96, 3, 28, 11, '#ffffff');
    }
    parts.push({ key: 'artist:' + id + bg, jobs: [{ screen: 3, frames: [c] }] });
  }
  { // Screen 5: spinning record, album and year
    const frames = [];
    for (let f = 0; f < VN_FRAMES; f++) {
      const [c, g] = vnCanvas(128, bg);
      vnRecord(g, 64, t ? 46 : 64, t ? 40 : 52, f / VN_FRAMES * Math.PI * 2, accent, art);
      if (t) {
        g.textAlign = 'center';
        const sub = [t.album, t.year].filter(Boolean).join(' · ');
        if (sub) {
          if (t.where && t.last) vnText(g, sub, 64, 87, 116, 16, 1, 13, 8, '#d0d0d8', 600);   // (one line above the band)
          else vnText(g, sub, 64, 90, 116, t.where ? 24 : 36, 2, 14, 9, '#d0d0d8', 600);
        }
        if (t.where && t.last) {   // the last track on the side: "Side B · last track", on a band of the accent colour
          const w = /track \d+$/.test(t.where) ? t.where.replace(/track \d+$/, 'last track') : t.where + ' · last track';
          g.fillStyle = accent; g.fillRect(4, 105, 120, 19);
          vnText(g, w, 64, 106, 116, 17, 1, 12, 8, bg, 800);
        } else if (t.where) vnText(g, t.where, 64, 114, 116, 12, 1, 11, 8, accent, 700);   // where it is on the record (from Discogs)
      }
      frames.push(c);
    }
    parts.push({ key: 'record:' + id + bg + (t ? [t.album, t.year, t.where, !!t.last].join('|') : ''), jobs: [{ screen: 4, frames }] });
  }
  return { speed: VN_SPEED, parts };
}

if (typeof module === 'object') module.exports = { renderVinyl, vnArtColours };
