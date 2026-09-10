import { create } from 'zustand'
import type { Encoding, LighterWsInterface } from '../lighter-ws/types/LighterWs'
import { MAX_WS_CHANNEL_SUBSCRIBE_RETRIES, type ChannelStatus } from './channels'
import {
  type WsMessage,
  type WsNotification as WsNotificationType,
} from '../lighter-ws/types/WsMessage'
import { useLighterStore } from '../store/useLighterStore'
import { getCandleKey } from '../utils/candlesticks'
import LighterWs from '../lighter-ws/LighterWs'
import { websocketConfig } from './websocketConfig'
import {
  appendAgentExchange,
  clearAgentThread,
  clearBufferedCandlesticksForKey,
  failInFlightAgentExchanges,
  handleChangeDesiredMarket,
  handleWsMessage,
  newAgentExchangeId,
  patchInFlightAgentExchanges,
} from './utils'
import { errorReporting } from '../lib/errorReporting'
import { isRobinhoodEnv } from '../lib/env'
import { wsChannelReconnectTimeout } from '../lighter-ws/utils/wsChannelReconnectTimeout'

export interface WsSubStore {
  marketId: number | null
  accountIndex: number
  publicPoolIndex: number
  stakingPoolIndex: number
  isAuthenticated: boolean
  ws: LighterWsInterface | null
  wsLoading: boolean
  wsSessionId?: string
  channels: Record<string, ChannelStatus>
  lastPingTime: number | null
  lastPongTime: number | null
  // Candle subscription refcounts keyed by `${marketId}/${obResolution}` (see getCandleKey).
  candleSubscriptions: Record<string, { marketId: number; obResolution: string; refCount: number }>
  // Candle channels currently open on the websocket, used to diff on sync.
  activeCandleChannels: string[]
  actions: {
    logout: () => void
    init: (
      url: string,
      triggerWsNotification: (notif: WsNotificationType) => void,
      getOrCreateAuthToken: () => Promise<{ token: string } | undefined>,
      encoding: Encoding,
      customServer: string | null,
    ) => Promise<void>
    ping: () => void
    forceClose: () => void
    subscribeHeight: () => void
    subscribeMarket: (newMarketId: number) => void
    unsubscribeMarket: () => void
    // Refcounted per (market, resolution); obResolution is ob-format ('1m', '1h').
    subscribeCandle: (marketId: number, obResolution: string) => void
    unsubscribeCandle: (marketId: number, obResolution: string) => void
    syncSharedCandleSubscription: () => void
    subscribePublicPool: (publicPoolIndex: number, options?: { skipTrades?: boolean }) => void
    unsubscribePublicPool: (publicPoolIndex: number, options?: { skipTrades?: boolean }) => void
    subscribeStakingPool: (stakingPoolIndex: number) => void
    unsubscribeStakingPool: (stakingPoolIndex: number) => void
    subscribeLivePoints: (accountIndex: number, auth: string) => void
    unsubscribeLivePoints: (accountIndex: number) => void
    subscribeAgent: (accountIndex: number, auth: string) => void
    unsubscribeAgent: (accountIndex: number) => void
    askAgent: (accountIndex: number, question: string, auth: string) => void
    clearAgentExchanges: (accountIndex: number) => void
    switchAccount: (
      accountIndex: number,
      isAuthenticated: boolean,
      waitForWasm: () => Promise<unknown>,
      getOrCreateAuthToken: (accountIndex: number) => Promise<{ token: string } | undefined>,
    ) => void
    subscribeChannel: (msg: {
      type: 'subscribe'
      channel: string
      flushInterval?: string
      auth?: string
    }) => void
    unsubscribeChannel: (msg: { type: 'unsubscribe'; channel: string }) => void
    markAsSubscribed: (channel: string) => void
  }
}

const shouldUseMarkPriceCandles = () => useLighterStore.getState().preferences.showMarkPriceCandles

const buildCandleChannel = (
  marketId: number,
  obResolution: string,
  useMarkPriceCandles: boolean,
) =>
  useMarkPriceCandles
    ? `mark_price_candle/${marketId}/${obResolution}`
    : `candle/${marketId}/${obResolution}`

// `candle/{marketId}/{res}` | `mark_price_candle/{marketId}/{res}` -> `${marketId}/${res}`
const getKeyFromCandleChannel = (channel: string) => {
  const parts = channel.split('/')
  return getCandleKey(Number(parts[parts.length - 2]), parts[parts.length - 1] ?? '')
}

export const useWsSubStore = create<WsSubStore>((set, get) => ({
  marketId: null,
  accountIndex: 0,
  publicPoolIndex: 0,
  stakingPoolIndex: 0,
  isAuthenticated: false,
  ws: null,
  wsLoading: false,
  wsSessionId: undefined,
  channels: {},
  lastPingTime: null,
  lastPongTime: null,
  candleSubscriptions: {},
  activeCandleChannels: [],
  actions: {
    init: async (url, triggerWsNotification, getOrCreateAuthToken, encoding, customServer) => {
      const { actions } = get()
      if (get().ws || get().wsLoading) {
        return
      }

      set({ wsLoading: true, channels: {} })

      const authToken = await getOrCreateAuthToken()
      new LighterWs({
        baseUrl: url,
        encoding,
        auth: authToken,
        server: customServer ?? undefined,
        onOpen: (ws: LighterWsInterface) => {
          set({
            ws,
            wsLoading: false,
            lastPingTime: Date.now(),
            lastPongTime: Date.now(),
          })

          actions.subscribeChannel(MSG.SUBSCRIBE_PERPS_MARKETS_STATS(websocketConfig.flushInterval))
          actions.subscribeChannel(MSG.SUBSCRIBE_SPOT_MARKETS_STATS(websocketConfig.flushInterval))
          actions.subscribeChannel(MSG.SUBSCRIBE_ASSET_STATS(websocketConfig.flushInterval))
          actions.syncSharedCandleSubscription()
        },
        onClose: () => {
          set({
            ws: null,
            wsLoading: false,
            wsSessionId: undefined,
            accountIndex: 0,
            publicPoolIndex: 0,
            stakingPoolIndex: 0,
            isAuthenticated: false,
            lastPingTime: null,
            lastPongTime: null,
            activeCandleChannels: [],
          })

          failInFlightAgentExchanges()

          const { channels } = get()
          Object.values(channels).forEach((channel) => {
            if (channel?.timeout) {
              clearTimeout(channel.timeout)
            }
          })
        },
        onMessage: (message: WsMessage, ws: LighterWsInterface) => {
          if (message.type === 'ping') {
            ws.sendMessage({
              type: 'pong',
            })
          }
          if (message.type === 'pong') {
            set({ lastPongTime: Date.now() })
          }
          if (message.type === 'connected') {
            set({ wsSessionId: message.session_id })
          }
          if ('channel' in message && message.type.startsWith('subscribed')) {
            actions.markAsSubscribed(message.channel)
          }
          handleWsMessage(message, triggerWsNotification)
        },
        onError: (err: unknown, tags: unknown) => {
          errorReporting.captureException(err, { tags })
        },
      })
    },
    ping: () => {
      const { ws } = get()
      if (!ws) return

      ws.sendMessage({ type: 'ping' })
      set({ lastPingTime: Date.now() })
    },
    forceClose: () => {
      const { ws } = get()
      if (!ws) return
      ws.close()
      set({
        ws: null,
        wsLoading: false,
        wsSessionId: undefined,
        accountIndex: 0,
        publicPoolIndex: 0,
        stakingPoolIndex: 0,
        isAuthenticated: false,
        lastPingTime: null,
        lastPongTime: null,
        activeCandleChannels: [],
      })

      failInFlightAgentExchanges()

      const { channels } = get()
      Object.values(channels).forEach((channel) => {
        if (channel?.timeout) {
          clearTimeout(channel.timeout)
        }
      })
    },
    subscribeHeight: () => {
      const { ws, actions } = get()
      if (!ws) return
      actions.subscribeChannel(MSG.SUBSCRIBE_BLOCK_HEIGHT())
    },
    subscribeMarket: (newMarketId) => {
      const { ws, marketId, actions } = get()

      if (!ws) return

      if (marketId !== newMarketId) {
        handleChangeDesiredMarket(newMarketId)
      }

      if (newMarketId >= 0) {
        actions.subscribeChannel(MSG.SUBSCRIBE_MARKET_TRADE(newMarketId))
        actions.subscribeChannel(MSG.SUBSCRIBE_MARKET_ORDER_BOOK(newMarketId))
      }

      set({ marketId: newMarketId })
    },
    unsubscribeMarket: () => {
      const { ws, marketId, actions } = get()

      if (!ws || marketId === null) {
        return
      }
      actions.unsubscribeChannel(MSG.UNSUBSCRIBE_MARKET_TRADE(marketId))
      actions.unsubscribeChannel(MSG.UNSUBSCRIBE_MARKET_ORDER_BOOK(marketId))
    },
    subscribeCandle: (marketId, obResolution) => {
      const key = getCandleKey(marketId, obResolution)
      set((prev) => {
        const existing = prev.candleSubscriptions[key]
        return {
          candleSubscriptions: {
            ...prev.candleSubscriptions,
            [key]: existing
              ? { ...existing, refCount: existing.refCount + 1 }
              : { marketId, obResolution, refCount: 1 },
          },
        }
      })
      get().actions.syncSharedCandleSubscription()
    },
    unsubscribeCandle: (marketId, obResolution) => {
      const key = getCandleKey(marketId, obResolution)
      set((prev) => {
        const existing = prev.candleSubscriptions[key]
        if (!existing) {
          return {}
        }
        const nextSubscriptions = { ...prev.candleSubscriptions }
        if (existing.refCount <= 1) {
          delete nextSubscriptions[key]
        } else {
          nextSubscriptions[key] = { ...existing, refCount: existing.refCount - 1 }
        }
        return { candleSubscriptions: nextSubscriptions }
      })
      get().actions.syncSharedCandleSubscription()
    },
    syncSharedCandleSubscription: () => {
      const { ws, actions, candleSubscriptions, activeCandleChannels } = get()

      const desiredKeys = new Set<string>()
      const desiredChannels = new Set<string>()
      Object.values(candleSubscriptions).forEach((sub) => {
        if (sub.refCount > 0) {
          desiredKeys.add(getCandleKey(sub.marketId, sub.obResolution))
          desiredChannels.add(
            buildCandleChannel(sub.marketId, sub.obResolution, shouldUseMarkPriceCandles()),
          )
        }
      })

      const { newCandlesticksByKey } = useLighterStore.getState()
      Object.keys(newCandlesticksByKey).forEach((key) => {
        if (!desiredKeys.has(key)) {
          clearBufferedCandlesticksForKey(key)
        }
      })

      if (!ws) {
        return
      }

      const activeChannels = new Set(activeCandleChannels)

      activeCandleChannels.forEach((channel) => {
        if (!desiredChannels.has(channel)) {
          actions.unsubscribeChannel({ type: 'unsubscribe' as const, channel })
          clearBufferedCandlesticksForKey(getKeyFromCandleChannel(channel))
        }
      })

      desiredChannels.forEach((channel) => {
        if (!activeChannels.has(channel)) {
          actions.subscribeChannel({ type: 'subscribe' as const, channel })
        }
      })

      set({ activeCandleChannels: Array.from(desiredChannels) })
    },
    subscribePublicPool: (publicPoolIndex, { skipTrades = false } = {}) => {
      const {
        publicPoolIndex: currentPublicPoolIndex,
        actions,
        accountIndex,
        isAuthenticated,
      } = get()

      if (currentPublicPoolIndex === publicPoolIndex) {
        return
      }

      const isOwnerAndAuthed = accountIndex === publicPoolIndex && isAuthenticated

      actions.subscribeChannel(MSG.SUBSCRIBE_POOL_INFO(publicPoolIndex))

      if (!isOwnerAndAuthed) {
        actions.subscribeChannel(MSG.SUBSCRIBE_ACCOUNT_POSITIONS(publicPoolIndex, undefined, 2000))
        actions.subscribeChannel(MSG.SUBSCRIBE_ACCOUNT_ASSETS(publicPoolIndex))
        // pool accounts are exempt from auth on this channel server-side;
        // needed for per-asset spot PnL on the pool page
        actions.subscribeChannel(MSG.SUBSCRIBE_ACCOUNT_SPOT_AVG_ENTRY_PRICES(publicPoolIndex))

        if (!skipTrades) {
          actions.subscribeChannel(MSG.SUBSCRIBE_ACCOUNT_TRADES(publicPoolIndex))
        }
      }

      set({ publicPoolIndex })
    },
    unsubscribePublicPool: (publicPoolIndex, { skipTrades = false } = {}) => {
      const {
        publicPoolIndex: currentPublicPoolIndex,
        actions,
        accountIndex,
        isAuthenticated,
      } = get()

      if (currentPublicPoolIndex !== publicPoolIndex) {
        return
      }

      const isOwnerAndAuthed = accountIndex === publicPoolIndex && isAuthenticated

      actions.unsubscribeChannel(MSG.UNSUBSCRIBE_POOL_INFO(publicPoolIndex))

      if (!isOwnerAndAuthed) {
        actions.unsubscribeChannel(MSG.UNSUBSCRIBE_ACCOUNT_POSITIONS(publicPoolIndex))
        actions.unsubscribeChannel(MSG.UNSUBSCRIBE_ACCOUNT_ASSETS(publicPoolIndex))
        actions.unsubscribeChannel(MSG.UNSUBSCRIBE_ACCOUNT_SPOT_AVG_ENTRY_PRICES(publicPoolIndex))

        if (!skipTrades) {
          actions.unsubscribeChannel(MSG.UNSUBSCRIBE_ACCOUNT_TRADES(publicPoolIndex))
        }
      }

      set({ publicPoolIndex: 0 })
    },
    subscribeStakingPool: (stakingPoolIndex) => {
      const {
        stakingPoolIndex: currentStakingPoolIndex,
        actions,
        accountIndex,
        isAuthenticated,
      } = get()

      if (currentStakingPoolIndex === stakingPoolIndex) {
        return
      }

      const isOwnerAndAuthed = accountIndex === stakingPoolIndex && isAuthenticated

      actions.subscribeChannel(MSG.SUBSCRIBE_POOL_INFO(stakingPoolIndex))

      if (!isOwnerAndAuthed) {
        actions.subscribeChannel(MSG.SUBSCRIBE_ACCOUNT_ASSETS(stakingPoolIndex))
      }

      set({ stakingPoolIndex })
    },
    unsubscribeStakingPool: (stakingPoolIndex) => {
      const {
        stakingPoolIndex: currentStakingPoolIndex,
        actions,
        accountIndex,
        isAuthenticated,
      } = get()

      if (currentStakingPoolIndex !== stakingPoolIndex) {
        return
      }

      const isOwnerAndAuthed = accountIndex === stakingPoolIndex && isAuthenticated

      actions.unsubscribeChannel(MSG.UNSUBSCRIBE_POOL_INFO(stakingPoolIndex))

      if (!isOwnerAndAuthed) {
        actions.unsubscribeChannel(MSG.UNSUBSCRIBE_ACCOUNT_ASSETS(stakingPoolIndex))
      }

      set({ stakingPoolIndex: 0 })
    },
    subscribeLivePoints: (accountIndex, auth) => {
      const { ws, actions } = get()
      if (!ws || !isRobinhoodEnv()) return
      try {
        actions.subscribeChannel(MSG.SUBSCRIBE_LIVE_POINTS(accountIndex, auth))
      } catch (e) {
        errorReporting.captureException(e, {
          tags: {
            accountIndex,
            type: 'subscribe_live_points',
          },
        })
      }
    },
    unsubscribeLivePoints: (accountIndex) => {
      const { ws, actions } = get()
      if (!ws) return
      actions.unsubscribeChannel(MSG.UNSUBSCRIBE_LIVE_POINTS(accountIndex))
    },
    subscribeAgent: (accountIndex, auth) => {
      const { ws, actions } = get()
      if (!ws) return
      try {
        actions.subscribeChannel(MSG.SUBSCRIBE_AGENT(accountIndex, auth))
      } catch (e) {
        errorReporting.captureException(e, {
          tags: {
            accountIndex,
            type: 'subscribe_agent',
          },
        })
      }
    },
    unsubscribeAgent: (accountIndex) => {
      const { ws, channels, actions } = get()
      clearAgentThread(accountIndex)
      if (!ws || !channels[`agent/${accountIndex}`]) return
      actions.unsubscribeChannel(MSG.UNSUBSCRIBE_AGENT(accountIndex))
    },
    askAgent: (accountIndex, question, auth) => {
      const id = newAgentExchangeId()

      appendAgentExchange(accountIndex, {
        answer: null,
        answeredAt: null,
        askedAt: Date.now(),
        error: null,
        id,
        question,
        status: 'sending',
      })

      try {
        const { ws } = get()
        if (!ws) {
          patchInFlightAgentExchanges(accountIndex, { error: null, status: 'failed' })
          return
        }
        ws.sendMessage(MSG.AGENT_QUESTION(accountIndex, auth, id, question))
      } catch (e) {
        patchInFlightAgentExchanges(accountIndex, { error: null, status: 'failed' })
        errorReporting.captureException(e, {
          tags: {
            accountIndex,
            type: 'ask_agent',
          },
        })
      }
    },
    clearAgentExchanges: (accountIndex) => clearAgentThread(accountIndex),
    switchAccount: (newAccountIndex, newIsAuthenticated, waitForWasm, getOrCreateAuthToken) => {
      const { ws, accountIndex, isAuthenticated, actions } = get()

      if (!ws) {
        return
      }

      // No need to switch account if it's already the same
      if (accountIndex === newAccountIndex && isAuthenticated === newIsAuthenticated) {
        return
      }

      if (accountIndex) {
        actions.unsubscribeChannel(MSG.UNSUBSCRIBE_ACCOUNT_TRANSACTIONS(accountIndex))
        actions.unsubscribeChannel(MSG.UNSUBSCRIBE_ACCOUNT_ORDERS(accountIndex))
        actions.unsubscribeChannel(MSG.UNSUBSCRIBE_ACCOUNT_POSITIONS(accountIndex))
        actions.unsubscribeChannel(MSG.UNSUBSCRIBE_ACCOUNT_TRADES(accountIndex))
        actions.unsubscribeChannel(MSG.UNSUBSCRIBE_ACCOUNT_NOTIFICATION(accountIndex))
        actions.unsubscribeChannel(MSG.UNSUBSCRIBE_ACCOUNT_ASSETS(accountIndex))
        actions.unsubscribeChannel(MSG.UNSUBSCRIBE_ACCOUNT_SPOT_AVG_ENTRY_PRICES(accountIndex))
        actions.unsubscribeChannel(MSG.UNSUBSCRIBE_RFQS())
        actions.unsubscribeAgent(accountIndex)
      }

      if (newAccountIndex) {
        if (newIsAuthenticated) {
          waitForWasm().then(async () => {
            try {
              const t = await getOrCreateAuthToken(newAccountIndex)
              if (!t) throw new Error('Could not get auth token')
              actions.subscribeChannel(MSG.SUBSCRIBE_ACCOUNT_TRANSACTIONS(newAccountIndex, t.token))
              actions.subscribeChannel(MSG.SUBSCRIBE_ACCOUNT_ORDERS(newAccountIndex, t.token))
              actions.subscribeChannel(MSG.SUBSCRIBE_ACCOUNT_POSITIONS(newAccountIndex, t.token))
              actions.subscribeChannel(MSG.SUBSCRIBE_ACCOUNT_TRADES(newAccountIndex, t.token))
              actions.subscribeChannel(MSG.SUBSCRIBE_ACCOUNT_NOTIFICATION(newAccountIndex, t.token))
              actions.subscribeChannel(MSG.SUBSCRIBE_ACCOUNT_ASSETS(newAccountIndex, t.token))
              actions.subscribeChannel(
                MSG.SUBSCRIBE_ACCOUNT_SPOT_AVG_ENTRY_PRICES(newAccountIndex, t.token),
              )
              actions.subscribeChannel(MSG.SUBSCRIBE_RFQS(t.token))
            } catch (e) {
              errorReporting.captureException(e, {
                tags: {
                  accountIndex,
                  type: 'subscribe_account_channels ',
                },
              })
            }
          })
        }
      }

      set({ accountIndex: newAccountIndex, isAuthenticated: newIsAuthenticated })
    },
    subscribeChannel: (msg) => {
      const { ws, channels, actions } = get()
      const { retries } = channels[msg.channel] ?? { retries: 0 }
      if (!ws) return
      if (channels[msg.channel] && retries >= MAX_WS_CHANNEL_SUBSCRIBE_RETRIES) return
      // A re-subscribe before the ack lands must not orphan the pending retry
      // timer, or it fires a duplicate subscribe and schedules another.
      clearTimeout(channels[msg.channel]?.timeout ?? undefined)
      set({
        channels: {
          ...channels,
          [msg.channel]: {
            retries: retries + 1,
            timeout: setTimeout(
              () => actions.subscribeChannel(msg), // Retry subscribe channel
              wsChannelReconnectTimeout(retries + 1),
            ),
          },
        },
      })
      ws.sendMessage(msg)
    },
    markAsSubscribed: (channel) => {
      channel = channel.replace(/:/g, '/')
      const { channels } = get()
      clearInterval(channels[channel]?.timeout ?? undefined)
      set({
        channels: {
          ...channels,
          [channel]: {
            retries: channels[channel]?.retries ?? 1,
            timeout: null,
          },
        },
      })
    },
    unsubscribeChannel: (msg) => {
      const { ws, channels } = get()
      const { channel } = msg
      if (!ws || !channels[channel]) return
      clearInterval(channels[channel]?.timeout ?? undefined)
      const newChannels = { ...channels }
      delete newChannels[channel]
      set({ channels: newChannels })
      ws.sendMessage(msg)
    },
    logout() {
      useLighterStore.setState((state) => {
        const { [state.accountIndex]: _toBeDeleted, ...restAccounts } = state.accounts

        return {
          ...state,
          accountIndex: 0,
          accounts: restAccounts,
          agentThreads: {},
          isAuthenticated: false,
        }
      })
    },
  },
}))

const MSG = {
  SUBSCRIBE_ACCOUNT_ASSETS: (account: number, auth?: string) => ({
    type: 'subscribe' as const,
    channel: `account_all_assets/${account}`,
    ...(typeof auth === 'string' ? { auth } : {}),
  }),
  UNSUBSCRIBE_ACCOUNT_ASSETS: (account: number) => ({
    type: 'unsubscribe' as const,
    channel: `account_all_assets/${account}`,
  }),
  SUBSCRIBE_ACCOUNT_SPOT_AVG_ENTRY_PRICES: (account: number, auth?: string) => ({
    type: 'subscribe' as const,
    channel: `account_spot_avg_entry_prices/${account}`,
    ...(typeof auth === 'string' ? { auth } : {}),
  }),
  UNSUBSCRIBE_ACCOUNT_SPOT_AVG_ENTRY_PRICES: (account: number) => ({
    type: 'unsubscribe' as const,
    channel: `account_spot_avg_entry_prices/${account}`,
  }),
  SUBSCRIBE_ACCOUNT_POSITIONS: (account: number, auth?: string, flushInterval?: number) => ({
    type: 'subscribe' as const,
    channel: `account_all_positions_fe/${account}`,
    ...(typeof auth === 'string' ? { auth } : {}),
    ...(typeof flushInterval === 'number' ? { flush_interval: flushInterval.toFixed(0) } : {}),
  }),
  UNSUBSCRIBE_ACCOUNT_POSITIONS: (account: number) => ({
    type: 'unsubscribe' as const,
    channel: `account_all_positions_fe/${account}`,
  }),
  SUBSCRIBE_ACCOUNT_ORDERS: (account: number, auth?: string) => ({
    type: 'subscribe' as const,
    channel: `account_all_orders/${account}`,
    ...(typeof auth === 'string' ? { auth } : {}),
  }),
  UNSUBSCRIBE_ACCOUNT_ORDERS: (account: number) => ({
    type: 'unsubscribe' as const,
    channel: `account_all_orders/${account}`,
  }),
  SUBSCRIBE_ACCOUNT_TRADES: (account: number, auth?: string) => ({
    type: 'subscribe' as const,
    channel: `account_all_trades/${account}`,
    ...(typeof auth === 'string' ? { auth } : {}),
  }),
  UNSUBSCRIBE_ACCOUNT_TRADES: (account: number) => ({
    type: 'unsubscribe' as const,
    channel: `account_all_trades/${account}`,
  }),
  SUBSCRIBE_POOL_INFO: (account: number) => ({
    type: 'subscribe' as const,
    channel: `pool_info/${account}`,
  }),
  SUBSCRIBE_POOL_DATA: (account: number) => ({
    type: 'subscribe' as const,
    channel: `pool_data/${account}`,
  }),
  UNSUBSCRIBE_POOL_DATA: (account: number) => ({
    type: 'unsubscribe' as const,
    channel: `pool_data/${account}`,
  }),
  UNSUBSCRIBE_POOL_INFO: (account: number) => ({
    type: 'unsubscribe' as const,
    channel: `pool_info/${account}`,
  }),
  SUBSCRIBE_MARKET_TRADE: (marketId: number) => ({
    type: 'subscribe' as const,
    channel: `trade_fe/${marketId}`,
  }),
  UNSUBSCRIBE_MARKET_TRADE: (marketId: number) => ({
    type: 'unsubscribe' as const,
    channel: `trade_fe/${marketId}`,
  }),
  SUBSCRIBE_CANDLE: (marketId: number, resolution: string) => ({
    type: 'subscribe' as const,
    channel: `candle/${marketId}/${resolution}`,
  }),
  UNSUBSCRIBE_CANDLE: (marketId: number, resolution: string) => ({
    type: 'unsubscribe' as const,
    channel: `candle/${marketId}/${resolution}`,
  }),
  SUBSCRIBE_MARK_PRICE_CANDLE: (marketId: number, resolution: string) => ({
    type: 'subscribe' as const,
    channel: `mark_price_candle/${marketId}/${resolution}`,
  }),
  UNSUBSCRIBE_MARK_PRICE_CANDLE: (marketId: number, resolution: string) => ({
    type: 'unsubscribe' as const,
    channel: `mark_price_candle/${marketId}/${resolution}`,
  }),
  SUBSCRIBE_MARKET_ORDER_BOOK: (marketId: number) => ({
    type: 'subscribe' as const,
    channel: `order_book@tier2/${marketId}`,
  }),
  UNSUBSCRIBE_MARKET_ORDER_BOOK: (marketId: number) => ({
    type: 'unsubscribe' as const,
    channel: `order_book@tier2/${marketId}`,
  }),
  SUBSCRIBE_PERPS_MARKETS_STATS: (flushInterval?: number) => ({
    type: 'subscribe' as const,
    channel: 'market_stats/all',
    ...(typeof flushInterval === 'number' ? { flush_interval: flushInterval.toFixed(0) } : {}),
  }),
  UNSUBSCRIBE_PERPS_MARKETS_STATS: () => ({
    type: 'unsubscribe' as const,
    channel: 'market_stats/all',
  }),
  SUBSCRIBE_SPOT_MARKETS_STATS: (flushInterval?: number) => ({
    type: 'subscribe' as const,
    channel: 'spot_market_stats/all',
    ...(typeof flushInterval === 'number' ? { flush_interval: flushInterval.toFixed(0) } : {}),
  }),
  UNSUBSCRIBE_SPOT_MARKETS_STATS: () => ({
    type: 'unsubscribe' as const,
    channel: 'spot_market_stats/all',
  }),
  SUBSCRIBE_ASSET_STATS: (flushInterval?: number) => ({
    type: 'subscribe' as const,
    channel: 'asset_stats/all',
    ...(typeof flushInterval === 'number' ? { flush_interval: flushInterval.toFixed(0) } : {}),
  }),
  UNSUBSCRIBE_ASSET_STATS: () => ({ type: 'unsubscribe' as const, channel: 'asset_stats/all' }),
  SUBSCRIBE_BLOCK_HEIGHT: () => ({ type: 'subscribe' as const, channel: 'height' }),
  SUBSCRIBE_RFQS: (auth: string) => ({ type: 'subscribe' as const, channel: 'rfq', auth }),
  UNSUBSCRIBE_RFQS: () => ({ type: 'unsubscribe' as const, channel: 'rfq' }),
  SUBSCRIBE_ACCOUNT_TRANSACTIONS: (account: number, auth?: string) => ({
    type: 'subscribe' as const,
    channel: `account_tx/${account}`,
    ...(typeof auth === 'string' ? { auth } : {}),
  }),
  UNSUBSCRIBE_ACCOUNT_TRANSACTIONS: (account: number) => ({
    type: 'unsubscribe' as const,
    channel: `account_tx/${account}`,
  }),
  SUBSCRIBE_ACCOUNT_NOTIFICATION: (account: number, auth?: string) => ({
    type: 'subscribe' as const,
    channel: `notification/${account}`,
    ...(typeof auth === 'string' ? { auth } : {}),
  }),
  UNSUBSCRIBE_ACCOUNT_NOTIFICATION: (account: number) => ({
    type: 'unsubscribe' as const,
    channel: `notification/${account}`,
  }),
  SUBSCRIBE_LIVE_POINTS: (account: number, auth?: string) => ({
    type: 'subscribe' as const,
    channel: `live_points/${account}`,
    ...(typeof auth === 'string' ? { auth } : {}),
  }),
  UNSUBSCRIBE_LIVE_POINTS: (account: number) => ({
    type: 'unsubscribe' as const,
    channel: `live_points/${account}`,
  }),
  SUBSCRIBE_AGENT: (account: number, auth: string) => ({
    type: 'subscribe' as const,
    channel: `agent/${account}`,
    auth,
  }),
  UNSUBSCRIBE_AGENT: (account: number) => ({
    type: 'unsubscribe' as const,
    channel: `agent/${account}`,
  }),
  AGENT_QUESTION: (account: number, auth: string, id: string, question: string) => ({
    type: 'jsonapi/agent' as const,
    channel: `agent/${account}`,
    auth,
    data: { id, question },
  }),
}

// Mark-price preference flips candle channels between candle <-> mark_price_candle.
useLighterStore.subscribe(
  (state) => state.preferences.showMarkPriceCandles,
  () => {
    useWsSubStore.getState().actions.syncSharedCandleSubscription()
  },
)
