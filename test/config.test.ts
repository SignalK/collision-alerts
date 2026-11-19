import { describe, expect, it } from 'vitest'
import { Value } from 'typebox/value'
import { ConfigSchema, DEFAULTS, formSchema, limitsFor, migrate } from '../src/config.js'

describe('config schema', () => {
  // The admin UI renders a dropdown only for `enum`; `anyOf` of `const`s shows no control.
  it('offers the sensitivity and the berth choice as dropdowns with readable names', () => {
    expect(ConfigSchema.properties.preset).toMatchObject({
      type: 'string',
      enum: ['harbour', 'coastal', 'offshore'],
      enumNames: ['In harbour', 'Along the coast', 'Offshore']
    })
    expect(ConfigSchema.properties.whileMoored).toMatchObject({
      type: 'string',
      enum: ['normal', 'harbour', 'silent']
    })
  })

  it('accepts the defaults and rejects an unknown sensitivity', () => {
    expect(Value.Check(ConfigSchema, DEFAULTS)).toBe(true)
    expect(Value.Check(ConfigSchema, { ...DEFAULTS, preset: 'custom' })).toBe(false)
  })

  it('gives the evaluator the numbers of each sensitivity, in seconds', () => {
    expect(limitsFor(DEFAULTS)).toEqual({
      zones: [
        { level: 'warn', cpa: 926, tcpa: 720 },
        { level: 'alarm', cpa: 463, tcpa: 360 }
      ],
      passingDistance: 50
    })
    expect(limitsFor(DEFAULTS, 'harbour').passingDistance).toBe(15)
  })
})

describe('settings saved by 0.8', () => {
  it('leaves current settings alone', () => {
    expect(migrate({})).toBeUndefined()
    expect(migrate({ preset: 'harbour', maxAgeMinutes: 3 })).toBeUndefined()
  })

  it('turns Custom into Along the coast with its numbers, in minutes', () => {
    expect(
      migrate({
        preset: 'custom',
        customZones: [
          { level: 'alarm', cpa: 15, tcpa: 30 },
          { level: 'warn', cpa: 25, tcpa: 30 }
        ],
        customPassingDistance: 10,
        maxRange: 2
      })
    ).toEqual({
      preset: 'coastal',
      coastal: {
        warnDistance: 25,
        warnMinutes: 0.5,
        alarmDistance: 15,
        alarmMinutes: 0.5,
        passingDistance: 10
      },
      maxRange: 2
    })
  })

  it('reports the zones in between a Custom list of three or more', () => {
    const dropped: unknown[] = []
    const out = migrate(
      {
        preset: 'custom',
        customZones: [
          { level: 'emergency', cpa: 10, tcpa: 30 },
          { level: 'warn', cpa: 50, tcpa: 120 },
          { level: 'alarm', cpa: 25, tcpa: 60 }
        ]
      },
      (zones) => dropped.push(...zones)
    ) as { coastal: { warnDistance: number; alarmDistance: number } }
    expect(out.coastal.warnDistance).toBe(50)
    expect(out.coastal.alarmDistance).toBe(10)
    expect(dropped).toEqual([{ level: 'alarm', cpa: 25, tcpa: 60 }])
  })

  it('drops the zones of another sensitivity and converts the switches and the data age', () => {
    expect(
      migrate({
        preset: 'offshore',
        customZones: [],
        harbourLimitsWhenMoored: true,
        noAlarmsWhenAnchored: true,
        maxAge: 180
      })
    ).toEqual({
      preset: 'offshore',
      whileMoored: 'harbour',
      whileAnchored: 'silent',
      maxAgeMinutes: 3
    })
  })
})

describe('admin form', () => {
  interface Branch {
    properties: { preset: { enum: string[] } } & Record<string, unknown>
  }
  const branches = (regions?: { enum: string[]; enumNames: string[] }) =>
    (formSchema(regions) as { dependencies: { preset: { oneOf: Branch[] } } }).dependencies.preset
      .oneOf
  const fieldsFor = (preset: string) =>
    Object.keys(branches().find((b) => b.properties.preset.enum[0] === preset)?.properties ?? {})

  it("shows only the chosen sensitivity's numbers, right below it, then the headed groups", () => {
    for (const preset of ['harbour', 'coastal', 'offshore']) {
      const fields = fieldsFor(preset)
      expect(fields.slice(0, 3)).toEqual(['preset', preset, 'quietTimes'])
      expect(fields.filter((f) => ['harbour', 'coastal', 'offshore'].includes(f))).toEqual([preset])
      expect(fields.indexOf('advanced')).toBe(fields.indexOf('slowSpeed') - 1)
    }
  })

  it('lists the regions to choose from, or leaves the choice out when there are none', () => {
    const regions = { enum: ['h'], enumNames: ['Home port'] }
    for (const branch of branches(regions)) {
      expect(branch.properties.silentRegions).toMatchObject({
        items: { type: 'string', ...regions }
      })
    }
    for (const branch of branches()) {
      expect(branch.properties.silentRegions).toBeUndefined()
    }
  })

  it('reaches no object twice, as the plugin CI requires', () => {
    const seen = new Set<object>()
    const walk = (node: unknown) => {
      if (node === null || typeof node !== 'object') return
      expect(seen.has(node)).toBe(false)
      seen.add(node)
      Object.values(node).forEach(walk)
    }
    walk(formSchema({ enum: ['h'], enumNames: ['Home port'] }))
  })
})
