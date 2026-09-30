# Writing TimesGate plugins

A plugin adds a feature to the TimesGate controller: something to show on the five screens
(weather, Spotify, Claude status…), its card on the web page, and optionally HTTP routes and
actions that buttons can trigger. Plugins run inside the controller's Node server, so they keep
working with the web page closed.

The quickest start is to copy `examples/hello/`, which uses every part described here in about 80
lines. The built-in plugins are fuller, real-world examples:

| Plugin | Shows how to |
|---|---|
| `plugins/claude` | Receive data from other software on the PC, and use device alerts |
| `plugins/spotify` | Handle an OAuth login, poll an API, and draw album art |
| `plugins/weather` | Use a free API with no key |
| `plugins/visualizer` | Use the microphone and drive the lights |
| `plugins/vinyl` | Record audio clips, call a paid API within a monthly budget, and run an on-request mode that switches itself off |

## Folder layout

```
plugins/<id>/
  plugin.json        required — the manifest
  server.js          runs in the server: draws the screens, routes, actions
  public/            served to the page at /plugins/<id>/…  (nothing else in the folder is)
    render.js        draws the screens — shared by the page (previews) and server.js (the device)
    panel.html       the plugin's card on the page
    panel.js         the card's behaviour
  README.md          what it does and any setup it needs
```

Only `plugin.json` is required. A plugin with just `server.js` works (no card on the page); a
plugin with just `public/` files can add page-only tools.

Install one by putting the folder in `plugins/` and restarting the server, or from the page:
**Plugins → Install** with a .zip of the folder or a GitHub link (`https://github.com/you/repo`,
or `…/tree/main/some/folder` for a plugin inside a bigger repo). Installing a plugin with the same
id replaces it. Installed plugins can be turned off or removed on the page too.

## plugin.json

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "1.0.0",
  "description": "One line shown in the Plugins list.",
  "author": "You",
  "panel": "panel.html",
  "scripts": ["render.js", "panel.js"],
  "liveLabel": "Keep it updated",
  "order": 100
}
```

| Field | |
|---|---|
| `id` | Required. Lowercase letters, digits and dashes (2–32). Must match the folder name. Used in URLs: `/api/<id>/…`, `/plugins/<id>/…`. Can't be `device`, `engine`, `picid`, `cloud`, `upload`, `uploads`, `plugins` or `actions`. |
| `name`, `version`, `description`, `author` | Shown in the Plugins list. |
| `server` | Server file, default `server.js`. |
| `panel` | HTML file in `public/` for the card. |
| `scripts` | Files in `public/` loaded into the page in this order, after the panel is added. |
| `liveLabel` | Text of the "Keep it updated" tick box. |
| `order` | Position of the card among plugins (lower first; built-ins use 10–30). |

## server.js

Export a function. It gets `tg`, the toolkit, and returns an object saying what the plugin offers.
Every property is optional.

```js
const { helloRender } = require('./public/render.js');

module.exports = tg => ({
  render: () => helloRender(tg.settings.message),             // what goes on the screens
  poll: { every: 60000, run: () => tg.update() },             // runs only while kept updated
  live: on => {},                                             // it started/stopped being kept updated
  state: () => ({ message: tg.settings.message }),            // sent to the page (TG.plugin(id).onState)
  routes: { 'POST /message': ({ body }) => { … return { ok: true }; } },
  actions: { beep: { label: 'beep twice', run: args => tg.device.beep() } },
  pageCommand: payload => {},                                 // the page sent a light command / started the light show
  stop: () => {},                                             // plugin turned off or removed
});
```

### render() — the screens

`render()` (may be async) returns:

```js
{
  speed: 180,                       // ms per frame
  parts: [                          // usually one per screen
    { key: 'wx|Auckland|12:00',     // changes only when this part's picture changes
      jobs: [{ screen: 0, frames: [canvas, canvas, …], x: 0 }] },
    …
  ]
}
```

- `screen` is 0–4, left to right. Each screen is 128×128.
- `frames` are canvases from `makeCanvas(w, h)`. Up to **40 frames** loop as an animation.
- `x` (optional) is where this screen's 128-pixel tile starts in the frame, so one wide canvas can
  span several screens: a 256×128 canvas with jobs `{screen: 1, x: 0}` and `{screen: 2, x: 128}`
  shows across screens 2–3. Spotify's song title does this.
- `key` is how updates stay fast: when kept updated, only parts whose key changed are re-sent.
  Put whatever the picture depends on in it, such as the song id or the forecast time.
- Throw an `Error` if there's nothing to show (e.g. not set up). The page shows the message.

**Device limits to design for.** Uploading is slow: roughly 0.3–1 s per frame for all five
screens together, so 8 frames takes a few seconds. Keep animations short (8–12 frames). Don't
re-render more often than the data changes, and use keys. Pictures are sent as JPEG, so avoid
fine one-pixel detail. Fonts: `system-ui, "Segoe UI", sans-serif` works in both the page and the
server.

### Staying up to date

Two ways, use either or both:
- `poll: { every: ms, run }`: the host calls `run` every `ms` while this plugin is the one kept
  updated (and never otherwise). Fetch your data there, and call `tg.update()` if it changed.
- Call `tg.update()` whenever your data changes, e.g. from a route that receives a webhook. It
  does nothing unless the plugin is being kept updated.

Only one plugin is kept updated at a time. Sending anything else to the screens (from the page, a
scene, or another plugin's Show) stops it.

### routes — HTTP

Keys are `'<METHOD> <path>'`, served at `/api/<id><path>`. Handlers get one object:

| | |
|---|---|
| `body` | Parsed JSON body (`{}` if empty, `null` if not JSON) |
| `raw` | The body as a Buffer (for non-JSON uploads) |
| `query` | `URLSearchParams` of the query string |
| `local` | `true` if the request came from this PC (not the phone / LAN) |
| `req`, `res`, `url` | Node's request/response, for redirects, images, streaming |

Return a value to reply with it as JSON. Return nothing to reply `204 No Content`. Or write to
`res` yourself. Throw `Object.assign(new Error('message'), { status: 400 })` for an error reply.

**Security:** the server is reachable from every device on the home network. Anything that
changes setup, logs in, or accepts data from other software on the PC should check `local` (see
the Claude and Spotify plugins). Never serve secrets from `public/`.

### actions

Named things a plugin can do, for the USB button box (Buttons card), scenes and other plugins.
Every plugin with `render` automatically gets `<id>.show` and `<id>.live`
(`{ on: true|false }`, or toggles). Run one with `POST /api/plugins/action { "id": "hello.beep", "args": {} }`;
list them with `GET /api/plugins/actions`. The list also includes built-in `core.*` actions, such as
`core.next` (next screen feature), `core.redUp`, `core.timer5` and `core.brightUp`. Plugins can run
those the same way. Keep action labels short: they appear in the buttons' drop-down lists.

### pageCommand — sharing the lights

If your plugin drives the lights (as the visualizer does), define `pageCommand(payload)`. It's called
when the page sends a `Channel/SetRGBInfo` command or starts the light show
(`{ Command: 'Engine/LightShow' }`). Stop driving the lights then, because the user has taken them
back. Call `tg.device.stopLightShow()` before you start.

### The toolkit: `tg`

| | |
|---|---|
| `tg.id`, `tg.dir`, `tg.port` | The plugin's id, its folder, and the server's port |
| `tg.log(...)` | Write to server.log, tagged with the plugin id |
| `tg.settings`, `tg.save()` | Saved data (JSON object, in `data/<id>.json`, kept across restarts, upgrades and removal). Change it, then call `save()`. You may replace the whole object. |
| `tg.update()` | Redraw the screens if this plugin is being kept updated |
| `tg.show()` | Show it once now (promise) |
| `tg.setLive(on)`, `tg.isLive()` | Start/stop keeping it updated |
| `tg.every(ms, fn)`, `tg.after(ms, fn)`, `tg.clear(t)` | Timers that are cleaned up automatically when the plugin is turned off. Prefer these (or `poll`) over `setInterval`. |
| `tg.makeCanvas(w, h)` | A canvas (`@napi-rs/canvas`, the same drawing API as the browser). `makeCanvas` is also a global, for shared render code. |
| `tg.loadImage(urlOrBuffer)` | Load an image for drawing (downloads `http(s)` URLs) |
| `tg.device.send(payload)` | Send any Divoom API command, e.g. `{ Command: 'Channel/SetBrightness', Brightness: 50 }`. Resolves to the device's reply. |
| `tg.device.beep({ on, off, total })` | Beep (milliseconds) |
| `tg.device.edgeRainbow(ms)` | Edge light rainbow for a while, then back to how it was |
| `tg.device.stopLightShow()` | Stop the built-in light show (before driving the lights yourself) |
| `tg.mic.listen(fn, { sensitivity })` | Use the microphone. `fn({ t, level, db, beat, bpm })` runs about 43 times a second. `level` is 0–1, `db` is dBFS, `beat` is true on a detected beat, and `bpm` is the tempo or null. Sensitivity is 0–1 and sets how easily beats are detected. Returns a function that stops listening. The mic only runs while something listens, and it stops automatically when the plugin is turned off. |
| `tg.mic.record(ms)` | Resolves to a WAV Buffer of the next `ms` of sound (mono, 16-bit, 22.05 kHz, up to 30 s). Nothing is saved to disk. |
| `tg.mic.status()` | `{ running, error, device, level, db, bpm, … }` |

Node's built-in modules (`fetch`, `crypto`, `fs`…) are all available. npm packages aren't
installed for plugins: pure-JavaScript packages can be bundled inside the plugin folder, but prefer
built-ins.

## The page: render.js, panel.html, panel.js

**render.js** holds the drawing code used by both sides. It must only use `makeCanvas` (global in
both) and plain JavaScript, and end with
`if (typeof module === 'object') module.exports = { … };` so `server.js` can `require` it.
Page scripts share one global scope with every other plugin, so **prefix top-level names**
(`helloRender`, `WX_SPEED`…).

**panel.html** is the card's content (the page adds the heading). Put `<div data-tg-controls></div>`
where the standard **Preview / Show on Times Gate / Keep it updated** row should go; without it the
row goes at the end. That row appears only for plugins with `render`. Give element ids a prefix too
(`helloMsg`), since they share the page.

**panel.js** should wrap itself in `(() => { … })();` and use `TG.plugin('<id>')`:

| | |
|---|---|
| `p.preview = async () => ({ speed, parts })` | Draw for the page's tiles (same shape as `render()`). Used by the Preview button and when showing. Return `null` if there's nothing yet. |
| `p.el(selector)` | An element inside this plugin's card |
| `await p.api(path, body?)` | Call your routes: GET without a body, POST (JSON) with one. Throws the server's error message. |
| `p.onState(fn)` | `fn(state)` with your server `state()`, now and whenever it's polled (every 3 s) |
| `p.show()`, `p.setLive(on)`, `p.isLive()` | Same as the standard buttons |
| `p.runPreview()` | Run `p.preview` and animate the tiles |
| `p.info(text)` | Status text next to the buttons |
| `p.controls(visible)` | Hide the standard row (e.g. until set up) |

Also available: `log(message, 'o' | 'e')` writes to the page's log (ok / error), and `makeCanvas`.

## Checklist (for people and Claude agents writing a plugin)

1. Copy `examples/hello` to `plugins/<your-id>`, and set `id`, `name` and `description` in `plugin.json`.
2. Draw in `public/render.js`. Keep it shared and prefix its names.
3. `server.js`: `render`, then `poll` or `tg.update()` for freshness, then `state` and `routes`
   for the card, then `actions`.
4. Check `ctx.local` on anything sensitive. Keep keys and tokens in `tg.settings`, never in `public/`.
5. Restart the server (or install the zip from the page). Watch `server.log` for
   "Plugin <id> loaded" or the error.
6. Test: Preview on the page, Show on Times Gate, Keep it updated (then close the page and check
   the device still updates), turn the plugin off and on in the Plugins list.
7. Write a `README.md`: what it shows on each screen, and any setup (API keys, accounts).
