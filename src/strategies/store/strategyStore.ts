import type {
  AdvancedTwapConfig,
  LimitChaseConfig,
  StrategyProgress,
  StrategyRecord,
  TwapProgress,
  UnconfirmedOrder,
  UnconfirmedOrders,
  WorkingOrders,
} from '../engine/types'
import type { Order } from '../..'
import { create } from 'zustand'
import { persist, subscribeWithSelector } from 'zustand/middleware'

import { STRATEGY_STORE_KEY, createStrategyStorage, strategyStoreVersion } from './strategyStorage'

/**
 * Accepts a partial of any progress variant. Used by patchProgress to merge
 * incoming fields into the existing progress object.
 */
type ProgressPatch = Partial<StrategyProgress>

export interface StrategyState {
  strategies: Record<string, StrategyRecord>
  upsert: (record: StrategyRecord) => void
  patchProgress: (id: string, progress: ProgressPatch) => void
  /** Replaces the strategy's working (resting limit) order snapshots, keyed
   *  by `order_id`. The snapshots are the fill baseline a resumed session
   *  reconciles against. */
  setWorkingOrders: (id: string, orders: WorkingOrders) => void
  /** Refreshes the snapshot of an order already tracked, or adopts one still
   *  unconfirmed; ignored otherwise. */
  setWorkingOrder: (id: string, order: Order) => void
  /** Adds (or refreshes) a working order snapshot; the order is no longer
   *  unconfirmed. */
  addWorkingOrder: (id: string, order: Order) => void
  removeWorkingOrder: (id: string, order_id: string) => void
  /** Records an order about to be sent, keyed by its client order index. */
  addUnconfirmedOrder: (id: string, clientOrderIndex: number, order: UnconfirmedOrder) => void
  removeUnconfirmedOrder: (id: string, clientOrderIndex: number) => void
  remove: (id: string) => void
}

export { STRATEGY_STORE_KEY }

const MAX_HISTORY_RECORDS_PER_ACCOUNT = 50
const MAX_HISTORY_RECORDS = 200

/** @internal Exported for unit tests; not part of the public store API. */
export const pruneHistory = (
  strategies: Record<string, StrategyRecord>,
  activeAccountIndex?: number,
): Record<string, StrategyRecord> => {
  const all = Object.values(strategies)
  const terminal = all
    .filter((r) => r.progress.status !== 'running')
    .sort((a, b) => b.createdAt - a.createdAt)
  const perAccount = new Map<number, number>()
  const withinAccountCap = terminal.filter((r) => {
    const count = perAccount.get(r.config.accountIndex) ?? 0
    perAccount.set(r.config.accountIndex, count + 1)
    return count < MAX_HISTORY_RECORDS_PER_ACCOUNT
  })
  if (withinAccountCap.length === terminal.length && terminal.length <= MAX_HISTORY_RECORDS) {
    return strategies
  }
  const active = withinAccountCap.filter((r) => r.config.accountIndex === activeAccountIndex)
  const others = withinAccountCap.filter((r) => r.config.accountIndex !== activeAccountIndex)
  const keep = new Set([...active, ...others].slice(0, MAX_HISTORY_RECORDS).map((r) => r.id))
  const next: Record<string, StrategyRecord> = {}
  for (const r of all) {
    if (r.progress.status === 'running' || keep.has(r.id)) next[r.id] = r
  }
  return next
}

/**
 * Coerces any persisted shape of the working orders (legacy single order,
 * legacy array, or the current record) into a `Record` keyed by `order_id`.
 */
const normalizeWorkingOrders = (
  value: WorkingOrders | Order[] | Order | null | undefined,
): WorkingOrders => {
  if (!value) return {}
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map((order) => [order.order_id, order]))
  }
  if ('order_id' in value) {
    const order = value as Order
    return { [order.order_id]: order }
  }
  return value
}

/** Drops one entry; an emptied record keeps no `unconfirmedOrders` key. */
const withoutUnconfirmedOrder = (
  unconfirmedOrders: UnconfirmedOrders | undefined,
  clientOrderIndex: number,
): UnconfirmedOrders | undefined => {
  if (!unconfirmedOrders?.[clientOrderIndex]) return unconfirmedOrders
  const { [clientOrderIndex]: _removed, ...rest } = unconfirmedOrders
  return Object.keys(rest).length > 0 ? rest : undefined
}

export type StrategyResumeFlagState = 'none' | 'loading' | 'done'
export interface StrategyFlagStoreState {
  resumeStatus: StrategyResumeFlagState
  isLeaderTab: boolean
  setResumeStatus: (resumeStatus: StrategyResumeFlagState) => void
  setIsLeaderTab: (isLeaderTab: boolean) => void
}

export const useStrategyFlagStore = create<StrategyFlagStoreState>()(
  subscribeWithSelector((set) => ({
    resumeStatus: 'none',
    isLeaderTab: false,
    setResumeStatus: (resumeStatus: StrategyResumeFlagState) => set({ resumeStatus }),
    setIsLeaderTab: (isLeaderTab: boolean) => set({ isLeaderTab }),
  })),
)

const VERSION = 9

export const useStrategyStore = create<StrategyState>()(
  subscribeWithSelector(
    persist(
      (set) => ({
        strategies: {},
        upsert: (record) =>
          set((state) => ({
            strategies: pruneHistory(
              {
                ...state.strategies,
                [record.id]: record,
              },
              record.config.accountIndex,
            ),
          })),
        patchProgress: (id, progress) =>
          set((state) => {
            const existing = state.strategies[id]

            if (!existing) {
              return state
            }

            return {
              strategies: {
                ...state.strategies,
                [id]: {
                  ...existing,
                  progress: { ...existing.progress, ...progress },
                },
              },
            }
          }),
        setWorkingOrders: (id, orders) =>
          set((state) => {
            const existing = state.strategies[id]

            if (!existing) {
              return state
            }

            return {
              strategies: {
                ...state.strategies,
                [id]: { ...existing, workingOrders: orders },
              },
            }
          }),
        setWorkingOrder: (id, order) =>
          set((state) => {
            const existing = state.strategies[id]

            if (
              !existing ||
              !(
                order.order_id in existing.workingOrders ||
                existing.unconfirmedOrders?.[order.client_order_index]
              )
            ) {
              return state
            }
            return {
              strategies: {
                ...state.strategies,
                [id]: {
                  ...existing,
                  workingOrders: {
                    ...existing.workingOrders,
                    [order.order_id]: order,
                  },
                  unconfirmedOrders: withoutUnconfirmedOrder(
                    existing.unconfirmedOrders,
                    order.client_order_index,
                  ),
                },
              },
            }
          }),
        addWorkingOrder: (id, order) =>
          set((state) => {
            const existing = state.strategies[id]

            if (!existing) {
              return state
            }

            return {
              strategies: {
                ...state.strategies,
                [id]: {
                  ...existing,
                  workingOrders: {
                    ...existing.workingOrders,
                    [order.order_id]: order,
                  },
                  unconfirmedOrders: withoutUnconfirmedOrder(
                    existing.unconfirmedOrders,
                    order.client_order_index,
                  ),
                },
              },
            }
          }),
        removeWorkingOrder: (id, order_id) =>
          set((state) => {
            const existing = state.strategies[id]
            if (!existing || !(order_id in existing.workingOrders)) {
              return state
            }
            const { [order_id]: _removed, ...workingOrders } = existing.workingOrders
            return {
              strategies: {
                ...state.strategies,
                [id]: { ...existing, workingOrders },
              },
            }
          }),
        addUnconfirmedOrder: (id, clientOrderIndex, order) =>
          set((state) => {
            const existing = state.strategies[id]
            if (!existing) {
              return state
            }
            return {
              strategies: {
                ...state.strategies,
                [id]: {
                  ...existing,
                  unconfirmedOrders: {
                    ...existing.unconfirmedOrders,
                    [clientOrderIndex]: order,
                  },
                },
              },
            }
          }),
        removeUnconfirmedOrder: (id, clientOrderIndex) =>
          set((state) => {
            const existing = state.strategies[id]
            if (!existing?.unconfirmedOrders?.[clientOrderIndex]) {
              return state
            }
            return {
              strategies: {
                ...state.strategies,
                [id]: {
                  ...existing,
                  unconfirmedOrders: withoutUnconfirmedOrder(
                    existing.unconfirmedOrders,
                    clientOrderIndex,
                  ),
                },
              },
            }
          }),
        remove: (id) =>
          set((state) => {
            const next = { ...state.strategies }
            delete next[id]
            return { strategies: next }
          }),
      }),
      {
        name: STRATEGY_STORE_KEY,
        version: VERSION,
        storage: createStrategyStorage(),
        partialize: (state) => ({ strategies: state.strategies }),
        // v1 stored the full execution snapshot + per-submission arrays on
        // every record (a multi-MB blob behind renderer crashes) and used the
        // old "randomized-twap" kind label. v2 kept a per-order `fills`
        // ledger; v3 tracks a single working order and keeps fill totals on
        // `progress`, so `fills` is dropped and its totals folded in. v5 adds
        // `restingChunkBaseAmount` to chase-limit configs (defaults to the
        // whole order). v6 adds the TWAP schedule state: a failed amount and
        // `consumedSlices` (converted from the legacy `lastSliceAt`) — the
        // schedule itself is regenerated deterministically from `createdAt`,
        // so only the count of consumed slots persists. v7 replaces the
        // single `workingOrder` with a `workingOrders` array (a strategy can
        // now keep multiple resting orders live at once). v8 backfills the
        // REST-derived maker/taker split (`makerBaseAmountV2` /
        // `takerBaseAmountV2`) with 0 on records that predate the fields. v9
        // re-keys `workingOrders` from an array into a `Record` by `order_id`.
        migrate: (persisted, fromVersion) => {
          if (fromVersion > VERSION) {
            strategyStoreVersion.isOutdated = true
            // means this is a stale tab and needs new version which is probably
            // in a different tab which wrote the new version
            throw new Error('Strategy migration from a higher version. Update app.')
          }
          const state = (persisted ?? {}) as {
            strategies?: Record<string, StrategyRecord>
          }
          const strategies = state.strategies ?? {}
          for (const record of Object.values(strategies)) {
            if ((record.kind as string) === 'randomized-twap') {
              ;(record as { kind: string }).kind = 'advanced-twap'
            }
            const loose = record as StrategyRecord & {
              fills?: {
                filledBase?: number
                avgFillPrice?: number | null
                makerBase?: number
              }
              workingOrder?: Order | null
              workingOrders?: WorkingOrders | Order[]
            }
            record.workingOrders = normalizeWorkingOrders(loose.workingOrders ?? loose.workingOrder)
            delete loose.workingOrder
            if (loose.fills) {
              const filledBase = loose.fills.filledBase ?? 0
              record.progress.filledBaseAmount = Math.max(
                record.progress.filledBaseAmount ?? 0,
                filledBase,
              )
              record.progress.filledQuoteAmount = filledBase * (loose.fills.avgFillPrice ?? 0)
              record.progress.makerBaseAmount = loose.fills.makerBase ?? 0
              delete loose.fills
            }
            record.progress.filledQuoteAmount ??= 0
            record.progress.makerBaseAmount ??= 0
            record.progress.makerBaseAmountV2 ??= 0
            record.progress.takerBaseAmountV2 ??= 0
            if (record.kind === 'chase-limit') {
              const config = record.config as Partial<LimitChaseConfig>
              config.restingChunkBaseAmount ??= config.totalSize ?? 0
            }
            if (record.kind === 'advanced-twap') {
              const config = record.config as AdvancedTwapConfig
              const progress = record.progress as TwapProgress
              progress.failedBaseAmount ??= 0
              const legacy = progress as TwapProgress & {
                lastSliceAt?: number | null
                endAt?: number
              }
              progress.consumedSlices ??=
                legacy.lastSliceAt == null || !config.baseIntervalMs
                  ? 0
                  : Math.min(
                      config.sliceCount,
                      Math.max(
                        0,
                        Math.round(
                          (legacy.lastSliceAt - record.createdAt) / config.baseIntervalMs,
                        ) + 1,
                      ),
                    )
              delete legacy.lastSliceAt
              delete legacy.endAt
            }
          }
          return { strategies: pruneHistory(strategies) }
        },
        onRehydrateStorage: () => (state) => {
          if (!state) {
            return
          }

          for (const record of Object.values(state.strategies)) {
            record.workingOrders = normalizeWorkingOrders(record.workingOrders)
            record.progress.filledQuoteAmount ??= 0
            record.progress.makerBaseAmount ??= 0
            record.progress.makerBaseAmountV2 ??= 0
            record.progress.takerBaseAmountV2 ??= 0
            if (record.kind === 'chase-limit') {
              const config = record.config as Partial<LimitChaseConfig>
              config.restingChunkBaseAmount ??= config.totalSize ?? 0
            }
          }
          state.strategies = pruneHistory(state.strategies)
        },
      },
    ),
  ),
)
