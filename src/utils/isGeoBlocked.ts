import type { GeoApi } from 'zklighter-perps'

import { isGeoBlockEnabled } from '../lib/env'
import { parseErrorFromCodegen } from './parseErrorFromCodegen'

const GEO_BLOCKED_ERROR_CODE = 20558

export const isGeoBlocked = async (geoApi: GeoApi): Promise<boolean> => {
  if (!isGeoBlockEnabled()) {
    return false
  }

  try {
    await geoApi.geoLocation()
    return false
  } catch (e) {
    try {
      const err = await parseErrorFromCodegen(e)
      return err.code === GEO_BLOCKED_ERROR_CODE
    } catch {
      return false
    }
  }
}
