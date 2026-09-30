// Draws the countdown timer's "time's up" flash for screen 2. Shared by the page and the server
// (engine.js). Needs a global makeCanvas(w, h).

const TM_FONT = (size, weight = 800) => `${weight} ${size}px system-ui, "Segoe UI", sans-serif`;
const TM_SPEED = 500;

// Word-wrap text into at most 3 lines, using the largest font size that fits the 128px screen.
function tmLayout(c, text) {
  for (let size = 40; size >= 12; size -= 2) {
    c.font = TM_FONT(size);
    const lines = [];
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const line = lines.length ? lines[lines.length - 1] + ' ' + word : word;
      if (lines.length && c.measureText(line).width <= 116) lines[lines.length - 1] = line;
      else lines.push(word);
    }
    if (lines.length <= 3 && lines.every(l => c.measureText(l).width <= 116) && lines.length * size * 1.1 <= 96) return { size, lines };
  }
  c.font = TM_FONT(12);
  return { size: 12, lines: [text.slice(0, 40)] };
}

// One 128×128 frame: heading + the label, in the given colours.
function tmFrame(text, heading, bg, fg, headFg) {
  const c = makeCanvas(128, 128), g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 128, 128);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = TM_FONT(12, 700); g.fillStyle = headFg;
  g.fillText(heading, 64, 14);
  const { size, lines } = tmLayout(g, text);
  g.font = TM_FONT(size); g.fillStyle = fg;
  const lh = size * 1.1, top = 74 - (lines.length - 1) * lh / 2;
  lines.forEach((l, i) => g.fillText(l, 64, top + i * lh));
  return c;
}

// The flashing red "TIME'S UP" loop.
const timerDoneFrames = text => [
  tmFrame(text, "TIME'S UP", '#e5202a', '#ffffff', '#ffffff'),
  tmFrame(text, "TIME'S UP", '#101014', '#ff3b3b', '#ff3b3b'),
];

function blankFrame() {
  const c = makeCanvas(128, 128), g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 128, 128);
  return c;
}

if (typeof module === 'object') module.exports = { TM_SPEED, timerDoneFrames, blankFrame };
