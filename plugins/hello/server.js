// Runs in the TimesGate server. Gets `tg` (the toolkit, see PLUGINS.md) and returns what it offers.
const { helloRender } = require('./public/render.js');

module.exports = tg => {
  if (!tg.settings.message) { tg.settings.message = 'Kia ora from a plugin'; tg.save(); }
  const hue = () => (Math.floor(Date.now() / 60000) * 40) % 360;  // new colour each minute

  return {
    // What to put on the screens (Show, or Keep it updated).
    render: () => helloRender(tg.settings.message, hue()),
    // While kept updated: redraw every minute (only screens whose key changed are re-sent).
    poll: { every: 60 * 1000, run: () => tg.update() },
    // Sent to the page as TG.plugin('hello').onState(...)
    state: () => ({ message: tg.settings.message }),
    // HTTP routes at /api/hello/…
    routes: {
      'POST /message': ({ body }) => {
        tg.settings.message = String(body.message || '').slice(0, 60);
        tg.save();
        tg.update();  // redraws only if it's the one kept updated
        return { message: tg.settings.message };
      },
    },
    // Things the button box (Buttons card) can trigger, or: POST /api/plugins/action { id: 'hello.beep' }
    actions: {
      beep: { label: 'beep twice', run: () => tg.device.beep({ on: 100, off: 100, total: 400 }) },
    },
  };
};
