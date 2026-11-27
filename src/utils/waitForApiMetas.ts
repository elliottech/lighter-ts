import { type LighterStore, useLighterStore } from '../store/useLighterStore'

const apiMetasLoaded = (state: LighterStore) => state.orderBookMetasLoaded && state.assetMetasLoaded

export const waitForApiMetas = () =>
  new Promise<void>((resolve) => {
    if (apiMetasLoaded(useLighterStore.getState())) {
      resolve()
      return
    }
    const unsubscribe = useLighterStore.subscribe((state) => {
      if (!apiMetasLoaded(state)) return
      unsubscribe()
      resolve()
    })
  })
