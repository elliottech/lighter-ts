import { describe, expect, it } from 'vitest'

import { transformWsMessage } from './transformWsMessage'

describe('transformWsMessage', () => {
  it.each(['subscribed/account_all_positions_fe', 'update/account_all_positions_fe'])(
    'defaults a missing bo_positions to an empty map for %s',
    (type) => {
      const message = transformWsMessage({
        type,
        channel: 'account_all_positions:1',
        positions: {},
        shares: [],
      })

      expect(message).toMatchObject({ bo_positions: {} })
    },
  )
})
