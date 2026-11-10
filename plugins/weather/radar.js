// Rain radar for the Weather plugin: the last two hours (10-minute frames) from RainViewer, free for
// personal use with a credit, over a land and sea map made from OpenStreetMap tiles. The map's tiles
// are fetched once per place and kept in data/weather-radar/; radar frames are kept while they're
// in the last two hours, so each update fetches only the newest frame.
// One 128x128 view at zoom 7 (RainViewer's most detailed: about 125 km across in New Zealand),
// centred on the place.
const fs = require('fs');
const path = require('path');

const ZOOM = 7, SIZE = 128, FRESH_MS = 10 * 60 * 1000;
const UA = { 'User-Agent': 'TimesGate-controller (github.com/imapping/timesgate-controller)' };
const SEA = [5, 8, 11], LAND = [43, 49, 56], COAST = [89, 99, 110];

module.exports = tg => {
  const dir = path.join(tg.dir, '..', '..', 'data', 'weather-radar');
  let map = null, mapKey = '', placeKey = '', frames = [], checkedAt = 0, error = '', busy = null;
  const layers = new Map();   // RainViewer frame path → its 128x128 radar layer (recoloured)

  // Where the place is, in zoom-7 world pixels; the view's top-left corner.
  const world = (lat, lon) => {
    const n = 256 * 2 ** ZOOM, s = Math.sin(lat * Math.PI / 180);
    return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  };
  const corner = place => world(place.lat, place.lon).map(v => Math.round(v - SIZE / 2));
  const tiles = ([x0, y0]) => {
    const out = [];
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + SIZE - 1) / 256); tx++)
      for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + SIZE - 1) / 256); ty++) out.push([tx, ty]);
    return out;
  };
  async function download(url) {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`${new URL(url).host} returned ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  // Tiles drawn into one 128x128 canvas → its pixels.
  async function compose(c0, urlOf, cacheFile) {
    const cv = tg.makeCanvas(SIZE, SIZE), g = cv.getContext('2d');
    for (const [tx, ty] of tiles(c0)) {
      const file = cacheFile && cacheFile(tx, ty);
      let buf;
      if (file && fs.existsSync(file)) buf = fs.readFileSync(file);
      else { buf = await download(urlOf(tx, ty)); if (file) fs.writeFileSync(file, buf); }
      g.drawImage(await tg.loadImage(buf), tx * 256 - c0[0], ty * 256 - c0[1]);
    }
    return { cv, g, img: g.getImageData(0, 0, SIZE, SIZE) };
  }

  // The land and sea under the radar, from OpenStreetMap's own colours (its water is a pale blue),
  // tidied so roads and borders drawn over the land don't show, with the coast a little lighter.
  async function baseMap(place) {
    const key = `${ZOOM}_${place.lat.toFixed(3)}_${place.lon.toFixed(3)}`;
    if (mapKey === key && map) return map;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `map-${key}.png`);
    if (fs.existsSync(file)) {
      const cv = tg.makeCanvas(SIZE, SIZE);
      cv.getContext('2d').drawImage(await tg.loadImage(fs.readFileSync(file)), 0, 0);
      map = cv; mapKey = key;
      return map;
    }
    const { cv, g, img } = await compose(corner(place), (x, y) => `https://tile.openstreetmap.org/${ZOOM}/${x}/${y}.png`,
      (x, y) => path.join(dir, `osm-${ZOOM}-${x}-${y}.png`));
    const p = img.data, sea = new Uint8Array(SIZE * SIZE);
    for (let i = 0; i < sea.length; i++) {
      const r = p[i * 4], gr = p[i * 4 + 1], b = p[i * 4 + 2];
      sea[i] = b > 190 && gr > 180 && r < 200 && b - r > 30 ? 1 : 0;
    }
    // Each pixel takes the majority of its 3x3 neighbourhood (twice), which removes thin lines.
    let a = sea;
    for (let pass = 0; pass < 2; pass++) {
      const b = new Uint8Array(a.length);
      for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        let n = 0, t = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= SIZE || yy >= SIZE) continue;
          n += a[yy * SIZE + xx]; t++;
        }
        b[y * SIZE + x] = n * 2 > t ? 1 : 0;
      }
      a = b;
    }
    // Then land thinner than 3 pixels goes (the offshore boundary lines drawn over the sea): land shrinks
    // by a pixel all round and grows back, so only what survived the shrinking returns.
    const near = (src, x, y, want) => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(SIZE - 1, Math.max(0, x + dx)), yy = Math.min(SIZE - 1, Math.max(0, y + dy));
        if (src[yy * SIZE + xx] === want) return true;
      }
      return false;
    };
    const shrunk = new Uint8Array(a.length), grown = new Uint8Array(a.length);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) shrunk[y * SIZE + x] = a[y * SIZE + x] || near(a, x, y, 1) ? 1 : 0;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) grown[y * SIZE + x] = shrunk[y * SIZE + x] && near(shrunk, x, y, 0) ? 0 : shrunk[y * SIZE + x];
    a = grown;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const coast = !a[i] && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => a[(y + dy) * SIZE + x + dx] === 1 && x + dx >= 0 && x + dx < SIZE);
      const col = a[i] ? SEA : coast ? COAST : LAND;
      p[i * 4] = col[0]; p[i * 4 + 1] = col[1]; p[i * 4 + 2] = col[2]; p[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    fs.writeFileSync(file, cv.toBuffer('image/png'));
    map = cv; mapKey = key;
    return map;
  }

  // One radar frame for the view, in RainViewer's blues (light to heavy), then yellow to red for the
  // heaviest. Its pale beige haze (drizzle, or radar noise) is left out: it would cover most of the map.
  async function radarLayer(host, framePath, place) {
    const key = framePath + '|' + placeKey;
    if (layers.has(key)) return layers.get(key);
    const { cv, g, img } = await compose(corner(place), (x, y) => `${host}${framePath}/256/${ZOOM}/${x}/${y}/2/1_1.png`);
    const p = img.data;
    for (let i = 0; i < p.length; i += 4) {
      const r = p[i], gr = p[i + 1], b = p[i + 2];
      const keep = p[i + 3] > 120 && (b > r + 40 || (r > 200 && b < 120));
      p[i + 3] = keep ? 255 : 0;
    }
    g.putImageData(img, 0, 0);
    layers.set(key, cv);
    return cv;
  }

  async function refresh(place) {
    try {
      await baseMap(place).catch(e => { map = null; tg.log('Radar map:', e.message); });
      const r = await fetch('https://api.rainviewer.com/public/weather-maps.json', { headers: UA, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('RainViewer returned ' + r.status);
      const meta = await r.json(), past = meta.radar?.past || [];
      const next = [];
      for (let i = 0; i < past.length; i += 4)   // a few at a time (RainViewer asks for at most 100 requests a minute)
        next.push(...await Promise.all(past.slice(i, i + 4).map(async f => ({ time: f.time * 1000, layer: await radarLayer(meta.host, f.path, place) }))));
      const keep = new Set(past.map(f => f.path + '|' + placeKey));
      for (const k of layers.keys()) if (!keep.has(k)) layers.delete(k);
      frames = next; error = '';
    } catch (e) { error = e.message; tg.log('Radar:', e.message); }
    checkedAt = Date.now();
  }

  return {
    // { map, frames: [{ time, layer }], error }: the latest, fetched again when over 10 minutes old.
    async get(place) {
      const key = `${ZOOM}_${place.lat.toFixed(3)}_${place.lon.toFixed(3)}`;
      if (key !== placeKey) { placeKey = key; frames = []; layers.clear(); checkedAt = 0; }
      if (Date.now() - checkedAt > FRESH_MS) {
        busy ||= refresh(place).finally(() => { busy = null; });
        await busy;
      }
      return { map, frames, error };
    },
    // The same, as PNG data URLs, for the page's previews.
    async page(place) {
      const r = await this.get(place);
      const url = cv => cv && 'data:image/png;base64,' + cv.toBuffer('image/png').toString('base64');
      return { map: url(r.map), frames: r.frames.map(f => ({ time: f.time, layer: url(f.layer) })), error: r.error };
    },
  };
};
