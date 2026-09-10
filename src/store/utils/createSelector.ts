import { createSelectorCreator, lruMemoize } from 'reselect'

import { SELECTOR_MAX_LRU_CACHE_SIZE } from './consts'

export const createSelector = createSelectorCreator({
  memoize: lruMemoize,
  memoizeOptions: { maxSize: SELECTOR_MAX_LRU_CACHE_SIZE },
  argsMemoize: lruMemoize,
  argsMemoizeOptions: { maxSize: SELECTOR_MAX_LRU_CACHE_SIZE },
})
