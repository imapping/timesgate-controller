// Vinyl panel: start/stop, status, budget and options, recent records, previews.
(() => {
  const p = TG.plugin('vinyl');
  const $p = sel => p.el(sel);
  let st = null;
  const art = new Map();

  async function loadArt(url) {
    if (!url) return null;
    if (!art.has(url)) {
      const img = await new Promise((res, rej) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = rej;
        i.src = '/api/vinyl/art?u=' + encodeURIComponent(url);
      }).catch(() => null);
      if (!img) return null;
      art.set(url, vnArtColours(img));
    }
    return art.get(url);
  }

  p.preview = async () => st && renderVinyl(st.track, st.track ? await loadArt(st.track.art) : null, st.active ? st.status : 'Switched off');

  const call = async (path, body) => { try { apply(await p.api(path, body)); } catch (e) { log('Vinyl: ' + e.message, 'e'); $p('#vnStatus').textContent = e.message; } };

  function apply(s) {
    const firstTrack = !st || (s.track && (!st.track || st.track.title !== s.track.title));
    st = s;
    $p('#vnSetup').hidden = s.hasToken;
    $p('#vnTokenNote').textContent = s.hasToken ? 'To change the AudD token, open this page on the computer running the controller, or one it trusts.' : '';
    $p('#vnToggle').textContent = s.active ? 'Stop listening' : 'Start listening';
    $p('#vnToggle').disabled = !s.hasToken;
    $p('#vnNow').disabled = !s.hasToken || s.phase === 'identifying';
    const off = s.active && s.until ? ` (until ${new Date(s.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : '';
    $p('#vnStatus').textContent = s.status + off;
    $p('#vnUsage').textContent = `${s.used} of ${s.cap} requests used this month.`;
    if (document.activeElement !== $p('#vnCap')) $p('#vnCap').value = s.cap;
    $p('#vnAutoOff').value = s.autoOffMin;
    $p('#vnAutoShow').checked = s.autoShow;
    const h = $p('#vnHistory');
    h.innerHTML = s.history.length ? '<table class="wx"></table>' : '';
    for (const t of s.history) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td></td><td class="hint"></td>';
      tr.children[0].textContent = t.title;
      tr.children[1].textContent = t.artist + (t.album ? ' — ' + t.album : '');
      tr.children[2].textContent = new Date(t.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      h.firstChild.append(tr);
    }
    if (firstTrack && s.track) p.runPreview().catch(() => {});
  }
  p.onState(apply);

  $p('#vnToggle').onclick = () => call(st && st.active ? 'off' : 'on', {});
  // Poll faster while it's listening, so "Listening… / Identifying…" and the result show promptly.
  $p('#vnNow').onclick = async () => {
    await call('now', {});
    for (let i = 0; i < 20 && st && st.phase === 'identifying'; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try { apply(await (await fetch('/api/engine/state')).json().then(s => s.plugins.vinyl)); } catch {}
    }
  };
  $p('#vnSaveToken').onclick = () => { call('options', { token: $p('#vnToken').value }); $p('#vnToken').value = ''; };
  $p('#vnAutoOff').onchange = e => call('options', { autoOffMin: Number(e.target.value) });
  $p('#vnCap').onchange = e => call('options', { cap: Number(e.target.value) });
  $p('#vnAutoShow').onchange = e => call('options', { autoShow: e.target.checked });
})();
