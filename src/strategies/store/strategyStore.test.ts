import type {
  AdvancedTwapConfig,
  StrategyRecord,
  StrategyStatus,
  TwapProgress,
  TwapStrategyRecord,
} from '../engine/types'
import { beforeEach, describe, expect, it } from 'vitest'

import { wsOrder, wsWorkingOrders } from '../engine/testUtils'
import { pruneHistory, useStrategyStore } from './strategyStore'

const config = (accountIndex = 0): AdvancedTwapConfig => ({
  accountIndex,
  marketId: 1,
  isAsk: 0,
  totalSize: 0.001,
  sliceCount: 3,
  baseIntervalMs: 1000,
  intervalJitter: 0,
  sizeJitter: 0,
  reduceOnly: false,
  maxSlippagePct: 1,
})

const progress = (status: StrategyStatus): TwapProgress => ({
  status,
  totalBaseAmount: 0,
  filledBaseAmount: 0,
  filledQuoteAmount: 0,
  makerBaseAmount: 0,
  failedBaseAmount: 0,
  consumedSlices: 0,
  nextActionAt: null,
})

const rec = (
  id: string,
  status: StrategyStatus,
  createdAt: number,
  accountIndex = 0,
): TwapStrategyRecord => ({
  id,
  kind: 'advanced-twap',
  config: config(accountIndex),
  progress: progress(status),
  createdAt,
  workingOrders: {},
})

describe('pruneHistory', () => {
  it('returns the same reference when under the cap (no-op)', () => {
    const map = {
      a: rec('a', 'completed', 1),
      b: rec('b', 'aborted', 2),
      c: rec('c', 'running', 3),
    }
    expect(pruneHistory(map)).toBe(map)
  })

  it('keeps every running record regardless of how many there are', () => {
    const map: Record<string, StrategyRecord> = {}
    for (let i = 0; i < 100; i++) {
      map[`r${i}`] = rec(`r${i}`, 'running', i)
    }
    const result = pruneHistory(map)
    expect(Object.keys(result)).toHaveLength(100)
  })

  it('caps terminal records at MAX_HISTORY_RECORDS (= 50), keeping the newest', () => {
    const map: Record<string, StrategyRecord> = {}
    // 60 completed records with increasing createdAt; the newest 50 should win.
    for (let i = 0; i < 60; i++) {
      map[`c${i}`] = rec(`c${i}`, 'completed', i)
    }
    const result = pruneHistory(map)
    expect(Object.keys(result)).toHaveLength(50)
    // newest 50 (createdAt 10..59) survive; oldest 10 (0..9) are dropped.
    for (let i = 10; i < 60; i++) expect(result[`c${i}`]).toBeDefined()
    for (let i = 0; i < 10; i++) expect(result[`c${i}`]).toBeUndefined()
  })

  it('mixed running + terminal: only terminal is pruned, running passes through', () => {
    const map: Record<string, StrategyRecord> = {}
    for (let i = 0; i < 60; i++) {
      map[`c${i}`] = rec(`c${i}`, 'completed', i)
    }
    map.r1 = rec('r1', 'running', 1_000)
    map.r2 = rec('r2', 'running', 1_001)

    const result = pruneHistory(map)
    expect(Object.keys(result)).toHaveLength(52) // 50 terminal + 2 running
    expect(result.r1).toBeDefined()
    expect(result.r2).toBeDefined()
  })

  it('mixes completed + aborted in the same terminal pool', () => {
    const map: Record<string, StrategyRecord> = {}
    for (let i = 0; i < 30; i++) {
      map[`c${i}`] = rec(`c${i}`, 'completed', i)
    }
    for (let i = 0; i < 30; i++) {
      map[`a${i}`] = rec(`a${i}`, 'aborted', 100 + i)
    }
    const result = pruneHistory(map)
    expect(Object.keys(result)).toHaveLength(50)
    // aborted are all newer (100..129); completed are older (0..29). The
    // newest 50 = all 30 aborted + 20 newest completed (10..29).
    for (let i = 0; i < 30; i++) expect(result[`a${i}`]).toBeDefined()
    for (let i = 10; i < 30; i++) expect(result[`c${i}`]).toBeDefined()
    for (let i = 0; i < 10; i++) expect(result[`c${i}`]).toBeUndefined()
  })

  it('caps terminal records per account, independently of other accounts', () => {
    const map: Record<string, StrategyRecord> = {}
    for (let i = 0; i < 60; i++) {
      map[`a${i}`] = rec(`a${i}`, 'completed', i, 1)
      map[`b${i}`] = rec(`b${i}`, 'completed', i, 2)
    }
    const result = pruneHistory(map)
    expect(Object.keys(result)).toHaveLength(100)
    for (let i = 10; i < 60; i++) {
      expect(result[`a${i}`]).toBeDefined()
      expect(result[`b${i}`]).toBeDefined()
    }
    for (let i = 0; i < 10; i++) {
      expect(result[`a${i}`]).toBeUndefined()
      expect(result[`b${i}`]).toBeUndefined()
    }
  })

  it('caps terminal records across accounts at 200, keeping the newest', () => {
    const map: Record<string, StrategyRecord> = {}
    for (let account = 0; account < 5; account++) {
      for (let i = 0; i < 50; i++) {
        const id = `${account}-${i}`
        map[id] = rec(id, 'completed', account * 100 + i, account)
      }
    }
    const result = pruneHistory(map)
    expect(Object.keys(result)).toHaveLength(200)
    for (let i = 0; i < 50; i++) expect(result[`0-${i}`]).toBeUndefined()
    for (let i = 0; i < 50; i++) expect(result[`4-${i}`]).toBeDefined()
  })

  it('keeps the active account history when the cross-account cap applies', () => {
    const map: Record<string, StrategyRecord> = {}
    for (let account = 0; account < 5; account++) {
      for (let i = 0; i < 50; i++) {
        const id = `${account}-${i}`
        map[id] = rec(id, 'completed', account * 100 + i, account)
      }
    }
    const result = pruneHistory(map, 0)
    expect(Object.keys(result)).toHaveLength(200)
    for (let i = 0; i < 50; i++) expect(result[`0-${i}`]).toBeDefined()
    for (let i = 0; i < 50; i++) expect(result[`1-${i}`]).toBeUndefined()
  })

  it('never prunes running records of any account under the cross-account cap', () => {
    const map: Record<string, StrategyRecord> = {}
    for (let account = 0; account < 5; account++) {
      for (let i = 0; i < 50; i++) {
        const id = `${account}-${i}`
        map[id] = rec(id, 'completed', account * 100 + i, account)
      }
      map[`r${account}`] = rec(`r${account}`, 'running', 0, account)
    }
    const result = pruneHistory(map)
    expect(Object.keys(result)).toHaveLength(205)
    for (let account = 0; account < 5; account++) expect(result[`r${account}`]).toBeDefined()
  })
})

// ===== Store actions =======================================================
//
// The store is created once and persisted with zustand's persist middleware.
// In a Node test env there is no IndexedDB, so persistence is a no-op —
// we just exercise the in-memory state machine. Each test resets to a known
// baseline via setState() so they remain order-independent.

const baseline = () => ({
  strategies: {} as Record<string, StrategyRecord>,
})

describe('useStrategyStore actions', () => {
  beforeEach(() => {
    useStrategyStore.setState(baseline())
  })

  // ----- upsert -----

  it('upsert: inserts a new record', () => {
    useStrategyStore.getState().upsert(rec('a', 'running', 1))
    expect(useStrategyStore.getState().strategies.a).toBeDefined()
  })

  it('upsert: overwrites an existing record by id', () => {
    useStrategyStore.getState().upsert(rec('a', 'running', 1))
    useStrategyStore.getState().upsert(rec('a', 'completed', 2))
    expect(useStrategyStore.getState().strategies.a!.progress.status).toBe('completed')
  })

  it('upsert: prunes terminal records past MAX_HISTORY_RECORDS', () => {
    // Seed 50 terminal records, all older than the new one we add. The new
    // upsert (terminal too) should evict the oldest one to keep the cap.
    const seeded: Record<string, StrategyRecord> = {}
    for (let i = 0; i < 50; i++) {
      seeded[`c${i}`] = rec(`c${i}`, 'completed', i)
    }
    useStrategyStore.setState({ ...baseline(), strategies: seeded })
    useStrategyStore.getState().upsert(rec('new', 'completed', 9999))
    const ids = Object.keys(useStrategyStore.getState().strategies)
    expect(ids).toHaveLength(50)
    expect(ids).toContain('new')
    expect(ids).not.toContain('c0') // oldest dropped
  })

  it('upsert: keeps the upserted account history under the cross-account cap', () => {
    const seeded: Record<string, StrategyRecord> = {}
    for (let account = 0; account < 4; account++) {
      for (let i = 0; i < 50; i++) {
        const id = `${account}-${i}`
        seeded[id] = rec(id, 'completed', account * 100 + i, account)
      }
    }
    seeded.old = rec('old', 'completed', -1, 9)
    useStrategyStore.setState({ ...baseline(), strategies: seeded })
    useStrategyStore.getState().upsert(rec('new', 'running', 9999, 9))
    const { strategies } = useStrategyStore.getState()
    expect(Object.keys(strategies)).toHaveLength(201)
    expect(strategies.old).toBeDefined()
    expect(strategies.new).toBeDefined()
    expect(strategies['0-0']).toBeUndefined()
  })

  // ----- patchProgress -----

  it('patchProgress: merges partial progress fields', () => {
    useStrategyStore.getState().upsert(rec('a', 'running', 1))
    useStrategyStore.getState().patchProgress('a', { filledBaseAmount: 3, status: 'completed' })
    const record = useStrategyStore.getState().strategies.a! as TwapStrategyRecord
    expect(record.progress.filledBaseAmount).toBe(3)
    expect(record.progress.status).toBe('completed')
    // Other fields preserved
    expect(record.progress.totalBaseAmount).toBe(0)
  })

  it('patchProgress: no-op when record missing (does not create)', () => {
    useStrategyStore.getState().patchProgress('ghost', { status: 'completed' })
    expect(useStrategyStore.getState().strategies.ghost).toBeUndefined()
  })

  // ----- unconfirmedOrders -----

  it('addUnconfirmedOrder: keys the entry by client order index', () => {
    useStrategyStore.getState().upsert(rec('a', 'running', 1))
    useStrategyStore
      .getState()
      .addUnconfirmedOrder('a', 7, { marketId: 1, orderType: 0, sentAt: 10 })
    expect(useStrategyStore.getState().strategies.a!.unconfirmedOrders).toEqual({
      7: { marketId: 1, orderType: 0, sentAt: 10 },
    })
  })

  it('addWorkingOrder: drops the unconfirmed entry of the tracked order', () => {
    useStrategyStore.getState().upsert(rec('a', 'running', 1))
    useStrategyStore
      .getState()
      .addUnconfirmedOrder('a', 7, { marketId: 1, orderType: 0, sentAt: 10 })
    useStrategyStore
      .getState()
      .addUnconfirmedOrder('a', 8, { marketId: 1, orderType: 0, sentAt: 11 })
    const [order] = wsOrder({ order_id: 'o1', client_order_index: 7 })
    useStrategyStore.getState().addWorkingOrder('a', order)
    const record = useStrategyStore.getState().strategies.a!
    expect(Object.keys(record.workingOrders)).toEqual(['o1'])
    expect(record.unconfirmedOrders).toEqual({
      8: { marketId: 1, orderType: 0, sentAt: 11 },
    })
  })

  it('setWorkingOrder: adopts an unconfirmed order, nothing else untracked', () => {
    useStrategyStore.getState().upsert(rec('a', 'running', 1))
    useStrategyStore
      .getState()
      .addUnconfirmedOrder('a', 7, { marketId: 1, orderType: 0, sentAt: 10 })
    const [stranger] = wsOrder({ order_id: 'o2', client_order_index: 9 })
    useStrategyStore.getState().setWorkingOrder('a', stranger)
    expect(useStrategyStore.getState().strategies.a!.workingOrders).toEqual({})

    const [order] = wsOrder({ order_id: 'o1', client_order_index: 7 })
    useStrategyStore.getState().setWorkingOrder('a', order)
    const record = useStrategyStore.getState().strategies.a!
    expect(record.workingOrders).toEqual({ o1: order })
    expect(record.unconfirmedOrders).toBeUndefined()
  })

  it('removeUnconfirmedOrder: clears the key once the last entry is gone', () => {
    useStrategyStore.getState().upsert(rec('a', 'running', 1))
    useStrategyStore
      .getState()
      .addUnconfirmedOrder('a', 7, { marketId: 1, orderType: 1, sentAt: 10 })
    const before = useStrategyStore.getState().strategies.a!
    useStrategyStore.getState().removeUnconfirmedOrder('a', 9)
    expect(useStrategyStore.getState().strategies.a).toBe(before)
    useStrategyStore.getState().removeUnconfirmedOrder('a', 7)
    expect(useStrategyStore.getState().strategies.a!.unconfirmedOrders).toBeUndefined()
  })

  // ----- setWorkingOrder -----

  it('setWorkingOrder: records and replaces the working order snapshot', () => {
    useStrategyStore.getState().upsert(rec('a', 'running', 1))
    useStrategyStore.getState().setWorkingOrders('a', wsWorkingOrders({ order_id: 'o1' }))
    expect(Object.keys(useStrategyStore.getState().strategies.a!.workingOrders)).toEqual(['o1'])
    useStrategyStore.getState().setWorkingOrders('a', wsWorkingOrders({ order_id: 'o2' }))
    expect(Object.keys(useStrategyStore.getState().strategies.a!.workingOrders)).toEqual(['o2'])
  })

  it('setWorkingOrder: replaces the snapshot when the same order changed', () => {
    useStrategyStore.getState().upsert(rec('a', 'running', 1))
    useStrategyStore
      .getState()
      .setWorkingOrders('a', wsWorkingOrders({ order_id: 'o1', updated_at: 1 }))
    useStrategyStore.getState().setWorkingOrders(
      'a',
      wsWorkingOrders({
        order_id: 'o1',
        updated_at: 2,
        filled_base_amount: 0.5,
      }),
    )
    expect(useStrategyStore.getState().strategies.a!.workingOrders.o1?.filled_base_amount).toBe(0.5)
  })

  it('setWorkingOrder: refreshes a tracked order and ignores unknown ones', () => {
    useStrategyStore.getState().upsert(rec('a', 'running', 1))
    useStrategyStore.getState().setWorkingOrders('a', wsWorkingOrders({ order_id: 'o1' }))
    useStrategyStore.getState().setWorkingOrder('a', wsOrder({ order_id: 'o1', updated_at: 5 })[0])
    useStrategyStore.getState().setWorkingOrder('a', wsOrder({ order_id: 'o2' })[0])
    const workingOrders = useStrategyStore.getState().strategies.a!.workingOrders
    expect(Object.keys(workingOrders)).toEqual(['o1'])
    expect(workingOrders.o1?.updated_at).toBe(5)
  })

  it('addWorkingOrder / removeWorkingOrder: keys orders by order_id', () => {
    useStrategyStore.getState().upsert(rec('a', 'running', 1))
    useStrategyStore.getState().addWorkingOrder('a', wsOrder({ order_id: 'o1' })[0])
    useStrategyStore.getState().addWorkingOrder('a', wsOrder({ order_id: 'o2' })[0])
    expect(Object.keys(useStrategyStore.getState().strategies.a!.workingOrders)).toEqual([
      'o1',
      'o2',
    ])
    useStrategyStore.getState().removeWorkingOrder('a', 'o1')
    expect(Object.keys(useStrategyStore.getState().strategies.a!.workingOrders)).toEqual(['o2'])
  })

  it('setWorkingOrder: no-op when record missing', () => {
    useStrategyStore.getState().setWorkingOrders('ghost', wsWorkingOrders({ order_id: 'o1' }))
    expect(useStrategyStore.getState().strategies.ghost).toBeUndefined()
  })

  // ----- remove -----

  it('remove: deletes the record', () => {
    useStrategyStore.getState().upsert(rec('a', 'running', 1))
    useStrategyStore.getState().upsert(rec('b', 'completed', 2))
    useStrategyStore.getState().remove('a')
    expect(useStrategyStore.getState().strategies.a).toBeUndefined()
    expect(useStrategyStore.getState().strategies.b).toBeDefined()
  })

  it('remove: silently ignores unknown id', () => {
    useStrategyStore.getState().upsert(rec('a', 'running', 1))
    useStrategyStore.getState().remove('ghost')
    expect(useStrategyStore.getState().strategies.a).toBeDefined()
  })
})
