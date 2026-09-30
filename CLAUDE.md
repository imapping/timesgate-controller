# TimesGate controller

Web controller for a Divoom Times Gate (five 128×128 screens), running as a Node server on port
8080 (Windows scheduled task "TimesGate Controller", output in server.log).

- `server.js`: HTTP server. Relays device commands, static files, and plugin routes.
- `engine.js`: everything that runs with the page closed. Sends every device command, keeps
  a plugin's screens updated, and runs the timer flash, light show and edge alerts.
  - It supports several Times Gates ("units", `u1`, `u2`…). Each `Unit` has its own feed,
    picture ids, timer, score, lights and brightness.
  - The page sends `unit` with every call, as the `X-TG-Unit` header for plugin routes.
    Leaving it out means the first unit.
  - State is in `engine.json`.
- `plugin-host.js`: loads `plugins/*`, the `tg` toolkit, install/remove, and actions.
- `mic.js`: the shared microphone. It uses ffmpeg on Windows and arecord on a Pi, and runs only while something uses it.
- `buttons.js`: reads the USB button box through node-hid, and runs the action assigned to each button.
- `public/`: the page. `index.html` holds the core controls; `plugins.js` holds the `TG` page API
  and the plugin loader.
- `plugins/<id>/`: features as plugins (claude, spotify, vinyl, weather, visualizer, github).
- `data/`: plugin settings and secrets. Never serve these. `data/trusted.json` lists other computers
  treated as local (allowed to change setup and tokens), for a Pi with no screen.
- `scripts/install-pi.sh`: installs it on a Raspberry Pi as a systemd service (run over SSH from the PC).
- `examples/hello/`: a minimal plugin to copy.

**To add a feature that shows something on the screens, write a plugin. See PLUGINS.md.**

Device notes:
- The local API is `POST http://<ip>:80/post` (Hardware 402: `:9000/divoom_api`).
- A "DeviceToken is err" reply still means the command worked.
- The device never pushes events, so there is no way to read its buttons.
- Sending a picture to any screen makes the device leave its timer, tool or clock display.
- `Draw/SendHttpGif` PicIDs must keep increasing, per device. They come from each unit's
  `nextPicId()`, shared with the page through `POST /api/picid { unit }`.
- Use `127.0.0.1`, not `localhost`: resolving `localhost` is slow on Windows.
