# Servers

Checks your servers' health every minute and shows which are up, with their CPU, memory, fullest disk
and databases. The rainbow edge light comes on when one goes down or has a problem.

- **Screen 1:** how many servers are up, and the names of those with problems.
- **Screens 2–5:** a server each, the worst first (up to four). A running server shows its CPU, memory
  and fullest disk, and the first problem or its uptime. One that's down shows DOWN, for how long, and why.

A server counts as a **problem** (red) when it's down, a disk is past the red limit (95%), memory is
at 97% or more, or a database test fails. It's a **warning** (amber) when CPU averages over 90% for
the last three checks, memory or a disk is over 90%, or Windows is waiting to restart. The limits can
be changed in the card.

Buttons can use `servers.check`.

## Putting the health page on an IIS server

`iis/health.ashx` is a VB.NET handler for any ASP.NET site (.NET Framework 4.0 or later, no extra packages).

1. Copy `health.ashx` into the site's folder (the root, or any folder that runs ASP.NET).
2. Add a key to the site's `web.config`. Make it long and random, e.g. from PowerShell:
   `[Convert]::ToBase64String((1..32 | % { [byte](Get-Random -Max 256) }))`

   ```xml
   <configuration>
     <appSettings>
       <add key="HealthKey" value="(the long random key)" />
       <!-- optional: connection strings (by name) to test with SELECT 1 -->
       <add key="HealthDatabases" value="MainDB,LogDB" />
     </appSettings>
   </configuration>
   ```

   Without a HealthKey of at least 16 characters, the page refuses every request (503), so it can't be
   left open by accident.
3. Use **HTTPS** if the controller reaches the server over the internet. On your own network, a
   self-signed certificate is fine: tick **Accept a self-signed certificate** when you add it.
4. In the Servers card, on the computer running the controller (or one it trusts), add the server
   with its address (e.g. `https://web1.example.com/health.ashx`) and the key.

The site's application pool identity (the default ApplicationPoolIdentity is enough) needs to read WMI
and the registry, which it can by default. If something can't be read, the page still answers and lists
it in `readErrors`.

The page can't change anything. It never reports paths, connection strings, user names or error
details (a failed database shows only the type of error). Readings are reused for 10 seconds, so
calling it often costs nothing. A key in the address (`?key=`) is refused, so it doesn't end up in logs.

## The health page's answer

Any server (Linux, Node, PHP…) can be checked by answering `GET` with `Authorization: Bearer <key>`
with this JSON. Only `apiVersion` is required; anything missing is shown as "–".

```json
{
  "apiVersion": 1,
  "generatedAt": "2026-10-09T03:56:00Z",
  "server": "WEB1",
  "site": "Default Web Site",
  "os": "Microsoft Windows Server 2022 Standard 10.0.20348",
  "cpuPercent": 12,
  "cores": 4,
  "memory": { "totalMb": 16384, "usedMb": 9011, "percent": 55 },
  "uptimeSeconds": 1209600,
  "bootedAt": "2026-09-25T03:56:00Z",
  "disks": [{ "name": "C:", "label": "System", "totalGb": 237.9, "freeGb": 4.8, "percentUsed": 98 }],
  "restartPending": false,
  "app": { "startedAt": "2026-10-09T01:00:00Z", "memoryMb": 210, "threads": 38 },
  "databases": [{ "name": "MainDB", "ok": true, "ms": 4 }],
  "readErrors": []
}
```

A wrong key gets 401, and the card says the server refused the key.
