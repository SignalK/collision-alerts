# Signal K Collision Alerts

Warns you when another boat is on course to pass too close.

The plugin watches every AIS target around you, and radar or camera targets too. For each boat it works out how close it will pass and how soon. If a boat will come too close too soon, the plugin raises an alarm. Chart plotters such as Freeboard-SK show and sound it, and you can acknowledge or silence it from any app.

## Getting started

Install **Collision Alerts** from the App Store. It starts by itself with the Coastal limits. If it shows as off, enable it in its settings.

- **Using SK Derived Data for CPA?** Turn its CPA calculation off, or every alarm comes twice.
- **Had the older `signalk-collision-alerts` plugin?** Uninstall it, or every alarm comes twice. Its settings don't carry over.
- **Have radar or a camera?** Also install **Target Fusion** from the App Store. A boat seen on both AIS and radar then raises one alarm, not two.

## Choosing your limits

Pick an **Alert sensitivity** in the plugin settings:

| Sensitivity       | Warning if it will pass within | Alarm if it will pass within |
| ----------------- | ------------------------------ | ---------------------------- |
| Harbour           | 100 m in the next 5 min        | 50 m in the next 2 min       |
| Coastal (default) | 0.5 NM in the next 12 min      | 0.25 NM in the next 6 min    |
| Offshore          | 1 NM in the next 20 min        | 0.5 NM in the next 10 min    |
| Custom            | your own limits                |                              |

## What to expect

The plugin tries to alarm only when it matters:

- **In harbour.** While you and another boat are both slower than 3 kn, the Harbour limits apply. A boat you pass more than 100 m off stays quiet; closer than that, even a moored one can warn, and within 50 m alarm.
- **At your berth or at anchor.** While you are stopped, boats under 6 kn coming and going warn only within 100 m and alarm only within 50 m. Faster boats, such as ferries, keep your chosen limits.
- **Stopped boats.** A boat slower than 0.5 kn gets the Harbour limits, whatever your speed. Passing it more than 100 m off raises nothing. Heading straight for it warns about 5 minutes ahead.
- **Dragging anchor.** A boat that seems stopped but keeps moving in a straight line counts as moving once it has dragged about 60 m. A neighbour dragging towards you then warns, by the Harbour limits, about 5 minutes before it would reach you. The same goes for your own boat.
- **Overtaking.** A boat you slowly overtake raises only if it will pass within 100 m. One that turns into you still warns in good time.
- **Boats crossing behind you.** While you are under way, a boat that will cross your wake raises nothing, unless it will come within the alarm distance.
- **Between AIS reports.** Small boats report only every 30 s. In between, each boat is judged where it is by now, carried on along its course for up to a minute. A moving boat judged by the Harbour limits alarms only once a report puts it inside the alarm limits, or once its last report is 40 s old: it may be turning into its berth.
- **Busy waters.** At most 3 boats warn or alarm at once, the most urgent first. A warning that had to make room for a more urgent boat stays quiet for 2 minutes, unless it turns into an alarm or clears the limits and comes back.
- **No flicker.** An alarm stays on until the boat is clearly outside the limits again.

The 3 kn is the setting **Use Harbour limits when both boats are slower than**. Set it to 0 to turn off the harbour, berth, stopped-boat and overtaking rules above, so every boat gets your chosen limits. Boats crossing your wake still stay quiet. The 3 boats are the setting **Alarm for at most this many targets at once**.

## Radar alarms from mayara

A current mayara plugin leaves radar collision alarms to this plugin, so a boat seen on radar alarms once. With an older one, set its radar collision alarm setting to _Leave to the Collision Alerts plugin_.

## For app developers

Each alarm is a notification at `notifications.navigation.closestApproach.<target id>` on your own vessel, raised through the server's Notifications API, or as a plain notification delta on servers that don't manage notifications. Its `data` holds `targetRef` (the target's context, such as `vessels.urn:mrn:imo:mmsi:244123456` or `targets.radar:…`), `source`, `sources` (when radar or a camera sees the target), `cpa` (m), `tcpa` (s), `range` (m), `targetCog` (rad, `null` when stopped), `targetSog` (m/s) and `cpaPositions`. Each target in range also gets `navigation.closestApproach` `{ distance, timeTo }`, which can be turned off. Radar and camera targets are read from `targets.<type>:<id>` contexts. One whose `sameAs` names an AIS vessel joins it, and the alarm goes under the vessel's id. While the plugin runs, it emits the `collisionAlerts` PropertyValue `{ evaluatesTargets: true }`, and `{ evaluatesTargets: false }` when it stops, so sensor plugins can leave their alarms to it.
