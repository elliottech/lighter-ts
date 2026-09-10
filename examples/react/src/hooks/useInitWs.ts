import { useEffect } from 'react'
import { selectUserAccountIndex, useLighterStore, useWsSubStore, type Encoding } from 'lighter-ts'
import { useIsAuthenticated } from './useSyncAccountExistence'
import { waitForWasm } from '../lib'
import { getOrCreateAuthToken } from '../utils/auth'

const PING_INTERVAL = 2500
const PONG_TIMEOUT = 12000

const ENCODING = 'json' as Encoding
const CUSTOM_SERVER = null as string | null

export const useInitWs = () => {
  const ws = useWsSubStore((state) => state.ws)
  const accountIndex = useLighterStore(selectUserAccountIndex)
  const isAuthed = useIsAuthenticated()

  useEffect(() => {
    void useWsSubStore.getState().actions.init(
      import.meta.env.VITE_WS_API_BASE,
      () => {},
      () => getOrCreateAuthToken(accountIndex),
      ENCODING,
      CUSTOM_SERVER,
    )

    const interval = setInterval(() => {
      void useWsSubStore.getState().actions.init(
        import.meta.env.VITE_WS_API_BASE,
        () => {},
        () => getOrCreateAuthToken(accountIndex),
        ENCODING,
        CUSTOM_SERVER,
      )
    }, PING_INTERVAL)

    return () => clearInterval(interval)
  }, [accountIndex])

  useEffect(() => {
    if (!ws) {
      return
    }

    useWsSubStore
      .getState()
      .actions.switchAccount(accountIndex, isAuthed, waitForWasm, getOrCreateAuthToken)
  }, [ws, accountIndex, isAuthed])

  useEffect(() => {
    if (!ws) {
      return
    }

    useWsSubStore.getState().actions.subscribeHeight()

    const interval = setInterval(() => {
      const lastPingTime = useWsSubStore.getState().lastPingTime
      const lastPongTime = useWsSubStore.getState().lastPongTime

      if (lastPingTime && lastPongTime && lastPingTime - lastPongTime > PONG_TIMEOUT) {
        useWsSubStore.getState().actions.forceClose()
        return
      }
      useWsSubStore.getState().actions.ping()
    }, PING_INTERVAL)

    return () => clearInterval(interval)
  }, [ws])
}
