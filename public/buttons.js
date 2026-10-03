// The Buttons card: inputs from a USB button box (buttons.js in the server) and what each one does.
// Relies on globals from index.html ($, log).

let btKnown = '';   // what the rows were built from, so they're only rebuilt when that changes

async function btCall(body) {
  const r = await fetch('/api/buttons' + (body ? '' : '?full'), body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Server error');
  return d;
}

function btOptions(actions, selected) {
  const sel = document.createElement('select');
  sel.innerHTML = '<option value="">— nothing —</option>';
  const groups = {};
  for (const a of actions) {
    const g = groups[a.plugin] || (groups[a.plugin] = document.createElement('optgroup'));
    g.label = a.plugin === 'core' ? 'Built in' : a.label.split(':')[0];
    const o = document.createElement('option');
    o.value = a.id; o.textContent = a.label;  // the full "Plugin: action" label, since a closed select shows only this text
    g.append(o);
  }
  Object.values(groups).forEach(g => sel.append(g));
  if (selected && !actions.some(a => a.id === selected)) {  // e.g. its plugin is turned off
    const o = document.createElement('option'); o.value = selected; o.textContent = selected + ' (unavailable)'; sel.append(o);
  }
  sel.value = selected || '';
  return sel;
}

// Joystick first, then buttons in the order the box reports them.
const btOrder = id => (id[0] === 'b' ? 'z' : 'a') + id.replace(/\d+/g, n => n.padStart(3, '0'));

function btDraw(d) {
  $('btStatus').textContent = !d.available ? 'Button support is not installed (npm install node-hid).'
    : d.connected ? `Connected: ${d.device.name}.` : (d.error || 'No button box found.');
  if (d.devices && d.devices.length > 1) {
    $('btDevice').hidden = false;
    $('btDevice').innerHTML = '';
    for (const x of d.devices) { const o = document.createElement('option'); o.value = x.key; o.textContent = x.name || x.key; $('btDevice').append(o); }
    if (d.device) $('btDevice').value = d.device.key;
  }
  const ids = Object.keys(d.inputs).sort((a, b) => btOrder(a).localeCompare(btOrder(b)));
  const units = d.units || [];
  // With several Times Gates: which one the box controls, and the feedback when switching.
  $('btUnitRow').style.display = units.length > 1 ? '' : 'none';
  if (units.length > 1 && document.activeElement !== $('btSelected')) {
    const sel = $('btSelected'), want = units.map(u => u.id + '|' + u.name).join(',');
    if (sel.dataset.units !== want) {
      sel.dataset.units = want; sel.innerHTML = '';
      units.forEach(u => { const o = document.createElement('option'); o.value = u.id; o.textContent = u.name; sel.append(o); });
    }
    sel.value = d.selected || units[0].id;
  }
  if ('switchFlash' in d) $('btSwFlash').checked = d.switchFlash;
  const known = JSON.stringify([ids, d.inputs, (d.actions || []).map(a => a.id), units.map(u => u.id + u.name)]);
  if (known !== btKnown && !document.activeElement?.closest?.('#btList')) {
    btKnown = known;
    const box = $('btList');
    box.innerHTML = ids.length ? '' : '<div class="hint" style="padding:10px">Nothing pressed yet — press a button on the box.</div>';
    for (const id of ids) {
      const b = d.inputs[id];
      const row = document.createElement('div');
      row.className = 'btn-row'; row.dataset.id = id;
      const name = document.createElement('input');
      name.type = 'text'; name.value = b.name; name.title = 'Name it after the button, e.g. "Top red 1"';
      name.onchange = () => btCall({ input: id, name: name.value }).catch(e => log('Buttons: ' + e.message, 'e'));
      const press = btOptions(d.actions, b.press), hold = btOptions(d.actions, b.hold);
      press.title = 'Short press'; hold.title = 'Held for a second';
      hold.options[0].textContent = '— no hold action —';
      press.onchange = () => btCall({ input: id, press: press.value }).catch(e => log('Buttons: ' + e.message, 'e'));
      hold.onchange = () => btCall({ input: id, hold: hold.value }).catch(e => log('Buttons: ' + e.message, 'e'));
      const x = document.createElement('button');
      x.textContent = '×'; x.title = 'Forget this input';
      x.onclick = () => btCall({ forget: id }).then(btDraw).catch(e => log('Buttons: ' + e.message, 'e'));
      const lp = document.createElement('small'); lp.textContent = 'press'; const lh = document.createElement('small'); lh.textContent = 'hold';
      row.append(name, lp, press, lh, hold);
      // With more than one Times Gate: which one this button acts on.
      if (units.length > 1) {
        const on = document.createElement('select');
        on.title = 'Which Times Gate this button controls';
        on.style.flex = '0 1 190px';
        on.innerHTML = '';
        const follow = document.createElement('option'); follow.value = ''; follow.textContent = 'on the selected one'; on.append(follow);
        units.forEach(u => { const o = document.createElement('option'); o.value = u.id; o.textContent = 'on ' + u.name; on.append(o); });
        const all = document.createElement('option'); all.value = 'all'; all.textContent = 'on all of them'; on.append(all);
        on.value = b.unit || '';
        on.onchange = () => btCall({ input: id, unit: on.value }).catch(e => log('Buttons: ' + e.message, 'e'));
        row.append(on);
      }
      row.append(x);
      box.append(row);
    }
  }
  // light up what's pressed right now, and the last press for a moment
  const recent = d.last && Date.now() - d.last.at < 1200 ? d.last.id : null;
  for (const row of $('btList').querySelectorAll('.btn-row')) row.classList.toggle('down', d.down.includes(row.dataset.id) || row.dataset.id === recent);
}

$('btSelected').onchange = () => btCall({ selected: $('btSelected').value }).then(btDraw).catch(e => log('Buttons: ' + e.message, 'e'));
$('btSwFlash').onchange = () =>
  btCall({ switchFlash: $('btSwFlash').checked }).then(btDraw).catch(e => log('Buttons: ' + e.message, 'e'));
$('btDevice').onchange = () => btCall({ device: $('btDevice').value }).then(btDraw).catch(e => log('Buttons: ' + e.message, 'e'));
btCall().then(btDraw).catch(() => {});
setInterval(async () => { try { btDraw(await (await fetch('/api/buttons')).json()); } catch {} }, 500);

// Scores and brightness can change from the buttons: keep the page's controls in step.
onEngineState(s => {
  if (s.score) {
    if (document.activeElement !== $('red')) $('red').value = s.score.red;
    if (document.activeElement !== $('blue')) $('blue').value = s.score.blue;
  }
  if (typeof s.brightness === 'number' && document.activeElement !== $('bright')) { $('bright').value = s.brightness; $('brightVal').textContent = s.brightness; }
});
