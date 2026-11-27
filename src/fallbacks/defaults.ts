import type { Layer1BasicInfo, SystemConfig } from 'zklighter-perps'

import type { BackendFeeTiers } from '../types/user-tiers'

import lighterFeeTiers from './mainnet/feeTiers.json'
import lighterL1Info from './mainnet/l1Info.json'
import lighterSystemConfig from './mainnet/systemConfig.json'
import robinhoodFeeTiers from './robinhood-mainnet/feeTiers.json'

export const defaultSystemConfig: SystemConfig = lighterSystemConfig
export const defaultL1Info: Layer1BasicInfo = lighterL1Info
export const defaultLighterFeeTiers: BackendFeeTiers = lighterFeeTiers
export const defaultRobinhoodFeeTiers: BackendFeeTiers = robinhoodFeeTiers
