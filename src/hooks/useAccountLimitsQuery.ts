import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useLighterStore } from '../store/useLighterStore'
import { selectAccountExistence, selectUserAccountIndex } from '../store/user/selectors'
import { apis } from '../lib/apis'
import { useIsPoolAccount } from './useIsPoolAccount'
import type { ExtendedUserTier, UserTier } from '../types/user-tiers'

export const useAccountLimitsQuery = () => {
  const isAuthenticated = useLighterStore(selectAccountExistence) === 'Exists'
  const accountIndex = useLighterStore(selectUserAccountIndex)

  return useQuery({
    queryKey: ['account_limits', accountIndex],
    queryFn: () => apis.accountApi.accountLimits({ account_index: accountIndex }),
    enabled: isAuthenticated,
    refetchInterval: 60_000,
    staleTime: 60_000,
  })
}

export const useInitAccountLimits = () => {
  const accountLimitsQuery = useAccountLimitsQuery()
  const isPoolAccount = useIsPoolAccount()

  useEffect(() => {
    if (!accountLimitsQuery.data) return

    const { user_tier, user_tier_name, user_tier_last_update } = accountLimitsQuery.data
    let userTier: UserTier =
      user_tier === 'premium' || user_tier === 'plus' ? user_tier : 'standard'
    const validExtendedTiers: ExtendedUserTier[] = [
      'standard',
      'plus',
      'premium',
      'premium_1',
      'premium_2',
      'premium_3',
      'premium_4',
      'premium_5',
      'premium_6',
      'premium_7',
    ]
    let userTierName = validExtendedTiers.includes(user_tier_name as ExtendedUserTier)
      ? (user_tier_name as ExtendedUserTier)
      : null
    if (isPoolAccount) {
      userTier = 'premium'
      userTierName = 'premium'
    }

    useLighterStore.setState({
      accountLimits: accountLimitsQuery.data,
      userTier,
      userTierName,
      userTierLastUpdate: user_tier_last_update ?? null,
    })
  }, [accountLimitsQuery.data, isPoolAccount])
}
