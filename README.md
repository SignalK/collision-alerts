# Signal K Collision Alerts

Warns you when another vessel is on course to pass too close. For every AIS target in range (and every radar or camera target, on servers that merge them) the plugin works out the closest point of approach (CPA) and the time until it (TCPA), and raises a Signal K alarm when both fall inside your chosen limits. Chart plotters such as Freeboard-SK show the alarm, sound it, and let you acknowledge or silence it.

## Setup

Install the plugin from the App Store. A new installation starts on its own with the Coastal sensitivity; an installation you disabled earlier stays off until you enable it in its settings. To change the sensitivity, pick an **Alert sensitivity** there:

| Sensitivity       | Warn                       | Alarm                      |
| ----------------- | -------------------------- | -------------------------- |
| Harbour           | CPA ≤ 100 m within 5 min   | CPA ≤ 50 m within 2 min    |
| Coastal (default) | CPA ≤ 0.5 NM within 12 min | CPA ≤ 0.25 NM within 6 min |
| Offshore          | CPA ≤ 1 NM within 20 min   | CPA ≤ 0.5 NM within 10 min |
| Custom            | your own list of zones     |                            |

If you used the CPA calculation in **SK Derived Data**, turn it off there so you don't get every alarm twice.

## What it publishes

- `notifications.navigation.closestApproach.<target id>` on own vessel, one alarm per target, through the server's Notifications API so acknowledge and silence work from any app. The alarm's `data` carries `targetRef` (the target's Signal K context, e.g. `vessels.urn:mrn:imo:mmsi:244123456`), `source`, `cpa` (m), `tcpa` (s), `range` (m) and `cpaPositions`.
- `vessels.<target id>.navigation.closestApproach` `{distance, timeTo}` for each target in range (can be turned off).

An alarm escalates as soon as a target enters a stricter zone, and is held until the target is clearly outside it again, so a CPA hovering on a limit doesn't make the alarm flicker.

## Radar and other sensors

The plugin also evaluates radar and camera targets that sensor plugins publish as `targets.<type>:<id>` contexts (mayara does this for ARPA targets), so boats without AIS are covered too. When a fusion plugin such as Target Fusion links a target to the AIS vessel it is (`sameAs`), the two are one boat and raise one alarm, not two. The boat then moves with whichever sensor reported last, so radar keeps tracking it after its AIS falls silent. The alarm points at the AIS vessel when there is one, and otherwise at the target's context (`targets.radar:…`); `data.sources` lists every sensor that sees it.

Sensor plugins may also raise alarms of their own. While this plugin runs it sets `globalThis.__signalk_collisionAlerts = { evaluatesTargets: true }`, and the mayara plugin leaves radar alarms to it then, so a ship seen on radar does not alarm twice.

## Development

```shell
npm install
npm run build:all   # lint + format check, build, tests
```
