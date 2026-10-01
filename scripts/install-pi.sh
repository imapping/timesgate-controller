#!/usr/bin/env bash
# Installs the TimesGate controller on a Raspberry Pi (Raspberry Pi OS Lite, 64-bit), or any
# Debian-based Linux, and runs it as a service that starts when the Pi boots.
#
# Run it on the Pi as your normal user (it uses sudo when needed), ideally over SSH from the
# computer you'll set things up from, since that computer is then allowed to change setup and tokens:
#
#   curl -fsSL https://raw.githubusercontent.com/imapping/timesgate-controller/main/scripts/install-pi.sh | bash
#
# Running it again updates to the latest version and keeps your settings (data/ and engine.json).
# Options (environment variables): TIMESGATE_DIR (default ~/timesgate-controller), PORT (default 8080).
set -euo pipefail

REPO=https://github.com/imapping/timesgate-controller.git
DIR="${TIMESGATE_DIR:-$HOME/timesgate-controller}"
PORT="${PORT:-8080}"
ME="$(id -un)"

if [ "$(id -u)" -eq 0 ]; then echo "Run this as your normal user, not root. It uses sudo when it needs to."; exit 1; fi

echo "== 1/6 Installing Node.js, git, arecord and fonts (this can take a few minutes)"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git nodejs npm alsa-utils fonts-noto-core >/dev/null
if ! node -e 'process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)'; then
  echo "Node.js 18 or newer is needed, but this system has $(node -v)."; exit 1
fi
echo "   Node.js $(node -v)"

echo "== 2/6 Getting the controller into $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only -q; else git clone -q --depth 1 "$REPO" "$DIR"; fi
cd "$DIR"
npm install --omit=dev --no-audit --no-fund --loglevel=error
# The listening log uses better-sqlite3, which normally downloads a ready-built copy. If that
# wasn't available, build it here instead (needs a compiler, so it takes a few minutes).
if ! node -e "require('better-sqlite3')" 2>/dev/null; then
  echo "   Building the SQLite library for the listening log (a few minutes)…"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential python3 >/dev/null
  npm rebuild better-sqlite3 --loglevel=error || echo "   Couldn't build it; everything else works, but the listening log is off."
fi

echo "== 3/6 Letting it read the USB button box and the microphone"
sudo tee /etc/udev/rules.d/99-timesgate-buttons.rules >/dev/null <<'RULES'
# TimesGate controller: let the plugdev group read the USB arcade button box.
# DragonRise "zero delay" arcade encoder (0079:0006). For another box, copy these two lines
# with its ids from `lsusb`, then run: sudo udevadm control --reload-rules && sudo udevadm trigger
KERNEL=="hidraw*", ATTRS{idVendor}=="0079", ATTRS{idProduct}=="0006", MODE="0660", GROUP="plugdev"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0079", ATTRS{idProduct}=="0006", MODE="0660", GROUP="plugdev"
RULES
sudo udevadm control --reload-rules
sudo udevadm trigger
sudo usermod -aG plugdev,audio "$ME"

echo "== 4/6 Trusting the computer you're connecting from"
mkdir -p data
FROM="${SSH_CLIENT%% *}"
if [ -n "$FROM" ]; then
  node -e '
    const fs = require("fs"), f = "data/trusted.json", ip = process.argv[1];
    let t = { hosts: [] }; try { t = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    t.hosts = [...new Set([...(t.hosts || []), ip])];
    fs.writeFileSync(f, JSON.stringify(t, null, 2) + "\n");' "$FROM"
  echo "   $FROM can change setup, tokens and plugins (edit data/trusted.json to change this)."
else
  echo "   Not run over SSH, so only this Pi is trusted. Add your PC's IP to data/trusted.json:"
  echo '   { "hosts": ["192.168.1.20"] }'
fi

echo "== 5/6 Setting it up as a service"
sudo tee /etc/systemd/system/timesgate.service >/dev/null <<UNIT
[Unit]
Description=TimesGate controller
After=network-online.target sound.target
Wants=network-online.target

[Service]
User=$ME
WorkingDirectory=$DIR
Environment=PORT=$PORT
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable -q timesgate
sudo systemctl restart timesgate

echo "== 6/6 Checking it started"
for i in $(seq 1 20); do
  if curl -fs "http://127.0.0.1:$PORT/api/units" >/dev/null 2>&1; then break; fi
  sleep 1
done
IP="$(hostname -I | awk '{print $1}')"
if curl -fs "http://127.0.0.1:$PORT/api/units" >/dev/null 2>&1; then
  echo
  echo "The TimesGate controller is running:  http://$IP:$PORT   (or http://$(hostname).local:$PORT)"
  echo
  echo "Moving from a PC? Stop the controller there, copy its data/ folder and engine.json into"
  echo "$DIR, then run:  sudo systemctl restart timesgate"
  echo "Logs:  journalctl -u timesgate -f"
else
  echo "It didn't start. See what went wrong with:  journalctl -u timesgate -n 50"
  exit 1
fi
