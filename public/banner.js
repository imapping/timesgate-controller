// Text banner across all five screens: either a looping marquee that scrolls across the whole
// gate, or one word/letter per screen. Rendered as 640x128 strips and uploaded with sendScreens.
// Relies on globals from index.html, anim.js and effects.js (hsv, css).

const BANNER_SPEEDS = { slow: [120, 1 / 16], medium: [80, 1 / 12], fast: [60, 1 / 8] };  // [ms per frame, step as fraction of a screen]

function bannerOpts() {
  return {
    text: $('bnText').value || ' ',
    mode: $('bnMode').value,
    color: $('bnColor').value,
    rainbow: $('bnRainbow').checked,
    bg: $('bnBg').value,
    px: Number($('bnPixel').value),
    pace: $('bnSpeed').value,
  };
}
function setBannerOpts(o) {
  const map = { text: 'bnText', mode: 'bnMode', color: 'bnColor', bg: 'bnBg', px: 'bnPixel', pace: 'bnSpeed' };
  for (const [k, id] of Object.entries(map)) if (o[k] !== undefined) $(id).value = o[k];
  if (!$('bnMode').value) $('bnMode').value = 'scroll';  // scene saved with a mode that no longer exists
  if (o.rainbow !== undefined) $('bnRainbow').checked = o.rainbow;
}

const bannerFont = size => `800 ${size}px system-ui, "Segoe UI", sans-serif`;

// Draw text char by char so each glyph can have its own rainbow colour.
function drawChars(c, str, x, y, o, t) {
  if (!o.rainbow) { c.fillStyle = o.color; c.fillText(str, x, y); return; }
  let cx = x;
  [...str].forEach((ch, i) => {
    c.fillStyle = css(hsv(i * 0.07 - t, 1, 1));
    c.fillText(ch, cx, y);
    cx += c.measureText(ch).width;
  });
}

function renderBanner(o) {
  const S = 128 / o.px, W = S * 5;
  const small = document.createElement('canvas'); small.width = W; small.height = S;
  const c = small.getContext('2d');
  c.textBaseline = 'middle';
  const frames = [];
  const emit = () => {
    const big = document.createElement('canvas'); big.width = 640; big.height = 128;
    const b = big.getContext('2d'); b.imageSmoothingEnabled = false; b.drawImage(small, 0, 0, 640, 128);
    frames.push(big);
  };
  const clear = () => { c.fillStyle = o.bg; c.fillRect(0, 0, W, S); };

  if (o.mode === 'scroll') {
    c.font = bannerFont(Math.round(S * 0.72));
    const tw = c.measureText(o.text).width, gap = S * 1.5, period = tw + gap;
    const [speed, stepFrac] = BANNER_SPEEDS[o.pace];
    // The loop must be at most 40 frames; long text scrolls in bigger steps.
    const N = Math.min(40, Math.max(2, Math.round(period / (S * stepFrac))));
    for (let f = 0; f < N; f++) {
      clear();
      c.font = bannerFont(Math.round(S * 0.72));
      const off = (f / N) * period;
      // Copies of the text repeat every `period` px; draw every copy that overlaps the strip.
      const x0 = (((W - off) % period) + period) % period - period;
      for (let x = x0; x < W; x += period) drawChars(c, o.text, x, S * 0.54, o, f / N);
      emit();
    }
    return { frames, speed, info: `${N} frames, ${Math.round(period / N * o.px)} px per step` };
  }

  // One per screen: a single short word is split into letters, otherwise words (extras join the last screen).
  const words = o.text.trim().split(/\s+/);
  let parts = words.length === 1 && [...words[0]].length <= 5 ? [...words[0]] : words.slice(0, 5);
  if (words.length > 5) parts[4] = words.slice(4).join(' ');
  const first = Math.floor((5 - parts.length) / 2);  // centre on the gate
  const N = 12;
  for (let f = 0; f < N; f++) {
    clear();
    const t = f / N, pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
    parts.forEach((p, i) => {
      let size = S * 0.8;
      c.font = bannerFont(size);
      const w = c.measureText(p).width;
      if (w > S * 0.9) { size *= S * 0.9 / w; c.font = bannerFont(size); }
      const x = (first + i) * S + (S - c.measureText(p).width) / 2;
      c.save();
      c.fillStyle = o.rainbow ? css(hsv(i * 0.2 - t, 1, 1)) : o.color;
      c.shadowColor = c.fillStyle; c.shadowBlur = (S / 10) * pulse;
      c.fillText(p, x, S * 0.54);
      c.restore();
    });
    emit();
  }
  return { frames, speed: 100, info: `${parts.length} screen${parts.length > 1 ? 's' : ''}` };
}

let bannerCache = null, bannerKey = '';
function getBanner() {
  const o = bannerOpts(), key = JSON.stringify(o);
  if (key !== bannerKey) { bannerCache = renderBanner(o); bannerKey = key; }
  $('bnInfo').textContent = bannerCache.info;
  return bannerCache;
}
function previewBanner() { const b = getBanner(); playTiles(stripJobs(b.frames), b.speed); }

async function sendBanner() {
  const b = getBanner();
  $('bnSend').disabled = true;
  try {
    await sendScreens(stripJobs(b.frames), b.speed, p => { $('bnInfo').textContent = `Uploading… ${Math.round(p * 100)}%`; });
    $('bnInfo').textContent = 'Banner is showing on the Times Gate.';
    log('Banner sent.', 'o');
    lastContent = { type: 'banner', opts: bannerOpts() };
  } catch {
    $('bnInfo').textContent = 'Upload failed — see log.';
  } finally { $('bnSend').disabled = false; }
}

$('bnPreview').onclick = previewBanner;
$('bnSend').onclick = sendBanner;
for (const id of ['bnMode', 'bnColor', 'bnRainbow', 'bnBg', 'bnPixel', 'bnSpeed']) $(id).addEventListener('change', previewBanner);
