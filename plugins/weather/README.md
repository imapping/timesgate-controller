# Weather

- **Screen 1:** current conditions.
- **Screen 2:** the rain radar for the last two hours, looping (the latest held longest), about 125 km
  across with your place in the ring, and the time of each picture. RainViewer has 10-minute frames,
  but New Zealand's radar reaches it only hourly, so there it's about three pictures an hour apart
  (repeats are left out).
- **Screens 3–5:** the forecast for today and the next two days.

The forecast is from Open-Meteo, free and with no key. The icons are animated. When kept updated, the
forecast refreshes every 30 minutes and the radar every 10. Choose the place with the search box; it's
saved in `data/weather.json`.

The radar is RainViewer's, at its most detailed zoom (7). It shows only where rain has been (RainViewer
stopped its forecast in 2026), in blues from light to heavy, then yellow to red for the heaviest; its
faint haze of drizzle is left out so the map stays readable. The map under it is land and sea made from
OpenStreetMap's tiles: the four or so tiles around your place are fetched once and kept in
`data/weather-radar/`, with the finished map. Radar frames are kept while they're in the last two hours,
so each update fetches only the newest one.

Weather data by [Open-Meteo.com](https://open-meteo.com/), licensed CC BY 4.0. The free API is for
non-commercial use (up to 10,000 calls a day; this plugin makes about 50).
Rain radar by [RainViewer](https://www.rainviewer.com/), free for personal and small community use.
Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
