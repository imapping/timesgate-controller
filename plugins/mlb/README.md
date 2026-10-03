# Baseball (MLB)

Live-ish scores for your MLB team (the Dodgers to start with), from MLB's public stats feed
(statsapi.mlb.com). No account or key is needed.

During a game:
- **Screen 1:** the away team and its runs.
- **Screen 2:** the home team and its runs ("yours" marks your team).
- **Screen 3:** the inning, the runners on base, the outs and the count.
- **Screen 4:** who's batting and who's pitching.
- **Screen 5:** runs, hits and errors for both teams.

Before a game it shows the teams, when the first pitch is (in your own time) and the series; after
it, the final score and the next game.

It checks every 30 seconds during a game (so it's up to about a minute behind the broadcast), every
couple of minutes in the half hour before one, and every 20 minutes otherwise, even when something
else is on the screens.

Options in the card:
- **Your team.**
- **When your team scores or wins:** a beep and/or the rainbow edge light (on the Times Gates with
  alerts on). **Test** tries it.
- **Put it on the Times Gate when a game starts.**

Buttons can use `mlb.check` and `mlb.test`.

MLB's data is for personal, non-commercial use, as the copyright line in its replies says.