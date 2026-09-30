// Visualizer screens: an EQ-bar animation across all five screens that loops once every two beats,
// so it plays in time with the music's tempo. (The device can't take live frames fast enough for a
// real spectrum, so the tempo is matched instead and the loop is re-sent when the tempo changes.)
// Shared by the page (previews) and server.js. Needs a global makeCanvas(w, h).

const VIZ_FRAMES = 12;
const vizSpeed = bpm => Math.max(40, Math.round(120000 / (bpm || 120) / VIZ_FRAMES));

// Colour n of a palette, as [h, s, l] (hue in degrees).
const VIZ_PALETTES = {
  rainbow: { name: 'Rainbow', hsl: n => [(n * 47) % 360, 95, 55] },
  fire:    { name: 'Fire',    hsl: n => [[0, 12, 25, 40, 8][n % 5], 100, [50, 55, 50, 58, 45][n % 5]] },
  ocean:   { name: 'Ocean',   hsl: n => [[190, 210, 230, 260, 175][n % 5], 90, 55] },
  party:   { name: 'Party',   hsl: n => [(n * 137.5) % 360, 100, 55] },
};
const vizPalette = name => VIZ_PALETTES[name] || VIZ_PALETTES.rainbow;
const vizHex = ([h, s, l]) => {
  s /= 100; l /= 100;
  const f = k => { const x = (k + h / 30) % 12; return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(x - 3, 9 - x, 1)))); };
  return '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('');
};

function vizRender(bpm, palette) {
  bpm = bpm || 120;
  const pal = vizPalette(palette);
  const BARS = 20, BW = 32, BLOCK = 8;
  // each bar's own height pattern, fixed so the loop repeats seamlessly
  const base = Array.from({ length: BARS }, (_, i) => 0.45 + 0.55 * Math.abs(Math.sin(i * 12.9898) * 0.5 + Math.sin(i * 4.1414) * 0.5));
  const frames = [];
  for (let f = 0; f < VIZ_FRAMES; f++) {
    const c = makeCanvas(640, 128), g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 640, 128);
    const phase = (f % (VIZ_FRAMES / 2)) / (VIZ_FRAMES / 2);   // 0 at each beat, rising to 1
    const pulse = Math.pow(1 - phase, 1.6);
    for (let i = 0; i < BARS; i++) {
      const wobble = 0.55 + 0.45 * Math.sin(2 * Math.PI * (f / VIZ_FRAMES * 2 + i * 0.37));
      const h = Math.max(1, Math.round((0.18 + 0.82 * base[i] * (0.35 + 0.65 * pulse) * wobble) * 128 / BLOCK));
      const [hue, sat, lig] = pal.hsl(Math.floor(i / 2));
      for (let b = 0; b < h; b++) {
        g.fillStyle = `hsl(${hue}, ${sat}%, ${Math.min(80, lig - 12 + b * 3)}%)`;
        g.fillRect(i * BW + 3, 128 - (b + 1) * BLOCK + 1, BW - 6, BLOCK - 2);
      }
    }
    frames.push(c);
  }
  const key = `viz|${bpm}|${palette}`;
  return { speed: vizSpeed(bpm), parts: [0, 1, 2, 3, 4].map(s => ({ key, jobs: [{ screen: s, frames, x: s * 128 }] })) };
}

if (typeof module === 'object') module.exports = { vizRender, vizPalette, vizHex, VIZ_PALETTES };
