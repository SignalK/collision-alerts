import { describe, expect, it } from 'vitest'
import { Value } from 'typebox/value'
import { ConfigSchema, DEFAULTS } from '../src/config.js'

describe('config schema', () => {
  // The admin UI renders a dropdown only for `enum`; `anyOf` of `const`s shows no control.
  it('offers the sensitivity and zone level as dropdown choices', () => {
    expect(ConfigSchema.properties.preset).toMatchObject({
      type: 'string',
      enum: ['harbour', 'coastal', 'offshore', 'custom']
    })
    expect(ConfigSchema.properties.customZones.items.properties.level).toMatchObject({
      type: 'string',
      enum: ['alert', 'warn', 'alarm', 'emergency']
    })
  })

  it('accepts the defaults and rejects an unknown sensitivity', () => {
    expect(Value.Check(ConfigSchema, DEFAULTS)).toBe(true)
    expect(Value.Check(ConfigSchema, { ...DEFAULTS, preset: 'river' })).toBe(false)
  })
})
