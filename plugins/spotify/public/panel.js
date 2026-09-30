// Spotify panel: setup, what's playing, previews. The screens are drawn by render.js (also used by
// server.js to keep the device updated).
(() => {
  const p = TG.plugin('spotify');
  const $p = sel => p.el(sel);
  let data = null, connected = false;
  const art = new Map();  // art URL -> spArtColours(image)

  // Album art, loaded through the server so the canvas can read its colours.
  async function loadArt(url) {
    if (!url) return null;
    if (!art.has(url)) {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i); i.onerror = rej;
        i.src = '/api/spotify/art?u=' + encodeURIComponent(url);
      }).catch(() => null);
      if (!img) return null;
      art.set(url, spArtColours(img));
    }
    return art.get(url);
  }

  p.preview = async () => {
    if (!data) await poll();
    if (!data) return null;
    return { speed: 1000, parts: renderSpotify(data, data.item ? await loadArt(data.item.art) : null) };
  };

  async function poll() {
    if (!connected) return;
    try {
      const d = await p.api('now');
      if (d.connected === false) return showSetup();
      data = d;
      const it = d.item;
      $p('#spNow').innerHTML = it
        ? `<b style="color:var(--ink)"></b> — <span></span> <span class="hint">(${d.playing ? 'playing' : 'paused'})</span>`
        : 'Nothing playing on Spotify right now.';
      if (it) { $p('#spNow b').textContent = it.name; $p('#spNow span').textContent = it.artist; }
    } catch (e) {
      $p('#spNow').textContent = 'Spotify: ' + e.message;
    }
  }

  function showSetup() {
    connected = false;
    $p('#spSetup').hidden = false; $p('#spMain').hidden = true; $p('#spMore').hidden = true;
    p.controls(false);
  }

  async function init() {
    const s = await p.api('status');
    $p('#spRedirect').textContent = s.redirect;
    $p('#spClientId').value = s.clientId;
    const msg = new URLSearchParams(location.search).get('spotify');
    if (msg) {
      log(msg === 'connected' ? 'Spotify connected.' : 'Spotify: ' + msg, msg === 'connected' ? 'o' : 'e');
      history.replaceState(null, '', location.pathname + location.hash);
    }
    if (!s.connected) return showSetup();
    connected = true;
    $p('#spSetup').hidden = true; $p('#spMain').hidden = false; $p('#spMore').hidden = false;
    p.controls(true);
    await poll();
  }

  $p('#spConnect').onclick = async () => {
    try {
      await p.api('config', { clientId: $p('#spClientId').value.trim() });
      location.href = '/api/spotify/login';
    } catch (e) { log('Spotify: ' + e.message, 'e'); }
  };
  $p('#spLogout').onclick = async () => {
    await p.api('logout', {}).catch(e => log('Spotify: ' + e.message, 'e'));
    data = null;
    showSetup();
    log('Spotify disconnected.');
  };

  init().catch(e => log('Spotify: ' + e.message, 'e'));
  setInterval(poll, 5000);
})();
