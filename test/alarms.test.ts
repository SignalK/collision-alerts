import { describe, expect, it, vi } from 'vitest'
import type { NotificationId, ServerAPI } from '@signalk/server-api'
import { sentValue, type HandleMessage } from './helpers.js'
import { DeltaAlarmSink, ManagedAlarmSink, type CollisionAlert } from '../src/alarms.js'

type NotificationsApi = ServerAPI['notifications']

const ID = 'urn:mrn:imo:mmsi:222222222'

function alert(level: CollisionAlert['level']): CollisionAlert {
  return {
    level,
    message: 'Collision risk',
    data: {
      targetRef: `vessels.${ID}`,
      source: 'ais',
      cpa: 100,
      tcpa: 60,
      range: 500,
      targetCog: null,
      targetSog: 0,
      cpaPositions: null
    }
  }
}

function fakeApp() {
  const notifications = {
    raise: vi.fn<NotificationsApi['raise']>(() => 'n1' as NotificationId),
    update: vi.fn<NotificationsApi['update']>(),
    clear: vi.fn<NotificationsApi['clear']>(),
    getId: vi.fn<NotificationsApi['getId']>()
  }
  const handleMessage = vi.fn<HandleMessage>()
  const app = { notifications, handleMessage } as unknown as ServerAPI
  return { app, notifications, handleMessage }
}

describe('ManagedAlarmSink', () => {
  it('raises once under the per-target path, then updates on level change', () => {
    const { app, notifications } = fakeApp()
    const sink = new ManagedAlarmSink(app, () => 0)
    sink.set(ID, alert('warn'))
    sink.set(ID, alert('warn'))
    sink.set(ID, alert('alarm'))
    expect(notifications.raise).toHaveBeenCalledOnce()
    expect(notifications.raise.mock.calls[0][0]).toMatchObject({
      state: 'warn',
      path: `navigation.closestApproach.${ID}`
    })
    expect(notifications.update).toHaveBeenCalledOnce()
    expect(notifications.update).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({ state: 'alarm' })
    )
  })

  it('refreshes unchanged data only after the refresh interval', () => {
    const { app, notifications } = fakeApp()
    let now = 0
    const sink = new ManagedAlarmSink(app, () => now)
    sink.set(ID, alert('warn'))
    now = 5_000
    sink.set(ID, alert('warn'))
    now = 11_000
    sink.set(ID, alert('warn'))
    expect(notifications.update).toHaveBeenCalledOnce()
  })

  it('raises again when its notification was removed by the server', () => {
    const { app, notifications } = fakeApp()
    notifications.update.mockImplementation(() => {
      throw new Error('Notification not found!')
    })
    const sink = new ManagedAlarmSink(app, () => 0)
    sink.set(ID, alert('warn'))
    sink.set(ID, alert('alarm'))
    expect(notifications.raise).toHaveBeenCalledTimes(2)
  })

  it('does not raise a second alarm while a failed update leaves the first standing', () => {
    const { app, notifications } = fakeApp()
    notifications.update.mockImplementation(() => {
      throw new Error('Notification options not supplied!')
    })
    notifications.getId.mockReturnValue({} as ReturnType<NotificationsApi['getId']>)
    const sink = new ManagedAlarmSink(app, () => 0)
    sink.set(ID, alert('warn'))
    sink.set(ID, alert('alarm'))
    expect(notifications.raise).toHaveBeenCalledOnce()
  })

  it('keeps a separate notification per target', () => {
    const { app, notifications } = fakeApp()
    const second = 'urn:mrn:imo:mmsi:333333333'
    notifications.raise.mockImplementation(({ path }) => `id:${String(path)}` as NotificationId)
    const sink = new ManagedAlarmSink(app, () => 0)
    sink.set(ID, alert('alarm'))
    sink.set(second, alert('warn'))
    expect(notifications.raise.mock.calls.map(([options]) => options.path)).toEqual([
      `navigation.closestApproach.${ID}`,
      `navigation.closestApproach.${second}`
    ])

    sink.set(second, alert('alarm'))
    expect(notifications.update).toHaveBeenCalledWith(
      `id:navigation.closestApproach.${second}`,
      expect.objectContaining({ state: 'alarm' })
    )

    sink.set(ID, undefined)
    expect(notifications.clear.mock.calls).toEqual([[`id:navigation.closestApproach.${ID}`]])
    sink.clearAll()
    expect(notifications.clear).toHaveBeenLastCalledWith(`id:navigation.closestApproach.${second}`)
  })

  it('clears on release and on clearAll', () => {
    const { app, notifications } = fakeApp()
    const sink = new ManagedAlarmSink(app, () => 0)
    sink.set(ID, alert('warn'))
    sink.set(ID, undefined)
    expect(notifications.clear).toHaveBeenCalledWith('n1')
    sink.set(ID, alert('warn'))
    sink.clearAll()
    expect(notifications.clear).toHaveBeenCalledTimes(2)
  })
})

describe('DeltaAlarmSink', () => {
  it('emits a notification delta that older consumers can resolve', () => {
    const { app, handleMessage } = fakeApp()
    const sink = new DeltaAlarmSink(app, 'plugin', () => 0)
    sink.set(ID, alert('alarm'))
    sink.set(ID, undefined)
    const raised = sentValue(handleMessage, 0)
    expect(raised.path).toBe(`notifications.navigation.closestApproach.${ID}`)
    expect(raised.value).toMatchObject({ state: 'alarm', other: `vessels.${ID}` })
    expect(sentValue(handleMessage, 1).value).toMatchObject({ state: 'normal' })
  })
})
