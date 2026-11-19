import { Type, type Static } from 'typebox'
import { PASSING_DISTANCE, PRESETS, SEVERITY, type PresetName, type Zone } from './zones.js'

const MODES: PresetName[] = ['harbour', 'coastal', 'offshore']
const MODE_NAMES: Record<PresetName, string> = {
  harbour: 'In harbour',
  coastal: 'Along the coast',
  offshore: 'Offshore'
}

function zone(preset: PresetName, level: 'warn' | 'alarm'): Zone {
  const found = PRESETS[preset].find((z) => z.level === level)
  if (!found) throw new Error(`No ${level} zone in the ${preset} preset`)
  return found
}

function limitsSchema(preset: PresetName) {
  const warn = zone(preset, 'warn')
  const alarm = zone(preset, 'alarm')
  const number = (title: string, value: number, unit: string) =>
    Type.Number({ title, description: `(Default: ${value} ${unit})`, minimum: 0, default: value })
  return Type.Object(
    {
      warnDistance: number(
        '• When a boat will cross ahead of you closer than X metres',
        warn.cpa,
        'm'
      ),
      warnMinutes: number('• X minutes before it crosses', warn.tcpa / 60, 'min'),
      alarmDistance: number(
        '• When a boat will cross ahead of you closer than X metres',
        alarm.cpa,
        'm'
      ),
      alarmMinutes: number('• X minutes before it crosses', alarm.tcpa / 60, 'min'),
      passingDistance: number(
        '• When a boat will pass alongside you closer than X metres',
        PASSING_DISTANCE[preset],
        'm'
      )
    },
    // No title: the form then shows no heading over these numbers.
    { title: '', default: defaultLimits(preset) }
  )
}

/** One sensitivity's numbers, in metres and minutes. */
export interface Limits {
  warnDistance: number
  warnMinutes: number
  alarmDistance: number
  alarmMinutes: number
  passingDistance: number
}
const LIMIT_KEYS: (keyof Limits)[] = [
  'warnDistance',
  'warnMinutes',
  'alarmDistance',
  'alarmMinutes',
  'passingDistance'
]

function defaultLimits(preset: PresetName): Limits {
  const warn = zone(preset, 'warn')
  const alarm = zone(preset, 'alarm')
  return {
    warnDistance: warn.cpa,
    warnMinutes: warn.tcpa / 60,
    alarmDistance: alarm.cpa,
    alarmMinutes: alarm.tcpa / 60,
    passingDistance: PASSING_DISTANCE[preset]
  }
}

export const ConfigSchema = Type.Object({
  // A plain string enum, not a union of literals: the admin UI's form renders
  // `enum` as a dropdown but shows no control for `anyOf` of `const`s.
  preset: Type.Enum(MODES, {
    type: 'string',
    title: 'Sailing area',
    description:
      '(There are two kinds of notification, by how serious the risk is: first a **WARNING**, then an **ALARM** when the boat comes closer. Each area has its own distances and times for both. You can change them below.)',
    enumNames: MODES.map((m) => MODE_NAMES[m]),
    default: 'coastal'
  }),
  harbour: limitsSchema('harbour'),
  coastal: limitsSchema('coastal'),
  offshore: limitsSchema('offshore'),
  whileMoored: Type.Enum(['normal', 'harbour', 'silent'], {
    type: 'string',
    title: '• When you are moored at your berth',
    description: '*(Your boat is stopped and the signalk-autostate plugin reports it as moored.)*',
    enumNames: ['Alarms as usual', 'Only for boats coming straight at you', 'No alarms'],
    default: 'normal'
  }),
  whileAnchored: Type.Enum(['normal', 'silent'], {
    type: 'string',
    title: '• When you are at anchor',
    description:
      '*(Your boat is stopped and reported as anchored. Careful: with no alarms, a boat dragging onto you raises none either.)*',
    enumNames: ['Alarms as usual', 'No alarms'],
    default: 'normal'
  }),
  silentRegions: Type.Array(Type.String(), {
    title: '• When you are inside any of these regions',
    description:
      '*(Regions are areas you draw on the chart in Freeboard. Draw one around each marina you use, entrance included: while you are inside it, you get no notifications, neither from your own movement nor from boats heading towards you.)*',
    uniqueItems: true,
    default: []
  }),
  pauseMinutes: Type.Number({
    title: '• Pause button: stop all alarms for X minutes',
    description:
      '*(A switch in KIP, or a voice command, on* `navigation.collisionAlerts.paused`*: 1 pauses, 0 resumes. Alarms come back by themselves.)*',
    minimum: 1,
    default: 30
  }),
  slowSpeed: Type.Number({
    title: '• Use the harbour distances when both boats are slower than X knots',
    description: '*(Default: 3 kn. 0 turns this off.)*',
    minimum: 0,
    default: 3
  }),
  maxAlarms: Type.Integer({
    title: '• No more than X boats raising alarms at the same time',
    description: '*(The most urgent ones. Default: 3)*',
    minimum: 1,
    maximum: 5,
    default: 3
  }),
  maxRange: Type.Number({
    title: '• Ignore boats farther away than X nautical miles',
    description: '*(Default: 12 NM)*',
    minimum: 0,
    default: 12
  }),
  maxAgeMinutes: Type.Number({
    title: '• Stop tracking a boat after X minutes without data from it',
    description: '*(Default: 6 min)*',
    minimum: 0.1,
    default: 6
  }),
  interval: Type.Number({
    title: '• Check for collision risk every X seconds',
    description: '*(Default: 2 s)*',
    minimum: 1,
    default: 2
  }),
  publishClosestApproach: Type.Boolean({
    title: "Send each boat's closest approach to chart apps such as Freeboard",
    default: true
  })
})

export type Config = Static<typeof ConfigSchema>

// The server only uses schema defaults to seed the admin form; start()
// receives `{}` for a plugin that has never been configured.
export const DEFAULTS: Config = {
  preset: 'coastal',
  harbour: defaultLimits('harbour'),
  coastal: defaultLimits('coastal'),
  offshore: defaultLimits('offshore'),
  whileMoored: 'normal',
  whileAnchored: 'normal',
  silentRegions: [],
  pauseMinutes: 30,
  slowSpeed: 3,
  maxAlarms: 3,
  maxRange: 12,
  maxAgeMinutes: 6,
  interval: 2,
  publishClosestApproach: true
}

/** The zones and passing distance the evaluator gets for a sensitivity. */
export function limitsFor(
  config: Config,
  preset: PresetName = config.preset
): { zones: Zone[]; passingDistance: number } {
  const limits = { ...DEFAULTS[preset], ...config[preset] }
  return {
    zones: [
      { level: 'warn', cpa: limits.warnDistance, tcpa: limits.warnMinutes * 60 },
      { level: 'alarm', cpa: limits.alarmDistance, tcpa: limits.alarmMinutes * 60 }
    ],
    passingDistance: limits.passingDistance
  }
}

/** Settings up to 0.8, read once and saved in the current form. */
interface OldSettings {
  preset?: string
  customZones?: Zone[]
  customPassingDistance?: number
  harbourLimitsWhenMoored?: boolean
  noAlarmsWhenAnchored?: boolean
  maxAge?: number
}

/**
 * The saved settings in the current form, or undefined if they already are.
 * A Custom sensitivity becomes Along the coast with its numbers: the lowest
 * level zone gives the warning, the highest the alarm. Zones in between have
 * no place in the new settings: they are dropped and passed to `onDropped`.
 */
export function migrate(saved: object, onDropped?: (zones: Zone[]) => void): object | undefined {
  const {
    customZones,
    customPassingDistance,
    harbourLimitsWhenMoored,
    noAlarmsWhenAnchored,
    maxAge,
    ...current
  } = saved as OldSettings & Record<string, unknown>
  const old = [
    customZones,
    customPassingDistance,
    harbourLimitsWhenMoored,
    noAlarmsWhenAnchored,
    maxAge
  ]
  if (current.preset !== 'custom' && old.every((value) => value === undefined)) return undefined
  const result: Record<string, unknown> = { ...current }
  if (current.preset === 'custom') {
    const zones = [...(customZones ?? PRESETS.coastal)].sort(
      (a, b) => SEVERITY[a.level] - SEVERITY[b.level]
    )
    const warn = zones[0] ?? zone('coastal', 'warn')
    const alarm = zones[zones.length - 1] ?? zone('coastal', 'alarm')
    if (zones.length > 2) onDropped?.(zones.slice(1, -1))
    result.preset = 'coastal'
    result.coastal = {
      warnDistance: warn.cpa,
      warnMinutes: warn.tcpa / 60,
      alarmDistance: alarm.cpa,
      alarmMinutes: alarm.tcpa / 60,
      passingDistance: customPassingDistance ?? PASSING_DISTANCE.coastal
    }
  }
  if (harbourLimitsWhenMoored && current.whileMoored === undefined) {
    result.whileMoored = 'harbour'
  }
  if (noAlarmsWhenAnchored && current.whileAnchored === undefined) {
    result.whileAnchored = 'silent'
  }
  if (typeof maxAge === 'number' && current.maxAgeMinutes === undefined) {
    result.maxAgeMinutes = maxAge / 60
  }
  return result
}

// The admin form: headings between the groups of settings, and only the
// chosen sensitivity's numbers, right below it. The form shows the
// description of a heading or a checkbox as plain text, without markdown.
// A heading with no `before` goes last, right above the form's Save button.
const HEADINGS: Record<string, { title: string; description: string; before?: keyof Config }> = {
  area: {
    title: 'Where do you sail? Choose your sailing area',
    description: '',
    before: 'preset'
  },
  quietTimes: {
    title: 'When should alarms be quiet?',
    description:
      '(Alarms are always on unless you choose otherwise here. To silence a marina, draw it as a region in Freeboard, covering its entrance too: it will then appear here.)',
    before: 'whileMoored'
  },
  advanced: {
    title: 'Advanced settings',
    description: '(For experienced users. Change them with care.)',
    before: 'slowSpeed'
  },
  integration: {
    title: 'Integration with other apps',
    description: '',
    before: 'publishClosestApproach'
  },
  save: {
    title: '',
    description: 'Remember to press Save Configuration: changes take effect only once saved.'
  }
}

function heading(name: string): object {
  const { title, description } = HEADINGS[name]
  return { type: 'object', title, description, properties: {} }
}

/**
 * The schema the admin form gets. The form appends a `dependencies` branch's
 * fields after the others and rejects a `ui:order` naming a field it does
 * not show, so every branch carries all the other fields too, in order, each
 * branch its own copy: the server stores the schema as JSON, and the plugin
 * CI rejects an object reachable twice. Hidden fields keep their values.
 */
export function formSchema(regions?: { enum: string[]; enumNames: string[] }): object {
  const schema = JSON.parse(JSON.stringify(ConfigSchema)) as {
    properties: Record<string, Record<string, unknown>>
  }
  const properties = schema.properties
  for (const preset of MODES) {
    const limits = properties[preset] as {
      properties: Record<string, unknown>
      required?: string[]
    }
    // Every number has a default, so the form need not star them as required.
    delete limits.required
    // The warning numbers and the alarm numbers in two titled groups.
    const { warnDistance, warnMinutes, ...alarm } = limits.properties
    limits.properties = {
      warnGroup: { type: 'null', title: 'A: WARNING' },
      warnDistance,
      warnMinutes,
      alarmSpace: { type: 'null', title: ' ' },
      alarmGroup: { type: 'null', title: 'B: ALARM' },
      ...alarm
    }
  }
  if (regions) {
    properties.silentRegions.items = { type: 'string', ...regions }
  } else {
    delete properties.silentRegions
  }
  const others: [string, unknown][] = []
  for (const [key, value] of Object.entries(properties)) {
    if (key === 'preset' || (MODES as string[]).includes(key)) continue
    for (const [name, { before }] of Object.entries(HEADINGS)) {
      if (key === before) others.push([name, heading(name)])
    }
    others.push([key, value])
  }
  for (const [name, { before }] of Object.entries(HEADINGS)) {
    if (before === undefined) others.push([name, heading(name)])
  }
  return {
    ...schema,
    // Every setting has a default, so the form need not star any as required.
    required: [],
    properties: { area: heading('area'), preset: properties.preset },
    dependencies: {
      preset: {
        oneOf: MODES.map((preset) => ({
          properties: {
            preset: { enum: [preset] },
            [preset]: structuredClone(properties[preset]),
            ...structuredClone(Object.fromEntries(others))
          }
        }))
      }
    }
  }
}

/** Bold text and code in every description of the admin form. */
export function formUiSchema(): object {
  const markdown = { 'ui:enableMarkdownInDescription': true }
  const ui: Record<string, object> = {}
  for (const key of [...Object.keys(ConfigSchema.properties), ...Object.keys(HEADINGS)]) {
    ui[key] = { ...markdown }
  }
  for (const preset of MODES) {
    ui[preset] = {
      ...markdown,
      ...Object.fromEntries(LIMIT_KEYS.map((key) => [key, markdown]))
    }
  }
  ui.silentRegions = { ...markdown, 'ui:widget': 'checkboxes' }
  // The heading above already asks for it.
  ui.preset = { ...markdown, 'ui:options': { label: false } }
  return ui
}
