import type { AssetMeta, PerpsOrderBookDetail, SpotOrderBookDetail } from '../types/compatibility'
import fields from './pickedFields.json'

type KeysOf<T> = (keyof T)[]

export const SPOT_OB_FIELDS = fields.SPOT_OB_FIELDS as KeysOf<SpotOrderBookDetail>
export const PERPS_OB_FIELDS = fields.PERPS_OB_FIELDS as KeysOf<PerpsOrderBookDetail>
export const ASSET_FIELDS = fields.ASSET_FIELDS as KeysOf<AssetMeta>
