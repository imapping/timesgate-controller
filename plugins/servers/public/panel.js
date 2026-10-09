// Servers panel: each server's health, adding and removing servers, the limits, and previews.
(() => {
  const p = TG.plugin('servers');
  const $p = sel => p.el(sel);
  let st = null;

  p.preview = async () => ({ speed: SV_SPEED, parts: svParts(await p.api('view')) });
  const call = async (path, body) => { try { apply(await p.api(path, body)); return true; } catch (e) { log('Servers: ' + e.message, 'e'); $p('#svInfo').textContent = e.message; return false; } };
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const ago = s => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`; };
  const WORD = { ok: 'OK', warn: 'Warning', crit: 'Problem' };

  function apply(s) {
    const first = !st;
    st = s;
    const L = s.limits;
    for (const [id, k] of [['#svLimCpu', 'cpu'], ['#svLimMem', 'memory'], ['#svLimDisk', 'disk'], ['#svLimDiskCrit', 'diskCritical']])
      if (document.activeElement !== $p(id)) $p(id).value = L[k];
    $p('#svRainbow').checked = s.rainbow;
    p.controls(s.servers.length > 0);
    if (!s.servers.length) $p('#svAddBox').open = true;
    const last = Math.max(0, ...s.servers.map(x => x.checkedAt || 0));
    $p('#svInfo').textContent = !s.servers.length ? 'No servers yet: add one below.'
      : `${s.servers.filter(x => !x.down).length} of ${s.servers.length} up` + (last ? ` · checked ${new Date(last).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '');

    const box = $p('#svList');
    box.innerHTML = '';
    if (s.servers.length) {
      const t = el('table'); t.className = 'wx';
      const head = el('tr');
      for (const h of ['Server', 'Status', 'CPU', 'Memory', 'Fullest disk', 'Databases', 'Up', '']) head.append(el('td', h, 'hint'));
      t.append(head);
      for (const x of s.servers) {
        const tr = el('tr'), name = el('td'), dot = el('span', null, 'sv-dot');
        dot.style.background = SV[x.level] || SV.none;
        name.append(dot, x.name);
        name.title = [x.host, x.os, x.url].filter(Boolean).join(' · ');
        const status = el('td', x.down ? 'Down: ' + x.error : x.level ? WORD[x.level] + (x.problems.length ? ': ' + x.problems.map(q => q.text).join(', ') : '') : 'Checking…');
        status.style.color = x.level === 'ok' || !x.level ? '' : SV[x.level];
        const rm = el('button', 'Remove', 'note-btn');
        rm.onclick = () => { if (confirm(`Stop checking ${x.name}?`)) call('options', { remove: x.id }); };
        const last = el('td'); last.style.cssText = 'width:1%;padding-right:0'; last.append(rm);
        tr.append(name, status,
          el('td', x.cpu == null ? '–' : x.cpu + '%'), el('td', x.memory == null ? '–' : x.memory + '%'),
          el('td', x.disk ? `${x.disk.name} ${x.disk.percent}% (${x.disk.freeGb} GB free)` : '–'),
          el('td', x.databases.length ? x.databases.map(d => `${d.name} ${d.ok ? d.ms + ' ms' : 'failed'}`).join(', ') : '–'),
          el('td', x.uptime == null ? '–' : ago(x.uptime) + (x.restartPending ? ' · restart pending' : '')), last);
        t.append(tr);
      }
      box.append(t);
    }
    if (first && s.servers.length) p.runPreview().catch(() => {});
  }
  p.onState(apply);

  $p('#svCheck').onclick = () => call('check', {});
  $p('#svAdd').onclick = async () => {
    $p('#svAdd').disabled = true;
    const ok = await call('options', { add: { name: $p('#svName').value, url: $p('#svUrl').value, key: $p('#svKey').value, insecure: $p('#svInsecure').checked } });
    $p('#svAdd').disabled = false;
    if (ok) { for (const id of ['#svName', '#svUrl', '#svKey']) $p(id).value = ''; $p('#svInsecure').checked = false; }
  };
  const limits = () => call('options', { limits: { cpu: Number($p('#svLimCpu').value), memory: Number($p('#svLimMem').value), disk: Number($p('#svLimDisk').value), diskCritical: Number($p('#svLimDiskCrit').value) } });
  for (const id of ['#svLimCpu', '#svLimMem', '#svLimDisk', '#svLimDiskCrit']) $p(id).onchange = limits;
  $p('#svRainbow').onchange = e => call('options', { rainbow: e.target.checked });
})();
