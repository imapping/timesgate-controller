# 3D printer

A Bambu Lab printer's progress on the Times Gate, read straight from the printer on your network.

- **Screen 1:** printing, paused, done or failed, with a progress ring and the job's name.
- **Screen 2:** the time left and when it'll be done (or when it finished).
- **Screen 3:** the layer, with a stack that fills up; while it gets ready, what it's doing (heating, levelling…).
- **Screen 4:** the nozzle, bed and chamber temperatures, with their targets while heating.
- **Screen 5:** the filament slots (AMS and the spool at the back), the one in use outlined.

When a print finishes or fails, the rainbow edge light comes on (on the Times Gates with alerts on).
It can also put the printer on the Times Gate when a print starts. Buttons can use `printer.refresh`
and `printer.test`.

## Setting it up

From the printer's screen:
- its **IP address** and **access code** (in its network / LAN settings);
- its **serial number** (on its Device page).

Enter them in the card's **Printer** section, on the computer running the controller (or one it
trusts). The access code is kept in `data/printer.json` and never sent to the page. Reserve the
printer's address in your router so it doesn't change.

Leave the printer in its normal mode: the plugin doesn't need LAN Only or Developer Mode, so Bambu
Handy and cloud printing keep working. If the card says the printer **refused the access code** even
though it's right, that printer's firmware only lets Bambu's own apps read it in normal mode.

## How it works

The printer has a small MQTT server (port 8883, TLS, user `bblp`, the access code as the password).
The plugin subscribes to `device/<serial>/report`; the printer sends what changed about once a second
while printing, and a full report when asked (`pushall`, at connect and every 10 minutes). Nothing goes
through Bambu's cloud, and the plugin never sends the printer any commands besides asking for that report.

The printer's certificate is signed by Bambu's own authority, so it isn't checked: use it only on your
own network.

Newer printers may report some things differently. `GET /api/printer/raw` (trusted computers only)
shows the printer's whole last report, to see what it sends.

Unofficial: not made by or affiliated with Bambu Lab.
