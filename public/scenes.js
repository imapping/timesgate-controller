// Scenes: one-click presets that set brightness, ambient lights and what's on the screens.
// Built-in scenes plus your own ("Save current setup"), stored in this browser.
// Relies on globals from index.html (cmd, light, store, lastContent, lastLights) and the feature modules.

const BUILTIN_SCENES = [
  { name: '🎉 Party', brightness: 100,
    lights: { mode: 'show', bpm: 124, showMode: 'random' },
    content: { type: 'effect', fx: 'disco', px: 4, frames: 24, speed: 80 } },
  { name: '😌 Chill', brightness: 45,
    lights: { mode: 'solid', zone: 2, color: '#7a3cff' },
    content: { type: 'effect', fx: 'lava', px: 2, frames: 32, speed: 140 } },
  { name: '🎮 Gaming', brightness: 85,
    lights: { mode: 'rainbow', zone: 2, color: '#00e5ff' },
    content: { type: 'effect', fx: 'stars', px: 2, frames: 24, speed: 70 } },
  { name: '☀️ Weather', brightness: 70,
    lights: { mode: 'solid', zone: 2, color: '#3a8dde' },
    content: { type: 'plugin', id: 'weather' } },
  { name: '🌙 Night', brightness: 8,
    lights: { mode: 'off' },
    content: { type: 'plugin', id: 'weather' } },
];

const loadScenes = () => { try { return JSON.parse(store.get('scenes') || '[]'); } catch { return []; } };
const saveScenes = list => store.set('scenes', JSON.stringify(list));

async function applyLights(l) {
  if (!l) return;
  if (l.color) $('lightColor').value = l.color;
  if (l.mode === 'show') {
    if (l.bpm) $('bpm').value = l.bpm;
    if (l.showMode) $('showMode').value = l.showMode;
    return startShow();
  }
  await stopShow();
  if (l.zone) $('lightZone').value = l.zone;
  if (l.mode === 'off') return light(0, null, 0);
  return light(1, l.mode, l.mode === 'rainbow' ? 1 : 0);
}

async function applyContent(c) {
  if (!c) return;
  if (c.type === 'effect') { setEffect(c); startPreview(); return sendEffect([0, 1, 2, 3, 4]); }
  // Plugin content (scenes saved before plugins say { type: 'weather' }).
  if (c.type === 'plugin' || c.type === 'weather') return TG.plugin(c.id || c.type).show();
  if (c.type === 'banner') { setBannerOpts(c.opts); previewBanner(); return sendBanner(); }
  if (c.type === 'face') return cmd({ Command: 'Channel/Set5LcdWholeClockId', ClockId: c.id });
}

let sceneBusy = false;
async function applyScene(sc) {
  if (sceneBusy) return;
  sceneBusy = true;
  $('sceneStatus').textContent = `Setting up ${sc.name}…`;
  try {
    if (sc.brightness != null) {
      $('bright').value = sc.brightness; $('brightVal').textContent = sc.brightness;
      await cmd({ Command: 'Channel/OnOffScreen', OnOff: 1 }, true);
      await cmd({ Command: 'Channel/SetBrightness', Brightness: sc.brightness }, true);
    }
    await applyLights(sc.lights);
    await applyContent(sc.content);
    $('sceneStatus').textContent = `${sc.name} is on.`;
  } catch {
    $('sceneStatus').textContent = 'Something went wrong — see log.';
  } finally { sceneBusy = false; }
}

function saveCurrentScene() {
  const name = prompt('Name for this scene?', 'My scene');
  if (!name) return;
  const scene = { name, brightness: Number($('bright').value), lights: lastLights, content: lastContent };
  if (!scene.content) $('sceneStatus').textContent = 'Saved. (Pictures and GIF files can\'t be stored in a scene, so the screens are left as they are.)';
  else $('sceneStatus').textContent = `Saved "${name}".`;
  saveScenes([...loadScenes(), scene]);
  drawScenes();
}

function drawScenes() {
  const box = $('sceneList');
  box.innerHTML = '';
  const add = (sc, custom, idx) => {
    const wrap = document.createElement('span');
    wrap.className = 'scene';
    const b = document.createElement('button');
    b.textContent = sc.name;
    b.title = describeScene(sc);
    b.onclick = () => applyScene(sc);
    wrap.append(b);
    if (custom) {
      const x = document.createElement('button');
      x.className = 'x'; x.textContent = '×'; x.title = 'Delete this scene'; x.setAttribute('aria-label', `Delete ${sc.name}`);
      x.onclick = () => { if (confirm(`Delete "${sc.name}"?`)) { const l = loadScenes(); l.splice(idx, 1); saveScenes(l); drawScenes(); } };
      wrap.append(x);
    }
    box.append(wrap);
  };
  BUILTIN_SCENES.forEach(sc => add(sc, false));
  loadScenes().forEach((sc, i) => add(sc, true, i));
}
function describeScene(sc) {
  const c = sc.content;
  const what = !c ? 'screens unchanged' : c.type === 'effect' ? `effect: ${EFFECTS[c.fx]?.name || c.fx}`
    : c.type === 'banner' ? `banner: "${c.opts.text}"` : c.type === 'face' ? `clock face #${c.id}`
    : c.type === 'plugin' ? c.id : c.type;
  const l = sc.lights;
  const lights = !l ? 'lights unchanged' : l.mode === 'show' ? `light show ${l.bpm} BPM` : `lights ${l.mode}`;
  return `Brightness ${sc.brightness}% · ${lights} · ${what}`;
}

$('sceneSave').onclick = saveCurrentScene;
drawScenes();
