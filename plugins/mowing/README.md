# Mowing

Shows which lawns and areas of your property are due for mowing, from
[Mowing Tracker](https://www.mowingtracker.com), using its read-only status API.

- **Screen 1:** a map of the property: its photo, with each area's outline filled in its status
  colour (red overdue, amber due today or tomorrow, green up to date, grey never mowed).
- **Screens 2–3:** the area to mow next, and how overdue it is.
- **Screen 4:** how many areas are overdue, due soon and up to date.
- **Screen 5:** the next few areas after that, and when anything was last mowed.

The card lists every area with its status, when it was last mowed and how often it should be.

## Setup

1. On mowingtracker.com, open **Setup** and create an API key. It's shown only once, so copy it then.
2. Paste it into the Mowing card **on the computer running the controller** (or one it trusts), and
   click **Save key**. It's checked with Mowing Tracker before it's saved.

The key is saved in `data/mowing.json`, is only accepted from the controller's computer or a trusted
one, and is never sent to the page. The API is read-only: nothing in Mowing Tracker can be changed
from here, and it never includes notes or mowing history.

It checks every 10 minutes (the status only changes a few times a day). **Check now** checks
straight away, and buttons can use `mowing.check`.
