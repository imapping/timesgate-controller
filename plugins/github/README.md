# GitHub

Shows how your GitHub repositories are doing, and celebrates when something new happens.

- **Screen 1:** the repository and its stars, with "+N today" when it gained some.
- **Screen 2:** visitors over the last 14 days: the total, unique visitors and a daily bar chart.
- **Screen 3:** clones over the last 14 days.
- **Screen 4:** forks, watchers, open issues and pull requests, the last commit, and where most
  visitors came from.
- **Screen 5:** your contribution graph for the last 16 weeks (or the latest commit, without a token).

## Celebrations

It checks GitHub every 10 minutes, even when something else is on the screens. When a repository
gets a new **star**, **fork**, **issue** or **pull request**:
- it beeps and turns the edge light rainbow for a minute, on the Times Gates with alerts on;
- if GitHub is on the screens, screen 1 shows confetti and who did it, for 10 minutes.

Choose which events to celebrate, and how, in the card. **Test** tries it out. The buttons can
use `github.test` and `github.next` (next repository).

## Setup

1. Add a repository in the card: `owner/name`, or paste its GitHub link. Add as many as you like;
   with several, each gets a minute on the screens.
2. Optional, for visitors, clones and the contribution graph: create a
   [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new).
   - **Repository access:** your repositories (all, or just the ones you'll add).
   - **Permissions → Repository permissions → Administration:** Read-only. GitHub only shows
     traffic to people who can manage the repository, and this is the read-only permission for it.
   - Paste it into the card **on the PC** running the controller.

The token is saved in `data/github.json`, is only accepted from the PC, and is never sent to the
page. Without a token it uses GitHub's public API, which allows 60 requests an hour. That's enough
for about 3 repositories at one check every 10 minutes.

GitHub keeps traffic numbers for 14 days, and updates them a few times a day. It doesn't count
people who use **Download ZIP**.
