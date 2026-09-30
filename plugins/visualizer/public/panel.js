// Music visualizer panel: options, a live tempo/level readout, and previews.
(() => {
  const p = TG.plugin('visualizer');
  const $p = sel => p.el(sel);
  let bpm = null, listening = false;

  for (const [id, pal] of Object.entries(VIZ_PALETTES)) {
    const o = document.createElement('option'); o.value = id; o.textContent = pal.name + ' colours';
    $p('#vzPalette').append(o);
  }

  p.preview = async () => vizRender(bpm || 120, $p('#vzPalette').value);

  const set = o => p.api('options', o).catch(e => log('Visualizer: ' + e.message, 'e'));
  $p('#vzLights').onchange = e => set({ lights: e.target.checked });
  $p('#vzZone').onchange = e => set({ zone: e.target.value });
  $p('#vzPalette').onchange = e => { set({ palette: e.target.value }); p.runPreview(); };
  $p('#vzSens').onchange = e => set({ sensitivity: Number(e.target.value) });

  p.onState(s => {
    $p('#vzLights').checked = s.lights;
    $p('#vzZone').value = s.zone;
    $p('#vzPalette').value = s.palette;
    if (document.activeElement !== $p('#vzSens')) $p('#vzSens').value = s.sensitivity;
    listening = s.listening;
    if (!listening) $p('#vzNow').textContent = 'Not listening.';
  });

  // While listening: tempo and a level bar, twice a second.
  setInterval(async () => {
    if (!listening) return;
    try {
      const d = await p.api('now');
      bpm = d.bpm;
      const bar = '█'.repeat(Math.round(d.level * 12)).padEnd(12, '░');
      $p('#vzNow').textContent = d.error ? 'Microphone: ' + d.error : `${bar}  ${d.bpm ? '~' + d.bpm + ' BPM' : 'finding the beat…'}`;
    } catch {}
  }, 500);
})();
