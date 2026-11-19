import type { Context, Delta, Path, Plugin, ServerAPI } from '@signalk/server-api'
import { DeltaAlarmSink, ManagedAlarmSink, type AlarmSink } from './alarms.js'
import { DriftDetector } from './drift.js'
import { MotionCheck } from './motion.js'
import { ClosestApproachPublisher } from './closestApproach.js'
import { Evaluator, positionTime, toTrack, type VesselNode } from './evaluator.js'
import { DEFAULTS, formSchema, formUiSchema, limitsFor, migrate, type Config } from './config.js'
import { targetNodes, type SensorTargetNode } from './targets.js'
import { regionChoices, SilentRegions } from './regions.js'

const PLUGIN_ID = 'collision-alerts'
// 1 while alarms are paused, 0 otherwise; a PUT of 1 pauses, 0 resumes.
const PAUSED_PATH = 'navigation.collisionAlerts.paused'
// Regions change only when someone edits them in a chart plotter.
const REGION_REFRESH_MS = 60_000
const NM = 1852
const KNOT = 1852 / 3600

// Sensor plugins that raise collision alarms of their own (mayara for radar
// targets) stand down while this property says so, so a target alarms once.
const COLLISION_ALERTS_PROPERTY = 'collisionAlerts'
interface CollisionAlertsProperty {
  evaluatesTargets: boolean
}

function createSink(app: ServerAPI): AlarmSink {
  try {
    // getId throws NotificationManagerDisabledError when the server leaves
    // notifications unmanaged; ack/silence then don't exist, so fall back.
    app.notifications.getId('probe' as Parameters<ServerAPI['notifications']['getId']>[0])
    return new ManagedAlarmSink(app)
  } catch {
    app.debug('Notification management unavailable, publishing notification deltas')
    return new DeltaAlarmSink(app, PLUGIN_ID)
  }
}

const WATCHING = 'Watching AIS, radar and other targets'

export default function (app: ServerAPI): Plugin {
  let timer: ReturnType<typeof setInterval> | undefined
  let regionTimer: ReturnType<typeof setInterval> | undefined
  // Epoch ms; kept across a restart of the plugin, not of the server.
  let pausedUntil = 0
  // The latest start()'s evaluation; a PUT runs it at once.
  let tick: (() => void) | undefined
  let evaluator: Evaluator | undefined
  const closestApproach = new ClosestApproachPublisher((context, value) => {
    const delta: Delta = {
      context: context as Context,
      updates: [{ values: [{ path: 'navigation.closestApproach' as Path, value }] }]
    }
    app.handleMessage(PLUGIN_ID, delta)
  })

  // PropertyValues keep every emitted value, so emit on changes only.
  let evaluatesTargets = false
  function announce(running: boolean): void {
    if (running === evaluatesTargets) {
      return
    }
    const value: CollisionAlertsProperty = { evaluatesTargets: running }
    try {
      app.emitPropertyValue(COLLISION_ALERTS_PROPERTY, value)
      evaluatesTargets = running
    } catch (err) {
      // The server caps PropertyValues across all plugins and throws past
      // the cap; sensor plugins then keep their own alarms, never fewer.
      app.error(`Could not announce collision alerts to other plugins: ${String(err)}`)
    }
  }

  return {
    id: PLUGIN_ID,
    name: 'Collision Alerts',
    description: 'CPA/TCPA collision alerts for AIS, radar and other targets',
    // The admin form lists the server's regions to choose from.
    schema: async () => {
      const saved = (app.readPluginOptions() as { configuration?: { silentRegions?: unknown } })
        .configuration?.silentRegions
      const chosen = Array.isArray(saved)
        ? saved.filter((id): id is string => typeof id === 'string')
        : []
      return formSchema(await regionChoices(app, chosen))
    },
    uiSchema: formUiSchema(),

    start(partial: object) {
      // Settings saved by 0.8 or earlier, saved once in the current form so
      // the admin form shows them.
      const migrated = migrate(partial, (dropped) => {
        const list = dropped.map((z) => `${z.level} ${z.cpa} m in ${z.tcpa} s`).join(', ')
        app.error(
          `Custom sensitivity converted to Along the coast with its lowest and highest zones; dropped: ${list}`
        )
      })
      if (migrated) {
        app.savePluginOptions(migrated, (err) => {
          if (err) app.error(`Could not save the converted settings: ${err.message}`)
        })
      }
      // The server does not apply schema defaults at runtime.
      const config: Config = { ...DEFAULTS, ...((migrated ?? partial) as Partial<Config>) }
      const maxAge = config.maxAgeMinutes * 60
      const limits = limitsFor(config)
      const harbour = limitsFor(config, 'harbour')
      const activeEvaluator = new Evaluator(
        {
          zones: limits.zones,
          slowZones: harbour.zones,
          passingDistance: limits.passingDistance,
          slowPassingDistance: harbour.passingDistance,
          slowSpeed: config.slowSpeed * KNOT,
          maxAlarms: config.maxAlarms,
          maxRange: config.maxRange * NM,
          maxAge
        },
        createSink(app)
      )
      evaluator = activeEvaluator
      const ownMotion = new MotionCheck()
      const ownDrift = new DriftDetector()
      const readsState = config.whileMoored !== 'normal' || config.whileAnchored !== 'normal'
      const silentRegions = new SilentRegions(app, config.silentRegions)
      if (config.silentRegions.length > 0) {
        const refresh = () => {
          void silentRegions.refresh()
        }
        refresh()
        regionTimer = setInterval(refresh, REGION_REFRESH_MS)
      }
      const publishPaused = (paused: boolean) => {
        app.handleMessage(PLUGIN_ID, {
          updates: [
            {
              values: [{ path: PAUSED_PATH as Path, value: paused ? 1 : 0 }],
              meta: [
                {
                  path: PAUSED_PATH as Path,
                  value: {
                    description: `1 while collision alarms are paused; PUT 1 to pause ${config.pauseMinutes} min, 0 to resume`
                  }
                }
              ]
            }
          ]
        })
      }
      app.registerPutHandler('vessels.self', PAUSED_PATH, (_context, _path, value) => {
        if (value !== 0 && value !== 1) {
          return { state: 'COMPLETED', statusCode: 400, message: 'Send 1 to pause, 0 to resume' }
        }
        pausedUntil = value === 1 ? Date.now() + config.pauseMinutes * 60_000 : 0
        publishPaused(value === 1)
        // Clear or bring back the alarms now, not at the next check.
        tick?.()
        return { state: 'COMPLETED', statusCode: 200 }
      })
      publishPaused(Date.now() < pausedUntil)
      let status: string | undefined
      const setStatus = (text: string) => {
        if (text !== status) {
          status = text
          app.setPluginStatus(text)
        }
      }

      const evaluate = () => {
        // One bad target or data-model surprise must not stop the alarm loop.
        try {
          const now = Date.now()
          const ownNode = { navigation: app.getSelfPath('navigation') as VesselNode['navigation'] }
          const time = positionTime(ownNode)
          const raw = toTrack(ownNode, now, maxAge)
          // Own ship yaws, drifts and swings at anchor like its neighbours;
          // judged alike, two boats lying together do not close on each other.
          const reported = raw && ownMotion.apply('self', raw, time)
          const own = reported && ownDrift.apply('self', reported, time)
          // Radar and camera targets linked to an AIS vessel fold into it, so
          // a boat seen on both raises one alarm rather than one per sensor.
          const vessels = targetNodes(
            (app.getPath('vessels') ?? {}) as Record<string, VesselNode>,
            app.getPath('targets') as Record<string, SensorTargetNode> | undefined,
            now
          )
          // Set by a plugin such as signalk-autostate, or by hand.
          const state = readsState
            ? (app.getSelfPath('navigation.state') as { value?: unknown } | undefined)?.value
            : undefined
          const moored = config.whileMoored === 'harbour' && state === 'moored'
          // Only while we lie still: a state left stale by its source must
          // not silence a boat under way.
          const quietState =
            own !== null &&
            own.sog === 0 &&
            ((config.whileMoored === 'silent' && state === 'moored') ||
              (config.whileAnchored === 'silent' && state === 'anchored'))
          const region = raw ? silentRegions.containing(raw.position) : undefined
          if (pausedUntil !== 0 && now >= pausedUntil) {
            pausedUntil = 0
            publishPaused(false)
          }
          const paused = pausedUntil !== 0
          const quiet = quietState || region !== undefined || paused
          const evaluations = activeEvaluator.evaluate(own, vessels, app.selfId, now, moored, quiet)
          setStatus(
            paused
              ? `Paused until ${new Date(pausedUntil).toTimeString().slice(0, 5)}`
              : region !== undefined
                ? `No alarms inside ${region}`
                : quietState
                  ? state === 'anchored'
                    ? 'No alarms while at anchor'
                    : 'No alarms while moored'
                  : WATCHING
          )
          if (config.publishClosestApproach) {
            closestApproach.publish(evaluations, own, now)
          }
        } catch (err) {
          app.error(`Collision evaluation failed: ${String(err)}`)
        }
      }
      tick = evaluate
      timer = setInterval(evaluate, config.interval * 1000)
      announce(true)
      setStatus(WATCHING)
    },

    stop() {
      clearInterval(timer)
      timer = undefined
      clearInterval(regionTimer)
      regionTimer = undefined
      tick = undefined
      evaluator?.stop()
      evaluator = undefined
      // Sensor plugins keep their own alarms off while we announce, so the
      // announcement must be withdrawn even if a clear fails.
      try {
        closestApproach.clearAll()
      } finally {
        announce(false)
      }
    }
  }
}
