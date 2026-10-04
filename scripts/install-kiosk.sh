#!/usr/bin/env bash
# Shows the Now Playing page full-screen on a screen plugged into the Pi's HDMI port (a touch screen
# works by touch), starting when the Pi boots. Needs no desktop: it uses cage, a minimal kiosk
# display, running Chromium on the first console (tty1).
#
# Run it on the Pi as your normal user, after install-pi.sh:
#
#   curl -fsSL https://raw.githubusercontent.com/imapping/timesgate-controller/main/scripts/install-kiosk.sh | bash
#
# Running it again updates the setup. To remove it:  ... | bash -s remove
# Options (environment variables): PORT (default 8080), KIOSK_URL (default the Now Playing page).
set -euo pipefail

PORT="${PORT:-8080}"
URL="${KIOSK_URL:-http://127.0.0.1:$PORT/plugins/nowplaying/now.html?kiosk}"
ME="$(id -un)"

if [ "$(id -u)" -eq 0 ]; then echo "Run this as your normal user, not root. It uses sudo when it needs to."; exit 1; fi

if [ "${1:-}" = "remove" ]; then
  sudo systemctl disable -q --now timesgate-kiosk 2>/dev/null || true
  sudo rm -f /etc/systemd/system/timesgate-kiosk.service /etc/pam.d/timesgate-kiosk /usr/local/bin/timesgate-kiosk
  sudo systemctl daemon-reload
  sudo systemctl enable -q --now getty@tty1 2>/dev/null || true
  echo "Removed. The screen shows the login prompt again."
  exit 0
fi

echo "== 1/3 Installing cage and Chromium (this can take a few minutes)"
sudo apt-get update -qq
# Raspberry Pi OS calls it chromium (since Bookworm) or chromium-browser (before).
if apt-cache show chromium >/dev/null 2>&1; then BROWSER_PKG=chromium; else BROWSER_PKG=chromium-browser; fi
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends cage "$BROWSER_PKG" fonts-noto-core curl >/dev/null
BROWSER="$(command -v chromium || command -v chromium-browser)"
sudo usermod -aG video,render,input "$ME"

echo "== 2/3 Setting up the display"
# What the service runs: wait for the controller, then Chromium in kiosk mode under cage.
sudo tee /usr/local/bin/timesgate-kiosk >/dev/null <<SCRIPT
#!/bin/sh
# TimesGate kiosk (from install-kiosk.sh). Waits up to a minute for the controller, so the page
# doesn't open on an error.
for i in \$(seq 1 60); do curl -fs "http://127.0.0.1:$PORT/api/units" >/dev/null 2>&1 && break; sleep 1; done
exec cage -s -- "$BROWSER" --kiosk "$URL" --incognito --noerrdialogs --disable-infobars --no-first-run \\
  --password-store=basic --ozone-platform=wayland --disable-features=Translate,MediaRouter \\
  --check-for-update-interval=31536000 --disable-pinch --overscroll-history-navigation=0
SCRIPT
sudo chmod 755 /usr/local/bin/timesgate-kiosk

# A login session on tty1 (so cage may use the screen, keyboard and touch), in place of the text login.
sudo tee /etc/pam.d/timesgate-kiosk >/dev/null <<'PAM'
auth     required pam_unix.so nullok
account  required pam_unix.so
session  required pam_unix.so
session  required pam_systemd.so
PAM
sudo tee /etc/systemd/system/timesgate-kiosk.service >/dev/null <<UNIT
[Unit]
Description=TimesGate Now Playing display (cage + Chromium on tty1)
After=timesgate.service systemd-user-sessions.service plymouth-quit-wait.service
Wants=timesgate.service
Conflicts=getty@tty1.service
After=getty@tty1.service

[Service]
User=$ME
PAMName=timesgate-kiosk
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
StandardInput=tty-fail
UtmpIdentifier=tty1
UtmpMode=user
ExecStart=/usr/local/bin/timesgate-kiosk
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl disable -q getty@tty1 2>/dev/null || true
sudo systemctl enable -q timesgate-kiosk

echo "== 3/3 Starting it"
sudo systemctl stop getty@tty1 2>/dev/null || true
sudo systemctl restart timesgate-kiosk
sleep 8
if systemctl is-active -q timesgate-kiosk; then
  echo
  echo "The screen should now show the Now Playing page (a clock while nothing plays)."
  echo "It starts by itself when the Pi boots. Logs:  journalctl -u timesgate-kiosk -f"
  echo "To remove it:  bash install-kiosk.sh remove   (or the curl line with: | bash -s remove)"
else
  echo "It didn't start. See what went wrong with:  journalctl -u timesgate-kiosk -n 50"
  exit 1
fi
