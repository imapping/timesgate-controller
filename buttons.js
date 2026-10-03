// USB button boxes, arcade panels and game controllers (anything that shows up as a HID joystick or
// gamepad), read with node-hid, so they work with the page closed — on Windows and on a Pi.
// Inputs aren't hard-coded: each report is compared with the idle one, so any controller works.
// Press a button and it appears on the page, where you choose what it does (a short press, and
// optionally a different action when held). Settings in data/buttons.json.
// With several Times Gates, the box has a selected one: the "Switch Times Gate" action moves to the
// next (it flashes its edge light), and buttons not tied to a particular
// Times Gate act on the selected one.

const fs = require('fs');
const path = require('path');
let HID = null;
try { HID = require('node-hid'); } catch {}

const CONF_FILE = path.join(__dirname, 'data', 'buttons.json');
const HOLD_MS = 800;
// inputs: { id: { name, press, hold, unit } } — unit: a Times Gate id, 'all', or null (the selected one)
// selected: the Times Gate the box controls (null: the first). switchFlash: feedback on switching.
let conf = { device: null, inputs: {}, selected: null, switchFlash: true };
try { conf = { ...conf, ...JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')) }; } catch {}
const save = () => { fs.mkdirSync(path.dirname(CONF_FILE), { recursive: true }); fs.writeFileSync(CONF_FILE, JSON.stringify(conf, null, 2)); };
const log = (...a) => console.log(new Date().toLocaleTimeString(), '[buttons]', ...a);

let runAction = null;            // (id, args) => Promise — from plugin-host
let engine = null;               // for the list of Times Gates, and switching feedback
const SWITCH = 'buttons.switch';
const SWITCH_ACTION = { id: SWITCH, plugin: 'core', label: 'Switch Times Gate' };
let dev = null, devInfo = null, baseline = null, down = new Map(), last = null, error = null;

// ---------- finding the controller ----------
const isController = d => d.usagePage === 1 && (d.usage === 4 || d.usage === 5);  // joystick / gamepad
const devKey = d => `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`;

function connect() {
  if (dev || !HID) return;
  let list = [];
  try { list = HID.devices().filter(isController); } catch (e) { error = e.message; return; }
  const d = (conf.device && list.find(x => devKey(x) === conf.device)) || list[0];
  if (!d) { error = 'No button box or game controller plugged in'; devInfo = null; return; }
  try {
    dev = new HID.HID(d.path);
  } catch (e) { error = `Could not open ${d.product || devKey(d)}: ${e.message}`; return; }
  devInfo = { key: devKey(d), name: (d.product || 'Controller').trim().replace(/\s+/g, ' ') };
  error = null; baseline = null; down = new Map();
  log(`Connected to ${devInfo.name} (${devInfo.key}).`);
  dev.on('data', onReport);
  dev.on('error', e => {
    log('Disconnected:', e.message);
    try { dev.close(); } catch {}
    dev = null; devInfo = null; error = 'Disconnected — plug it back in';
  });
}

// ---------- turning reports into inputs ----------
// Bytes that idle near the middle (0x60–0xa0) are axes: far to one side = a direction.
// A byte whose low nibble idles at 0xF may be a hat switch (0–7 = directions).
// Everything else is buttons, one bit each.
function activeInputs(r) {
  const on = [];
  for (let i = 0; i < r.length; i++) {
    const b0 = baseline[i], v = r[i];
    if (b0 >= 0x60 && b0 <= 0xa0) {
      if (v < 0x30) on.push(`a${i}-`); else if (v > 0xd0) on.push(`a${i}+`);
      continue;
    }
    let mask = 0xff;
    if ((b0 & 0x0f) === 0x0f) {
      const hat = v & 0x0f;
      if (hat <= 7) on.push(`h${i}.${hat}`);
      mask = 0xf0;
    }
    const diff = (v ^ b0) & mask;
    for (let bit = 0; bit < 8; bit++) if (diff & (1 << bit)) on.push(`b${i}.${bit}`);
  }
  return on;
}

const HAT = ['up', 'up-right', 'right', 'down-right', 'down', 'down-left', 'left', 'up-left'];
function defaultName(id) {
  let m;
  if ((m = /^a(\d)([+-])$/.exec(id))) {
    const axis = Number(m[1]);
    if (axis === 0) return `Joystick ${m[2] === '-' ? 'left' : 'right'}`;
    if (axis === 1) return `Joystick ${m[2] === '-' ? 'up' : 'down'}`;
    return `Axis ${axis} ${m[2]}`;
  }
  if ((m = /^h(\d)\.(\d)$/.exec(id))) return `Joystick ${HAT[m[2]]}`;
  if ((m = /^b(\d)\.(\d)$/.exec(id))) return `Button ${m[1]}.${m[2]}`;
  return id;
}

function onReport(buf) {
  const r = [...buf];
  if (!baseline) { baseline = r; return; }  // first report = nothing pressed
  const now = Date.now(), on = new Set(activeInputs(r));
  for (const id of on) if (!down.has(id)) pressed(id, now);
  for (const [id, st] of down) if (!on.has(id)) released(id, st);
}

function pressed(id, now) {
  if (!conf.inputs[id]) { conf.inputs[id] = { name: defaultName(id), press: null, hold: null }; save(); }
  const b = conf.inputs[id], st = { at: now, held: false, timer: null };
  down.set(id, st);
  last = { id, at: now, kind: 'press' };
  if (!b.hold) return fire(id, b.press, 'press');          // no hold action: act straight away
  st.timer = setTimeout(() => { st.held = true; last = { id, at: Date.now(), kind: 'hold' }; fire(id, b.hold, 'hold'); }, HOLD_MS);
}
function released(id, st) {
  down.delete(id);
  clearTimeout(st.timer);
  const b = conf.inputs[id];
  if (b && b.hold && !st.held) fire(id, b.press, 'press');
}
// ---------- the selected Times Gate ----------
function selectedUnit() {
  const list = engine ? engine.units() : [];
  return list.find(u => u.id === conf.selected) || list[0] || null;
}
function switchUnit() {
  const list = engine ? engine.units() : [];
  if (!list.length) return;
  const cur = selectedUnit(), next = list[(list.findIndex(u => u.id === cur.id) + 1) % list.length];
  conf.selected = next.id; save();
  log(`Now controlling ${next.name}.`);
  const u = engine.unit(next.id);
  if (conf.switchFlash) u.edgeFlash(2500);
}

function fire(id, action, kind) {
  if (!action || !runAction) return;
  if (action === SWITCH) { log(`${conf.inputs[id].name} (${kind}) → switch Times Gate`); return switchUnit(); }
  const unit = conf.inputs[id].unit || selectedUnit()?.id || undefined;
  log(`${conf.inputs[id].name} (${kind}) → ${action}${unit ? ' on ' + unit : ''}`);
  Promise.resolve().then(() => runAction(action, { unit })).catch(e => log(`${action} failed:`, e.message));
}

// ---------- page API ----------
function status(withDevices = false) {
  const list = HID && withDevices ? (() => { try { return HID.devices().filter(isController).map(d => ({ key: devKey(d), name: (d.product || '').trim().replace(/\s+/g, ' ') })); } catch { return []; } })() : [];
  const uniq = [...new Map(list.map(d => [d.key, d])).values()];
  return { available: !!HID, connected: !!dev, device: devInfo, devices: uniq, error, inputs: conf.inputs,
    down: [...down.keys()], last, selected: selectedUnit()?.id || null, switchFlash: conf.switchFlash };
}
function setInput(id, o) {
  const b = conf.inputs[id];
  if (!b) throw Object.assign(new Error('Unknown input — press it on the box first'), { status: 404 });
  if (typeof o.name === 'string') b.name = o.name.trim().slice(0, 40) || defaultName(id);
  if ('press' in o) b.press = o.press || null;
  if ('hold' in o) b.hold = o.hold || null;
  if ('unit' in o) b.unit = o.unit || null;
  save();
}
// { selected, switchFlash } from the page.
function setOptions(o) {
  if ('selected' in o) conf.selected = o.selected || null;
  if (typeof o.switchFlash === 'boolean') conf.switchFlash = o.switchFlash;
  save();
}
function forget(id) { delete conf.inputs[id]; save(); }
function useDevice(key) {
  conf.device = key || null; save();
  if (dev) { try { dev.close(); } catch {} dev = null; }
  connect();
}

function init(run, eng) {
  runAction = run; engine = eng;
  if (!HID) { error = 'node-hid is not installed (npm install node-hid)'; return; }
  connect();
  setInterval(connect, 5000);  // plugged in later, or unplugged and back
}

module.exports = { init, status, setInput, setOptions, forget, useDevice, SWITCH_ACTION };
