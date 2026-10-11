# Signal K Collision Alerts

Signal K server plugin that raises collision alarms. It evaluates AIS vessels
(`vessels.*`) and radar/camera targets (`targets.*`), following the `sameAs`
links a fusion plugin (signalk-target-fusion) sets, so one ship seen by several
sensors raises one alarm.

## Module map (`src/`)

- `index.ts` — plugin lifecycle; evaluation timer; `navigation.closestApproach`
  publishing; picks the alarm sink.
- `config.ts` — TypeBox `ConfigSchema` (admin form and TS type in one) and
  `DEFAULTS`.
- `cpa.ts` — pure CPA/TCPA maths (constant velocity, local tangent plane).
- `zones.ts` — sensitivity presets and `assess()`, the level decision with
  hysteresis.
- `evaluator.ts` — reads the data model, keeps per-target levels, drives a sink.
- `targets.ts` — folds `targets.*` contexts (radar, camera; the server's
  sensor-targets convention) into the evaluator's input: a target with
  `sameAs` joins the context it names, the rest become objects of their own,
  each moving with its most recently reported member.
- `alarms.ts` — `ManagedAlarmSink` (v2 Notifications API) and `DeltaAlarmSink`
  (plain notification deltas when the server does not manage notifications).

## Contracts other software depends on

- **Alarm path and shape.** One alarm per target at
  `notifications.navigation.closestApproach.<targetId>` with
  `data: { targetRef, source, cpa, tcpa, range, cpaPositions }`. Radar and
  camera sources are meant to publish the same shape, and Freeboard-SK locates
  the target through `data.targetRef`. Changing it is a breaking change.
- **`globalThis.__signalk_collisionAlerts`** is `{ evaluatesTargets: true }`
  from `start()` until `stop()`. Sensor plugins with alarms of their own (the
  mayara plugin) stand down while it is set; removing or renaming it brings
  back duplicate radar alarms.
- **Alarms go through `app.notifications`** whenever the server manages
  notifications, so acknowledge/silence/clear work from every client. The delta
  fallback also sets the legacy `other` field for older consumers.

## Gotchas

- **Schema defaults are not applied at runtime.** `start()` receives `{}` for a
  plugin that was never configured; always merge `DEFAULTS` under the config.
- **No install scripts.** The app store installs with `--ignore-scripts`; keep
  runtime dependencies pure JS (today: `typebox` only).
- **ESM.** Relative imports carry the `.js` extension (nodenext module
  resolution); the entry is `export default function (app)`.
- **Clear what you raise.** Every path that stops tracking a target (lost,
  stale, out of range, own ship stale, `stop()`) must release its alarm, or a
  stale alarm sounds forever.

## Commands

- `npm run format` — prettier + eslint --fix
- `npm run ci-lint` — read-only lint + format check (what CI runs)
- `npm run typecheck` — tsc over `src/` and `test/`
- `npm run build` — tsc → `plugin/`
- `npm test` — vitest
- `npm run build:all` — all of the above, run before every commit

## Workflow

- Conventional commits and PR titles: `<type>(<scope>): <subject>`; PR titles
  become the generated release notes.
- One logical change per PR. Never bump the version in a feature PR.
- Branch names use hyphens, no `/`.
- No AI attribution in commits or PRs: no `Co-Authored-By` trailers, no
  "generated with" footers.
- **Squash-merge PRs.** The release gate reads commit subjects, so the PR
  title must be the commit subject on `main`.
- **Releases are release-please.** Releasable merges (`feat`, `fix`, `perf`,
  `revert`, `type!`, `build(deps)`) update a standing `chore: release X.Y.Z`
  PR; merging it tags, creates the GitHub Release, and dispatches
  `publish.yml`, which validates strict semver and publishes to npm via OIDC
  trusted publishing (no `NPM_TOKEN`). Never edit the version by hand; steer
  an off-policy bump with an empty commit carrying a `Release-As: X.Y.Z`
  footer. There is no `CHANGELOG.md`: the Releases page is the changelog.
- **Lint workflows with `actionlint`** (CI does). Actions expressions have no
  `split()`; do string work in a `run:` step.
- **Typecheck tests too.** Vitest only transpiles; `npm run typecheck` covers
  `test/`, which the build's `tsc` does not.
