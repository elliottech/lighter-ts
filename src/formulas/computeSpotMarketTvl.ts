// Spot market TVL: the base asset's bridge-held L1 balance valued at its index price
export const computeSpotMarketTvl = (indexPrice?: number, l1Balance?: number) => {
  if (indexPrice === undefined || l1Balance === undefined) {
    return null
  }

  return l1Balance * indexPrice
}
