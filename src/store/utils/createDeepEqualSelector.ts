import { isEqual } from 'lodash-es'
import { createSelectorCreator, lruMemoize } from 'reselect'

import { SELECTOR_MAX_LRU_CACHE_SIZE } from './consts'

export const createDeepEqualSelector = createSelectorCreator({
  memoize: lruMemoize,
  memoizeOptions: { resultEqualityCheck: isEqual, maxSize: SELECTOR_MAX_LRU_CACHE_SIZE },
  argsMemoize: lruMemoize,
  argsMemoizeOptions: { maxSize: SELECTOR_MAX_LRU_CACHE_SIZE },
})
