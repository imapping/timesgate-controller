// 3D printer panel: what the printer is doing, the alert options, setting up the printer, and previews.
(() => {
  const p = TG.plugin('printer');
  const $p = sel => p.el(sel);
  let st = null;
  const saved = { host: null, serial: null };   // the settings last put in the boxes

  p.preview = async () => ({ speed: PR_SPEED, parts: prParts(await p.api('view')) });
  const call = async (path, body) => { try { apply(await p.api(path, body)); return true; } catch (e) { log('3D printer: ' + e.message, 'e'); $p('#prInfo').textContent = e.message; return false; } };
  const clock = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const left = m => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

  function apply(s) {
    const was = st && JSON.stringify([st.state, st.percent, st.layer, st.remainingMin, st.trays]);
    st = s;
    // Filled in only when the saved settings change, so what's being typed isn't wiped by the next update.
    for (const [id, k] of [['#prHost', 'host'], ['#prSerial', 'serial']]) if ((s[k] || '') !== saved[k]) { saved[k] = s[k] || ''; $p(id).value = saved[k]; }
    $p('#prCode').placeholder = s.hasCode ? 'Access code (saved)' : 'Access code';
    $p('#prRainbow').checked = s.rainbow; $p('#prAuto').checked = s.autoShow;
    const ok = s.state !== 'setup';
    p.controls(ok);
    if (!ok) $p('#prSetupBox').open = true;

    const job = s.job ? `: ${s.job}` : '';
    $p('#prNow').textContent = {
      setup: 'Not set up yet: enter the printer below.',
      offline: 'Not connected',
      idle: 'Idle' + (s.job ? ` (last: ${s.job})` : ''),
      preparing: `Getting ready${job}` + (s.stage ? ` · ${s.stage.toLowerCase()}` : ''),
      printing: `Printing${job} · ${s.percent ?? 0}%` + (s.remainingMin != null ? ` · ${left(s.remainingMin)} left, done about ${clock(s.finishAt)}` : ''),
      paused: `Paused${job} · ${s.percent ?? 0}%`,
      finished: `Finished${job}` + (s.finishedAt ? ` at ${clock(s.finishedAt)}` : ''),
      failed: `Failed${job}` + (s.errorCode ? ` (error ${s.errorCode})` : ''),
    }[s.state] || s.state;
    $p('#prInfo').textContent = s.error ? 'Problem: ' + s.error
      : [s.layers ? `layer ${s.layer} of ${s.layers}` : '', s.nozzle ? `nozzle ${Math.round(s.nozzle.cur)}°` : '', s.bed ? `bed ${Math.round(s.bed.cur)}°` : '',
        s.updatedAt ? 'heard ' + new Date(s.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : ''].filter(Boolean).join(' · ');
    const now = JSON.stringify([s.state, s.percent, s.layer, s.remainingMin, s.trays]);
    if (ok && now !== was) p.runPreview().catch(() => {});
  }
  p.onState(apply);

  $p('#prRefresh').onclick = () => call('refresh', {});
  $p('#prRainbow').onchange = e => call('options', { rainbow: e.target.checked });
  $p('#prAuto').onchange = e => call('options', { autoShow: e.target.checked });
  $p('#prTest').onclick = async () => { try { await fetch('/api/plugins/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'printer.test' }) }); } catch {} };
  $p('#prSave').onclick = async () => {
    $p('#prSave').disabled = true;
    const ok = await call('options', { host: $p('#prHost').value, serial: $p('#prSerial').value, code: $p('#prCode').value });
    $p('#prSave').disabled = false;
    if (ok) $p('#prCode').value = '';
  };
})();
