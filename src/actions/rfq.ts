import { DRAFT_RFQ_ID } from '../constants/order'
import type { Rfq, RfqOrderBookSnapshot } from '../store/types'
import { useLighterStore } from '../store/useLighterStore'

export const setCurrentRfqId = (marketIndex: number, rfqId: number | null) => {
  const state = useLighterStore.getState()
  const accountIndex = state.accountIndex
  const accountRfqIds = { ...state.preferences.currentRfqIds[accountIndex] }

  if (rfqId === null) {
    delete accountRfqIds[marketIndex]
    setRfqOrderBookSnapshot(marketIndex, null)
  } else {
    accountRfqIds[marketIndex] = rfqId
  }

  state.setPreference('currentRfqIds', {
    ...state.preferences.currentRfqIds,
    [accountIndex]: accountRfqIds,
  })
}

export const setRfqOrderBookSnapshot = (
  marketIndex: number,
  snapshot: RfqOrderBookSnapshot | null,
) => {
  const state = useLighterStore.getState()
  const accountIndex = state.accountIndex
  const accountSnapshots = { ...state.preferences.rfqOrderBookSnapshots[accountIndex] }

  if (snapshot === null) {
    delete accountSnapshots[marketIndex]
  } else {
    accountSnapshots[marketIndex] = snapshot
  }

  state.setPreference('rfqOrderBookSnapshots', {
    ...state.preferences.rfqOrderBookSnapshots,
    [accountIndex]: accountSnapshots,
  })
}

const writeAccountRfq = (marketIndex: number, rfqId: number, rfq: Rfq) =>
  useLighterStore.setState((prevState) => {
    const accountRfqs = prevState.accounts[prevState.accountIndex]?.rfqs

    return {
      accounts: {
        ...prevState.accounts,
        [prevState.accountIndex]: {
          ...prevState.accounts[prevState.accountIndex],
          rfqs: {
            ...accountRfqs,
            [marketIndex]: { ...accountRfqs?.[marketIndex], [rfqId]: rfq },
          },
        },
      },
    }
  })

export const patchAccountRfq = (rfq: Rfq) => {
  writeAccountRfq(rfq.market_index, rfq.id, rfq)
  setCurrentRfqId(rfq.market_index, rfq.id)
}

export const confirmAccountRfq = (marketIndex: number, rfq: Rfq) => {
  useLighterStore.setState((prevState) => {
    const accountRfqs = prevState.accounts[prevState.accountIndex]?.rfqs
    const marketRfqs = { ...accountRfqs?.[marketIndex] }
    delete marketRfqs[DRAFT_RFQ_ID]

    marketRfqs[rfq.id] ??= rfq

    return {
      accounts: {
        ...prevState.accounts,
        [prevState.accountIndex]: {
          ...prevState.accounts[prevState.accountIndex],
          rfqs: { ...accountRfqs, [marketIndex]: marketRfqs },
        },
      },
    }
  })
  setCurrentRfqId(marketIndex, rfq.id)
}

export const removeAccountRfq = (marketIndex: number) => {
  const state = useLighterStore.getState()
  const currentRfqId = state.preferences.currentRfqIds[state.accountIndex]?.[marketIndex]

  if (currentRfqId !== undefined) {
    useLighterStore.setState((prevState) => {
      const accountRfqs = prevState.accounts[prevState.accountIndex]?.rfqs
      const { [currentRfqId]: removed, ...restMarketRfqs } = accountRfqs?.[marketIndex] ?? {}

      return {
        accounts: {
          ...prevState.accounts,
          [prevState.accountIndex]: {
            ...prevState.accounts[prevState.accountIndex],
            rfqs: { ...accountRfqs, [marketIndex]: restMarketRfqs },
          },
        },
      }
    })
  }

  setCurrentRfqId(marketIndex, null)
}
