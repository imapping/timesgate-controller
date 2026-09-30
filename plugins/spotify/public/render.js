// Draws Spotify's now playing: album art, song (across screens 2–3), artist, play/pause + album.
// Shared by the page (previews) and the server (engine.js). Needs a global makeCanvas(w, h).

const SP_FONT = (size, weight = 800) => `${weight} ${size}px system-ui, "Segoe UI", sans-serif`;

// Largest font (maxSize down to minSize) at which text word-wraps into maxLines within maxW × maxH.
// At the smallest size the last line is cut short with an ellipsis.
function spFit(g, text, maxW, maxH, maxLines, maxSize, minSize, weight = 800) {
  const wrap = size => {
    g.font = SP_FONT(size, weight);
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

function spText(g, text, x, top, maxW, maxH, maxLines, maxSize, minSize, color, weight) {
  const { size, lines } = spFit(g, text, maxW, maxH, maxLines, maxSize, minSize, weight);
  g.font = SP_FONT(size, weight); g.fillStyle = color; g.textBaseline = 'middle';
  const lh = size * 1.15, y0 = top + (maxH - lines.length * lh) / 2 + lh / 2;
  lines.forEach((l, i) => g.fillText(l, x, y0 + i * lh));
}

function spCanvas(w, bg) {
  const c = makeCanvas(w, 128), g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, w, 128);
  return [c, g];
}

// Colours picked from the album art: a dark tinted background and a bright accent of the same hue.
function spArtColours(img) {
  const c = makeCanvas(1, 1), g = c.getContext('2d');
  g.drawImage(img, 0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
  const k = 235 / Math.max(r, gr, b, 1);
  return { img, bg: `rgb(${r * .22 | 0},${gr * .22 | 0},${b * .22 | 0})`,
    accent: `rgb(${Math.min(255, r * k + 40) | 0},${Math.min(255, gr * k + 40) | 0},${Math.min(255, b * k + 40) | 0})` };
}

// "Song - Remastered 2011" / "Album (2011 Remaster)" → just the name, to save space on the screens.
const spClean = s => (s || '').replace(/\s+-\s+[^-]*remaster[^-]*$/i, '').replace(/\s*[([][^)\]]*remaster[^)\]]*[)\]]/ig, '').trim() || s;

// d: the server's /api/spotify/now reply; art: spArtColours(image) or null.
// Returns [{ key, jobs }] for screen 1, screens 2–3, screen 4 and screen 5.
function renderSpotify(d, art) {
  const it = d && d.item && { ...d.item, name: spClean(d.item.name), album: spClean(d.item.album) };
  if (!it) art = null;
  const bg = art ? art.bg : '#121214', accent = art ? art.accent : '#1ed760';
  const parts = [];

  // Screen 1: album art, or a music note.
  {
    const [c, g] = spCanvas(128, bg);
    if (art) g.drawImage(art.img, 0, 0, 128, 128);
    else { g.fillStyle = '#1ed760'; g.font = SP_FONT(72, 400); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('♪', 64, 66); }
    parts.push({ key: 'art:' + (it ? it.art : 'none'), jobs: [{ screen: 0, frames: [c] }] });
  }
  // Screens 2–3: the song title, across both.
  {
    const [c, g] = spCanvas(256, bg);
    g.font = SP_FONT(11, 700); g.fillStyle = accent; g.textBaseline = 'middle';
    g.fillText(!it ? 'SPOTIFY' : d.playing ? 'NOW PLAYING' : 'PAUSED', 10, 14);
    spText(g, it ? it.name : 'Nothing playing', 10, 26, 236, 96, 3, 40, 14, '#ffffff');
    parts.push({ key: 'song:' + (it ? it.name + (art ? art.accent : '') : '') + d.playing, jobs: [{ screen: 1, frames: [c], x: 0 }, { screen: 2, frames: [c], x: 128 }] });
  }
  // Screen 4: the artist.
  {
    const [c, g] = spCanvas(128, bg);
    if (it && it.artist) {
      g.font = SP_FONT(11, 700); g.fillStyle = accent; g.textBaseline = 'middle';
      g.fillText(it.type === 'episode' ? 'SHOW' : 'ARTIST', 8, 14);
      spText(g, it.artist, 8, 26, 112, 96, 3, 28, 11, '#ffffff');
    }
    parts.push({ key: 'artist:' + (it ? it.artist + bg : ''), jobs: [{ screen: 3, frames: [c] }] });
  }
  // Screen 5: play/pause symbol and the album name.
  {
    const [c, g] = spCanvas(128, bg);
    if (it) {
      g.fillStyle = accent;
      if (d.playing) { g.beginPath(); g.moveTo(48, 20); g.lineTo(84, 42); g.lineTo(48, 64); g.closePath(); g.fill(); }
      else { g.fillRect(46, 20, 12, 44); g.fillRect(70, 20, 12, 44); }
      g.textAlign = 'center';
      if (it.album && it.album !== it.artist) spText(g, it.album, 64, 76, 116, 46, 2, 16, 10, '#d0d0d8', 600);
    }
    parts.push({ key: 'state:' + (it ? it.album + d.playing + bg : ''), jobs: [{ screen: 4, frames: [c] }] });
  }
  return parts;
}

if (typeof module === 'object') module.exports = { renderSpotify, spArtColours };
