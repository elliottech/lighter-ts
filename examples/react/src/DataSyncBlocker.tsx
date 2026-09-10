import type { PropsWithChildren } from 'react'
import {
  isRobinhoodEnv,
  selectAssetMetasLoaded,
  selectOrderBookMetasLoaded,
  useInitAssetMetas,
  useInitL1Info,
  useInitOrderBookMetas,
  useInitSystemConfig,
  useInitTokens,
  useLighterStore,
} from 'lighter-ts'

const DataSyncBlocker = ({ children }: PropsWithChildren) => {
  const orderBookMetasLoaded = useLighterStore(selectOrderBookMetasLoaded)
  const assetMetasLoaded = useLighterStore(selectAssetMetasLoaded)
  useInitTokens()
  useInitOrderBookMetas()
  useInitAssetMetas()
  useInitSystemConfig()
  useInitL1Info()

  if (isRobinhoodEnv() && (!orderBookMetasLoaded || !assetMetasLoaded)) {
    return (
      <div>
        <span>Loading</span>
      </div>
    )
  }

  return children
}

export default DataSyncBlocker
