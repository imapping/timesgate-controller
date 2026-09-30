// Animated effects for the TimesGate.
// Each effect is rendered in the browser across all 5 screens as one 640x128 strip, previewed
// live on the screen tiles, then uploaded as a looping multi-frame animation per screen, so it
// keeps playing on the device after this page is closed.
// Relies on globals from index.html (cmd, log, sel, needSel, store, lastContent, lastLights, …) and anim.js.

const TAU = Math.PI * 2;
const frac = v => v - Math.floor(v);

function hsv(h, s, v) {
  h = frac(h) * 6;
  const i = Math.floor(h), f = h - i;
  const p = v * (1 - s), q = v * (1 - s * f), u = v * (1 - s * (1 - f));
  const [r, g, b] = [[v, u, p], [q, v, p], [p, v, u], [p, q, v], [u, p, v], [v, p, q]][i % 6];
  return [r * 255 | 0, g * 255 | 0, b * 255 | 0];
}
const css = ([r, g, b], a = 1) => `rgba(${r},${g},${b},${a})`;
const hex = ([r, g, b]) => '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');

// Deterministic pseudo-random number in [0,1) from integer inputs.
function hash(a, b = 0, c = 0) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1103515245);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Effects render into a W x S buffer (W = 5 screens), S = pixels per screen side.
// `pixel(x, y, t, W, S, f, N)` returns [r,g,b]; `draw(ctx, t, W, S, f, N)` paints on top.
// t runs 0..1 over the loop, so anything periodic in t loops seamlessly.
const EFFECTS = {
  disco: {
    name: '🪩 Disco floor',
    pixel(x, y, t, W, S, f) {
      const tile = S / 4, tx = Math.floor(x / tile), ty = Math.floor(y / tile), beat = f >> 1;
      if (tile >= 4 && (x % tile === 0 || y % tile === 0)) return [8, 8, 12];
      const lit = hash(tx, ty, beat) > 0.45;
      return hsv(hash(tx, ty, beat + 991), 0.9, lit ? 1 : 0.1);
    },
    draw(ctx, t, W, S, f) {
      const d = Math.max(1, S / 32);
      for (let i = 0; i < 70; i++) {
        if (hash(i, f, 7) < 0.4) continue;
        const x = frac(hash(i, 1) + t) * W, y = hash(i, 2) * S;
        ctx.fillStyle = '#fff';
        ctx.fillRect(x - d, y, d * 3, d);
        ctx.fillRect(x, y - d, d, d * 3);
      }
    },
  },
  chase: {
    name: '🎉 Party chase',
    draw(ctx, t, W, S, f) {
      const seq = [0, 1, 2, 3, 4, 3, 2, 1], lit = seq[f % 8];
      for (let s = 0; s < 5; s++) {
        const col = hsv(f * 0.137 + s * 0.2, 1, 1);
        ctx.fillStyle = css(col, s === lit ? 1 : 0.12);
        ctx.fillRect(s * S, 0, S, S);
        if (s === lit) {
          const g = ctx.createRadialGradient(s * S + S / 2, S / 2, 0, s * S + S / 2, S / 2, S * 0.6);
          g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = g; ctx.fillRect(s * S, 0, S, S);
        }
      }
      const d = Math.max(1, S / 32);
      for (let i = 0; i < 90; i++) {
        ctx.fillStyle = css(hsv(hash(i, 3), 1, 1));
        ctx.fillRect(hash(i, 1, f) * W, frac(hash(i, 2) + t * 2) * S, d * 2, d * 2);
      }
    },
  },
  plasma: {
    name: '🌈 Plasma',
    pixel(x, y, t, W, S) {
      const u = x / S, v = y / S, a = TAU * t;
      const val = Math.sin(u * 3 + a) + Math.sin(v * 4 + a * 2) + Math.sin((u + v) * 2.5 - a)
        + Math.sin(Math.hypot(u - 2.5, v - 0.5) * 4 - a * 2);
      return hsv(val / 8 + t, 1, 1);
    },
  },
  rainbow: {
    name: '🌊 Rainbow wave',
    pixel(x, y, t, W, S) {
      const u = x / S, v = y / S;
      return hsv(u / 5 + Math.sin(TAU * (v * 0.5 + t)) * 0.08 - t, 1, 0.75 + 0.25 * Math.sin(TAU * (u * 0.6 - t * 2)));
    },
  },
  rings: {
    name: '🌀 Hypno rings',
    pixel(x, y, t, W, S) {
      const s = Math.floor(x / S), d = Math.hypot(x - (s + 0.5) * S, y - S / 2) / S;
      const b = 0.5 + 0.5 * Math.sin(TAU * (d * 4 - t * 2 + s * 0.1));
      return hsv(d * 0.8 + t + s * 0.2, 1, b);
    },
  },
  lava: {
    name: '🫧 Lava lamp',
    pixel(x, y, t, W, S) {
      let field = 0;
      for (let i = 0; i < 7; i++) {
        const k = 1 + (i % 3), m = 1 + ((i + 1) % 2);
        const cx = W / 2 + (W / 2 - S * 0.3) * Math.sin(TAU * t * k + i * 1.7);
        const cy = S / 2 + S * 0.3 * Math.sin(TAU * t * m + i * 2.3);
        const r = S * (0.28 + 0.06 * (i % 2));
        field += (r * r) / ((x - cx) ** 2 + (y - cy) ** 2 + 1);
      }
      if (field > 1) return hsv(0.02 + Math.min(field - 1, 2) * 0.05, 1, 1);
      return hsv(0.8, 0.8, 0.1 + 0.25 * field);
    },
  },
  stars: {
    name: '🚀 Hyperspace',
    draw(ctx, t, W, S) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, S);
      ctx.lineCap = 'round';
      for (let i = 0; i < 160; i++) {
        const a = hash(i, 1) * TAU, speed = 1 + (i % 2);
        const z = frac(hash(i, 2) + t * speed), z0 = Math.max(0, z - 0.06);
        const R = S * 1.2;
        const p = zz => [W / 2 + Math.cos(a) * zz * zz * R * 2.2, S / 2 + Math.sin(a) * zz * zz * R];
        const [x1, y1] = p(z0), [x2, y2] = p(z);
        ctx.strokeStyle = css(hsv(0.55 + hash(i, 3) * 0.2, 0.4, 1), z);
        ctx.lineWidth = Math.max(1, (S / 64) * (0.5 + z * 2));
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
    },
  },
  matrix: {
    name: '💚 Matrix rain',
    draw(ctx, t, W, S, f) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, S);
      const cw = Math.max(1, S / 12), rows = Math.ceil(S / cw), glyphs = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ0123456789';
      ctx.font = `${cw}px monospace`; ctx.textBaseline = 'top';
      for (let c = 0; c < W / cw; c++) {
        const k = 1 + Math.floor(hash(c, 1) * 2), trail = rows * 0.7;
        const head = frac(hash(c, 2) + t * k) * (rows + trail);
        for (let j = 0; j < rows; j++) {
          const d = head - j;
          if (d < 0 || d > trail) continue;
          const b = 1 - d / trail;
          ctx.fillStyle = d < 1 ? '#dfffe0' : css([30, 255, 90], b);
          if (cw >= 6) ctx.fillText(glyphs[Math.floor(hash(c, j, f >> 2) * glyphs.length)], c * cw, j * cw);
          else ctx.fillRect(c * cw, j * cw, cw, cw);
        }
      }
    },
  },
  eq: {
    name: '🎚️ Equalizer',
    draw(ctx, t, W, S) {
      ctx.fillStyle = '#05050a'; ctx.fillRect(0, 0, W, S);
      const bars = 40, bw = W / bars, seg = S / 16;
      for (let i = 0; i < bars; i++) {
        const k1 = 1 + (i % 3), k2 = 2 + (i % 2);
        const lvl = 0.12 + 0.88 * Math.abs(Math.sin(TAU * t * k1 + hash(i, 1) * TAU)) * (0.55 + 0.45 * Math.abs(Math.sin(TAU * t * k2 + i)));
        const n = Math.round(lvl * 16);
        for (let j = 0; j < n; j++) {
          const r = j / 16;
          ctx.fillStyle = r > 0.8 ? '#ff3b30' : r > 0.55 ? '#ffcc00' : '#30d158';
          ctx.fillRect(i * bw + bw * 0.12, S - (j + 1) * seg + seg * 0.15, bw * 0.76, seg * 0.7);
        }
      }
    },
  },
  fire: {
    name: '🔥 Fire',
    pixel(x, y, t, W, S) {
      const u = x / S, h = 1 - y / S, a = TAU * t;
      const flick = Math.sin(u * 7 + a * 3) * Math.sin(u * 3.1 - a * 2) * 0.25
        + Math.sin(u * 17 - a * 4 + h * 6) * 0.12 + Math.sin(h * 9 - a * 5 + u * 2) * 0.1;
      const heat = Math.max(0, Math.min(1, 1.15 - h * 1.35 + flick));
      if (heat < 0.2) return [0, 0, 0];
      if (heat < 0.5) return [(heat - 0.2) / 0.3 * 230 | 0, 20, 0];
      if (heat < 0.8) return [255, (heat - 0.5) / 0.3 * 170 | 0, 0];
      return [255, 170 + (heat - 0.8) / 0.2 * 85 | 0, (heat - 0.8) / 0.2 * 180 | 0];
    },
  },
};

// ---------- rendering ----------
let fxKey = null, fxFrames = null, fxCurrent = store.get('fx') || 'disco';

function renderFrames(fx, N, px) {
  const S = 128 / px, W = S * 5;
  const small = document.createElement('canvas'); small.width = W; small.height = S;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  const frames = [];
  for (let f = 0; f < N; f++) {
    const t = f / N;
    if (fx.pixel) {
      const img = sctx.createImageData(W, S), d = img.data;
      for (let y = 0, p = 0; y < S; y++) for (let x = 0; x < W; x++, p += 4) {
        const [r, g, b] = fx.pixel(x, y, t, W, S, f, N);
        d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
      }
      sctx.putImageData(img, 0, 0);
    } else { sctx.fillStyle = '#000'; sctx.fillRect(0, 0, W, S); }
    if (fx.draw) { sctx.save(); fx.draw(sctx, t, W, S, f, N); sctx.restore(); }
    const big = document.createElement('canvas'); big.width = 640; big.height = 128;
    const bctx = big.getContext('2d');
    bctx.imageSmoothingEnabled = false;
    bctx.drawImage(small, 0, 0, 640, 128);
    frames.push(big);
  }
  return frames;
}

function fxSettings() {
  return {
    N: Math.max(4, Math.min(40, Number($('fxFrames').value) || 24)),
    px: Number($('fxPixel').value),
    speed: Math.max(20, Number($('fxSpeed').value) || 80),
  };
}
function getFrames() {
  const { N, px } = fxSettings(), key = `${fxCurrent}|${N}|${px}`;
  if (key !== fxKey) { fxFrames = renderFrames(EFFECTS[fxCurrent], N, px); fxKey = key; }
  return fxFrames;
}

function startPreview() { playTiles(stripJobs(getFrames()), fxSettings().speed); }

// Pick an effect and its settings (used by scenes).
function setEffect({ fx, px, frames, speed }) {
  if (EFFECTS[fx]) { fxCurrent = fx; store.set('fx', fx); markFx(); }
  if (px) $('fxPixel').value = px;
  if (frames) $('fxFrames').value = frames;
  if (speed) $('fxSpeed').value = speed;
}

// ---------- upload ----------
async function sendEffect(screens = null) {
  if (!screens) { if (!needSel()) return; screens = sel(); }
  const frames = getFrames(), { speed, N, px } = fxSettings();
  $('fxSend').disabled = true;
  try {
    await sendScreens(stripJobs(frames, screens), speed,
      p => { $('fxProgress').textContent = `Uploading… ${Math.round(p * 100)}%`; });
    $('fxProgress').textContent = `${EFFECTS[fxCurrent].name} is playing on the device.`;
    log(`${EFFECTS[fxCurrent].name} sent to screen(s) ${screens.map(s => s + 1).join(', ')}.`, 'o');
    lastContent = { type: 'effect', fx: fxCurrent, px, frames: N, speed };
  } catch (e) {
    $('fxProgress').textContent = 'Upload failed — see log.';
  } finally {
    $('fxSend').disabled = false;
  }
}

// ---------- light show (ambient LEDs to a beat) ----------
// Runs in the server (engine.js), so it keeps going with this page closed.
let showOn = false;
function markShow(on) { showOn = on; $('showToggle').textContent = on ? 'Stop light show' : 'Start light show'; }
async function startShow() {
  const bpm = Math.max(30, Math.min(240, Number($('bpm').value) || 120));
  markShow(true);
  lastLights = { mode: 'show', bpm, showMode: $('showMode').value, color: $('lightColor').value };
  await engineCall('lightshow', { bpm, mode: $('showMode').value, color: $('lightColor').value }).catch(() => {});
}
async function stopShow() {
  if (!showOn) return;
  markShow(false);
  await engineCall('lightshow', { stop: true }).catch(() => {});
}
const toggleShow = () => showOn ? stopShow() : startShow();
onEngineState(s => markShow(!!s.lightShow));

// ---------- UI ----------
function buildFxUi() {
  for (const [id, fx] of Object.entries(EFFECTS)) {
    const b = document.createElement('button');
    b.textContent = fx.name; b.dataset.fx = id;
    b.onclick = () => { fxCurrent = id; store.set('fx', id); markFx(); startPreview(); };
    $('fxList').append(b);
  }
  markFx();
  for (const id of ['fxFrames', 'fxPixel', 'fxSpeed']) $(id).onchange = startPreview;
  $('fxPreview').onclick = startPreview;
  $('fxStop').onclick = stopTiles;
  $('fxSend').onclick = () => sendEffect();
  $('showToggle').onclick = toggleShow;
  $('bpm').onchange = () => { if (showOn) startShow(); };
  $('showMode').onchange = () => { if (showOn) startShow(); };
}
function markFx() {
  document.querySelectorAll('#fxList button').forEach(b => b.classList.toggle('on', b.dataset.fx === fxCurrent));
}
buildFxUi();
