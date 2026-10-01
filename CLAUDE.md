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
- `mic.js`: the shared microphone or direct input. It captures 44.1 kHz stereo and derives mono 22.05 kHz for
  plugins (analysis, clips). `GET /api/mic/stream` plays it live as an endless WAV (`?hq` for the stereo capture, `?hq&keep` for a recording that never drops sound; trusted computers only, unless the
  input is marked as a direct connection, per device, in `data/mic.json`;
  the page plays it through Web Audio). It uses ffmpeg on Windows and arecord on a Pi, and runs only while something uses it.
- `listening.js`: the listening log, every song heard (Vinyl) or played (Spotify), in SQLite at
  `data/listening.db` via better-sqlite3 (pinned to 12.11.1, the last to support the Pi's Node 20).
  Plugins use `tg.listening.add/query/annotate/favourite`. `POST /api/listening/note` saves the user's marks and comment on a play
  (the page's `TG.editNote`); `POST /api/listening/favourite` stars a song (`TG.favButton`).
- `plugins/vinyl/discogs.js`: the user's Discogs record collection, saved in `data/vinyl-discogs.json`. Vinyl uses it to
  give each identified song the album, year, cover and side/track of the record they own.
- `plugins/vinyl/prints.js`: Vinyl's own recognition. Tracks are fingerprinted as they play (spectrogram peak pairs) and saved in
  `data/vinyl-prints.db`; clips are matched there first, and only unknown ones go to AudD/ACRCloud.
- `buttons.js`: reads the USB button box through node-hid, and runs the action assigned to each button.
  With several Times Gates, the box has a selected one (`buttons.switch` moves to the next, with a
  beep and edge flash); buttons without a fixed unit act on it.
- `public/`: the page. `index.html` holds the core controls; `plugins.js` holds the `TG` page API
  and the plugin loader.
- `plugins/<id>/`: features as plugins (claude, spotify, vinyl, weather, visualizer, github, reports).
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
