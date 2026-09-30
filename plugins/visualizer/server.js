// Music visualizer from the microphone: the lights flash on each beat, and the screens play an EQ
// animation in time with the tempo. The mic only runs while the lights or screens are following it.
const { vizRender, vizPalette, vizHex } = require('./public/render.js');

module.exports = tg => {
  const s = tg.settings;
  s.lights ??= false; s.zone ??= 'back'; s.palette ??= 'rainbow'; s.sensitivity ??= 0.5;
  let stopMic = null, bpm = null, level = 0, busy = false, beatN = 0;
  let shownBpm = null, lastScreenSend = 0;

  // Mic on while anything follows it.
  function sync() {
    const need = s.lights || tg.isLive();
    if (need && !stopMic) stopMic = tg.mic.listen(onFrame, { sensitivity: s.sensitivity });
    if (!need && stopMic) { stopMic(); stopMic = null; bpm = null; level = 0; }
  }
  const restartMic = () => { if (stopMic) { stopMic(); stopMic = null; } sync(); };

  function onFrame(f) {
    level = f.level;
    if (f.bpm) bpm = f.bpm;
    if (f.beat && s.lights) flash();
    // Screens: re-send the loop when the tempo has clearly changed (not more than every 20 s — it takes a few seconds to upload).
    if (tg.isLive() && bpm && Math.abs(bpm - (shownBpm || 0)) >= 4 && Date.now() - lastScreenSend > 20000) {
      lastScreenSend = Date.now();
      tg.update();
    }
  }

  const light = (zone, color, brightness) => zone === 'edge'
    ? { Command: 'Channel/SetRGBInfo', SelectLightIndex: 1, Brightness: brightness, OnOff: 1, Color: color, ColorCycle: 0,
        LightList: [{ SelectEffect: 0 }, { SelectEffect: 4, Color: color, ColorCycle: 0 }, { SelectEffect: 0 }] }
    : { Command: 'Channel/SetRGBInfo', SelectLightIndex: 2, Brightness: brightness, OnOff: 1, Color: color, ColorCycle: 0,
        LightList: [{ SelectEffect: 0 }, { SelectEffect: 3 }, { SelectEffect: 5, Color: color, ColorCycle: 0 }] };

  // One colour change per beat. If the device is still busy with the last one, skip this beat.
  async function flash() {
    if (busy) return;
    busy = true;
    const color = vizHex(vizPalette(s.palette).hsl(beatN++));
    const brightness = Math.round(40 + 60 * Math.min(1, level * 1.3));
    try {
      if (s.zone !== 'edge') await tg.device.send(light('back', color, brightness));
      if (s.zone !== 'back') await tg.device.send(light('edge', color, brightness));
    } catch {}
    busy = false;
  }

  function setLights(on) {
    s.lights = !!on; tg.save();
    if (on) tg.device.stopLightShow();
    sync();
  }

  sync();

  return {
    render: () => { shownBpm = bpm || 120; return vizRender(shownBpm, s.palette); },
    live: () => sync(),
    // The page set a light or started the light show: it wants the lights back.
    pageCommand: p => {
      if (s.lights && (p.Command === 'Channel/SetRGBInfo' || p.Command === 'Engine/LightShow')) { tg.log('Lights taken over by the page — stopping.'); setLights(false); }
    },
    state: () => ({ lights: s.lights, zone: s.zone, palette: s.palette, sensitivity: s.sensitivity, listening: !!stopMic, bpm }),
    routes: {
      'GET /now': () => { const m = tg.mic.status(); return { listening: !!stopMic, bpm, level, error: m.error }; },
      'POST /options': ({ body }) => {
        if (['back', 'edge', 'both'].includes(body.zone)) s.zone = body.zone;
        if (body.palette && vizPalette(body.palette)) { s.palette = body.palette; if (tg.isLive()) { shownBpm = null; tg.update(); } }
        if (typeof body.sensitivity === 'number') { s.sensitivity = Math.max(0, Math.min(1, body.sensitivity)); restartMic(); }
        tg.save();
        if (typeof body.lights === 'boolean') setLights(body.lights);
        return { ok: true };
      },
    },
    actions: {
      lights: { label: 'lights to the beat on/off', run: ({ on } = {}) => setLights(on ?? !s.lights) },
    },
    stop: () => { stopMic = null; },
  };
};
