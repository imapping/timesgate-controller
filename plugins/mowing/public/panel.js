// Mowing panel: the API key, each area's status, and previews.
(() => {
  const p = TG.plugin('mowing');
  const $p = sel => p.el(sel);
  let st = null, photo = { url: null, img: null };

  // The property photo, through the controller (which adds the key).
  async function loadPhoto(url) {
    if (!url) return null;
    if (photo.url !== url) {
      photo = { url, img: await new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = '/api/mowing/image?u=' + encodeURIComponent(url); }) };
    }
    return photo.img;
  }
  p.preview = async () => {
    const d = await p.api('view');
    return { speed: MW_SPEED, parts: mwParts(d, await loadPhoto(d.image?.url)) };
  };

  const call = async (path, body) => { try { apply(await p.api(path, body)); } catch (e) { log('Mowing: ' + e.message, 'e'); showError(e.message); } };
  const showError = msg => { $p('#mwError').textContent = msg || ''; $p('#mwError').style.display = msg ? '' : 'none'; };

  function apply(s) {
    const first = !st || st.checkedAt !== s.checkedAt;
    st = s;
    $p('#mwSetup').hidden = s.hasKey;
    $p('#mwKeyRow').style.display = s.hasKey ? '' : 'none';
    p.controls(s.hasKey && !!s.summary);
    const when = s.checkedAt ? new Date(s.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    const sum = s.summary;
    $p('#mwInfo').textContent = [s.property, sum && `${sum.areas} areas: ${sum.overdue} overdue, ${sum.dueSoon} due soon, ${sum.ok} up to date${sum.neverMowed ? `, ${sum.neverMowed} never mowed` : ''}`,
      when && 'checked ' + when].filter(Boolean).join(' · ');
    showError(s.error);
    const box = $p('#mwAreas');
    box.innerHTML = s.areas.length ? '<table class="wx"></table>' : '';
    for (const a of s.areas) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td></td><td class="hint"></td>';
      const dot = document.createElement('span');
      dot.className = 'mw-dot'; dot.style.background = MW.status[a.status] || MW.status.never;
      tr.children[0].append(dot, a.name);
      tr.children[1].textContent = a.statusText;
      tr.children[2].textContent = (a.lastMowed ? 'last mowed ' + new Date(a.lastMowed + 'T12:00:00').toLocaleDateString([], { day: 'numeric', month: 'short' }) : 'never mowed')
        + (a.intervalDays ? ` · every ${a.intervalDays} days` : '');
      box.firstChild.append(tr);
    }
    if (first && s.summary) p.runPreview().catch(() => {});
  }
  p.onState(apply);

  $p('#mwSaveKey').onclick = async () => {
    $p('#mwSaveKey').disabled = true; showError('');
    await call('options', { key: $p('#mwKey').value });
    $p('#mwKey').value = ''; $p('#mwSaveKey').disabled = false;
  };
  $p('#mwCheck').onclick = () => call('check', {});
  $p('#mwForget').onclick = () => { if (confirm('Remove the Mowing Tracker API key from this controller?')) call('options', { key: '' }); };
})();
