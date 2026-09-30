// Plugins on the page: TG, the API a plugin's panel script uses (see PLUGINS.md), the loader that
// adds each enabled plugin's panel, and the Plugins section (install / turn on-off / remove).
// Relies on globals from index.html ($, log, engineCall, onEngineState, lastContent) and anim.js (playTiles).

const TG = (() => {
  const reg = {};
  let engineState = null;

  function plugin(id) {
    if (reg[id]) return reg[id];
    const listeners = [];
    const section = () => document.getElementById('plugin-' + id);
    const q = sel => section()?.querySelector(sel);
    const p = reg[id] = {
      id,
      // An element inside this plugin's panel (CSS selector).
      el: q,
      // Call this plugin's server routes: GET without a body, POST with one. Resolves to the JSON reply.
      async api(path, body) {
        const r = await fetch(`/api/${id}/${String(path).replace(/^\/+/, '')}`, body === undefined ? {} :
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = r.status === 204 ? {} : await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `Server error ${r.status}`);
        return d;
      },
      // fn(state) runs now (if known) and whenever the plugin's server state() changes.
      onState(fn) {
        listeners.push(fn);
        if (engineState?.plugins?.[id]) try { fn(engineState.plugins[id], engineState); } catch {}
      },
      // Set by the panel script: async () => ({ speed, parts }) for the on-page tiles.
      preview: null,
      async runPreview() {
        if (!p.preview) return;
        const r = await p.preview();
        if (r) playTiles(r.parts.flatMap(x => x.jobs), r.speed);
      },
      async show() {
        p.runPreview().catch(() => {});
        try {
          await engineCall('send', { what: id });
          lastContent = { type: 'plugin', id };
          if (!p.isLive()) p.info(`Sent ${new Date().toLocaleTimeString()}.`);
        } catch (e) { p.info('Could not update the device — see log.'); throw e; }
      },
      isLive: () => engineState?.feed === id,
      async setLive(on) {
        if (!on && !p.isLive()) return;
        await engineCall('options', { feed: on ? id : null });
        if (on) p.runPreview().catch(() => {});
        p.info(on ? 'Showing on the Times Gate, and kept updated even with this page closed.' : '');
      },
      // The status text next to the Show buttons.
      info(text) { const s = q('.pl-info'); if (s) s.textContent = text; },
      // Show or hide the Preview / Show / Keep updated buttons (e.g. until the plugin is set up).
      controls(visible) { const c = q('.pl-controls'); if (c) c.hidden = !visible; },
      _state(s) {
        const cb = q('.pl-live'); if (cb) cb.checked = s.feed === id;
        if (s.plugins?.[id]) listeners.forEach(fn => { try { fn(s.plugins[id], s); } catch (e) { console.error(e); } });
      },
    };
    return p;
  }
  onEngineState(s => { engineState = s; Object.values(reg).forEach(p => p._state(s)); });
  return { plugin, get state() { return engineState; } };
})();

// ---------- loading panels ----------
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
    document.body.append(s);
  });
}

function buildSection(pl, html) {
  const sec = document.createElement('section');
  sec.className = 'wide'; sec.id = 'plugin-' + pl.id;
  sec.innerHTML = '<h2></h2>' + html;
  sec.querySelector('h2').textContent = pl.name;
  if (pl.feed) {
    const row = document.createElement('div');
    row.className = 'row pl-controls'; row.style.marginTop = '10px';
    row.innerHTML = '<button class="pl-preview">Preview on tiles</button><button class="pl-show primary">Show on Times Gate</button>' +
      '<label><input type="checkbox" class="pl-live"> <span></span></label><span class="hint pl-info" style="margin:0"></span>';
    row.querySelector('label span').textContent = pl.liveLabel || 'Keep it updated';
    row.querySelector('label').title = 'Keeps this on the screens and up to date, even with this page closed';
    const slot = sec.querySelector('[data-tg-controls]');
    slot ? slot.replaceWith(row) : sec.append(row);
    const p = TG.plugin(pl.id);
    row.querySelector('.pl-preview').onclick = () => p.runPreview().catch(e => log(`${pl.name}: ${e.message}`, 'e'));
    row.querySelector('.pl-show').onclick = async e => {
      e.target.disabled = true;
      await p.show().catch(() => {});
      e.target.disabled = false;
    };
    row.querySelector('.pl-live').onchange = e => p.setLive(e.target.checked).catch(() => {});
  }
  $('pluginPanels').append(sec);
}

async function loadPlugins() {
  let d;
  try { d = await (await fetch('/api/plugins')).json(); } catch { return; }
  drawPluginList(d);
  for (const pl of d.plugins.filter(p => p.enabled && !p.error)) {
    try {
      const html = pl.panel ? await (await fetch(`/plugins/${pl.id}/${pl.panel}`)).text() : '';
      if (pl.panel || pl.feed) buildSection(pl, html);
      TG.plugin(pl.id);
      for (const s of pl.scripts) await loadScript(`/plugins/${pl.id}/${s}`);
    } catch (e) { log(`Plugin ${pl.name}: ${e.message}`, 'e'); }
  }
  if (TG.state) applyEngineState(TG.state);
  // (again, now the panels above it have loaded, e.g. coming back from the docs to #plugins)
  const target = /^#[\w-]+$/.test(location.hash) && document.querySelector(location.hash);
  if (target) scrollTo(0, target.getBoundingClientRect().top + scrollY - document.querySelector('header').offsetHeight - 12);
}

// ---------- the Plugins section ----------
async function pluginCall(path, body, zip) {
  const headers = { 'Content-Type': zip ? 'application/zip' : 'application/json' };
  if ($('plPin').value) headers['X-TG-PIN'] = $('plPin').value;
  const r = await fetch('/api/plugins/' + path, { method: 'POST', headers, body: zip || JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Server error ${r.status}`);
  return d;
}

function drawPluginList(d) {
  $('plPin').hidden = d.local || !d.pinSet;
  $('plPinSet').hidden = !d.local;
  $('plClearPin').disabled = !d.pinSet;
  const box = $('plList');
  box.innerHTML = '';
  if (!d.plugins.length) box.innerHTML = '<div class="hint" style="padding:10px">No plugins installed.</div>';
  for (const pl of d.plugins) {
    const row = document.createElement('div');
    row.className = 'plug';
    row.innerHTML = '<div class="grow"><b></b> <span class="hint"></span> <a class="hint" hidden>Read me</a><small></small></div>' +
      '<label><input type="checkbox"> On</label><button class="danger">Remove</button>';
    row.querySelector('b').textContent = pl.name;
    row.querySelector('.hint').textContent = pl.version ? 'v' + pl.version : '';
    const readme = row.querySelector('a');
    if (pl.readme) { readme.hidden = false; readme.href = '/docs.html?plugin=' + encodeURIComponent(pl.id); }
    const small = row.querySelector('small');
    small.textContent = pl.description;
    if (pl.error) { small.textContent = 'Failed to load: ' + pl.error; small.className = 'err'; }
    const cb = row.querySelector('input');
    cb.checked = pl.enabled;
    cb.onchange = async () => {
      try { await pluginCall('enable', { id: pl.id, on: cb.checked }); location.reload(); }
      catch (e) { log('Plugins: ' + e.message, 'e'); cb.checked = !cb.checked; }
    };
    row.querySelector('button').onclick = async () => {
      if (!confirm(`Remove the ${pl.name} plugin? Its files are deleted (its saved settings are kept).`)) return;
      try { await pluginCall('remove', { id: pl.id }); location.reload(); }
      catch (e) { log('Plugins: ' + e.message, 'e'); $('plInfo').textContent = e.message; }
    };
    box.append(row);
  }
}

$('plInstall').onclick = async () => {
  const file = $('plZip').files[0], url = $('plUrl').value.trim();
  if (!file && !url) return ($('plInfo').textContent = 'Choose a .zip file or paste a link first.');
  $('plInstall').disabled = true; $('plInfo').textContent = 'Installing…';
  try {
    const pl = file ? await pluginCall('install', null, file) : await pluginCall('install', { url });
    log(`Plugin ${pl.name} ${pl.version} installed.`, 'o');
    location.hash = 'plugin-' + pl.id;
    location.reload();
  } catch (e) {
    $('plInfo').textContent = e.message; log('Plugins: ' + e.message, 'e');
  } finally { $('plInstall').disabled = false; }
};
$('plSavePin').onclick = async () => {
  try { drawPluginList(await pluginCall('pin', { pin: $('plNewPin').value.trim() })); $('plNewPin').value = ''; $('plInfo').textContent = 'PIN saved.'; }
  catch (e) { $('plInfo').textContent = e.message; }
};
$('plClearPin').onclick = async () => {
  try { drawPluginList(await pluginCall('pin', { pin: null })); $('plInfo').textContent = 'PIN removed: installing now only works on the PC.'; }
  catch (e) { $('plInfo').textContent = e.message; }
};

loadPlugins();
