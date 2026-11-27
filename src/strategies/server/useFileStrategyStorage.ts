import { setStrategyStorageBackend } from '../store/strategyStorage'
import { createFileStrategyStorageBackend } from './fileStrategyStorage'
import { readStoreDir } from './serverConfig'

// The master process holds the store dir's lock for this worker.
setStrategyStorageBackend(createFileStrategyStorageBackend(readStoreDir()))
