import { Type, type Static } from 'typebox'
import { PRESETS } from './zones.js'

const ZoneSchema = Type.Object({
  level: Type.Enum(['alert', 'warn', 'alarm', 'emergency'], {
    type: 'string',
    title: 'Level',
    default: 'warn'
  }),
  cpa: Type.Number({ title: 'CPA at most (m)', minimum: 0, default: 926 }),
  tcpa: Type.Number({ title: 'Within (s)', minimum: 0, default: 720 })
})

export const ConfigSchema = Type.Object({
  // A plain string enum, not a union of literals: the admin UI's form renders
  // `enum` as a dropdown but shows no control for `anyOf` of `const`s.
  preset: Type.Enum(['harbour', 'coastal', 'offshore', 'custom'], {
    type: 'string',
    title: 'Alert sensitivity',
    description:
      'Harbour: warn at 100 m / 5 min, alarm at 50 m / 2 min. Coastal: warn at 0.5 NM / 12 min, alarm at 0.25 NM / 6 min. Offshore: warn at 1 NM / 20 min, alarm at 0.5 NM / 10 min.',
    default: 'coastal'
  }),
  customZones: Type.Array(ZoneSchema, {
    title: 'Custom zones (used when sensitivity is Custom)',
    default: PRESETS.coastal
  }),
  maxRange: Type.Number({
    title: 'Ignore targets farther than (NM)',
    minimum: 0,
    default: 12
  }),
  maxAge: Type.Number({
    title: 'Ignore target data older than (s)',
    description:
      'The default rides out two missed reports from an anchored Class A vessel (3 min interval) while still dropping vessels that left.',
    minimum: 1,
    default: 360
  }),
  interval: Type.Number({ title: 'Evaluate every (s)', minimum: 1, default: 2 }),
  publishClosestApproach: Type.Boolean({
    title: 'Publish navigation.closestApproach for each target',
    default: true
  })
})

export type Config = Static<typeof ConfigSchema>

// The server only uses schema defaults to seed the admin form; start()
// receives `{}` for a plugin that has never been configured.
export const DEFAULTS: Config = {
  preset: 'coastal',
  customZones: PRESETS.coastal,
  maxRange: 12,
  maxAge: 360,
  interval: 2,
  publishClosestApproach: true
}
