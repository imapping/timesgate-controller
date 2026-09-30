// Draws the screens. Runs in the page (previews) and in server.js (the device), so it only uses
// makeCanvas(w, h), which both provide. Names are prefixed (hello…) because page scripts share one
// global scope with the other plugins.

const HELLO_SPEED = 1000;  // ms per frame (only one frame here)

// Returns { speed, parts } — see PLUGINS.md.
function helloRender(message, hue) {
  const words = String(message || 'Hello').split(/\s+/).filter(Boolean).slice(0, 5);
  const parts = [];
  for (let i = 0; i < 5; i++) {
    const c = makeCanvas(128, 128), g = c.getContext('2d');
    g.fillStyle = `hsl(${(hue + i * 30) % 360}, 70%, 18%)`;
    g.fillRect(0, 0, 128, 128);
    const word = words[i] || '';
    let size = 40;
    g.font = `800 ${size}px system-ui, "Segoe UI", sans-serif`;
    while (size > 12 && g.measureText(word).width > 116) g.font = `800 ${--size}px system-ui, "Segoe UI", sans-serif`;
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(word, 64, 66);
    // key: changes only when this screen's picture changes, so unchanged screens aren't re-sent
    parts.push({ key: `${word}|${hue}`, jobs: [{ screen: i, frames: [c] }] });
  }
  return { speed: HELLO_SPEED, parts };
}

if (typeof module === 'object') module.exports = { helloRender };
