import { describe, expect, it } from 'vitest'
import { parseMaintenanceSchedule } from './maintenanceSchedule'

describe('parseMaintenanceSchedule', () => {
  it('reads the mainnet timer and page body', () => {
    expect(
      parseMaintenanceSchedule(
        {
          maintenance_timer: '2026-11-06T10:00:00Z',
          maintenance_scheduled_body: ' ',
          test_maintenance_scheduled_body: 'on',
        },
        'mainnet',
      ),
    ).toEqual({ startsAt: Date.parse('2026-11-06T10:00:00Z'), inProgress: false })
  })

  it('reads the keys of the other environments', () => {
    const settings = {
      rh_maintenance_timer: '2026-11-06T10:00:00Z',
      rh_maintenance_scheduled_body: 'Down',
      test_maintenance_timer: '2026-11-07T10:00:00Z',
      test_maintenance_scheduled_body: '',
    }
    expect(parseMaintenanceSchedule(settings, 'robinhood-mainnet')).toEqual({
      startsAt: Date.parse('2026-11-06T10:00:00Z'),
      inProgress: true,
    })
    expect(parseMaintenanceSchedule(settings, 'testnet')).toEqual({
      startsAt: Date.parse('2026-11-07T10:00:00Z'),
      inProgress: false,
    })
  })

  it('has no start for a blank or invalid timer', () => {
    expect(parseMaintenanceSchedule({ maintenance_timer: 'soon' }, 'mainnet')).toEqual({
      startsAt: null,
      inProgress: false,
    })
    expect(parseMaintenanceSchedule({}, 'mainnet').startsAt).toBeNull()
  })
})
