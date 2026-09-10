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
      <div className="boot">
        <div>
          <span className="spinner" />
          <span>Loading markets…</span>
        </div>
      </div>
    )
  }

  return children
}

export default DataSyncBlocker
