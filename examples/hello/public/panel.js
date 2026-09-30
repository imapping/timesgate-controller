// The plugin's panel on the page. Wrapped in a function so its names don't clash with others.
(() => {
  const p = TG.plugin('hello');
  const hue = () => (Math.floor(Date.now() / 60000) * 40) % 360;

  // Used by the Preview button (and Show / Keep it updated, to animate the page's tiles).
  p.preview = async () => helloRender(p.el('#helloMsg').value, hue());

  // Keep the text box in step with the server (also changes made on another device).
  p.onState(s => { if (document.activeElement !== p.el('#helloMsg')) p.el('#helloMsg').value = s.message; });

  p.el('#helloSave').onclick = async () => {
    try {
      await p.api('message', { message: p.el('#helloMsg').value });
      p.runPreview();
      p.info('Saved.');
    } catch (e) { log('Hello: ' + e.message, 'e'); }
  };
})();
