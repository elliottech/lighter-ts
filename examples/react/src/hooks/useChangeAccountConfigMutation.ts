import { useMutation } from '@tanstack/react-query'
import {
  AccountTradingMode,
  selectUserAccountIndex,
  updateAccountConfig,
  useLighterStore,
} from 'lighter-ts'

interface ChangeAccountConfigMutationParams {
  accountTradingMode: number
}

export const useChangeAccountConfigMutation = () => {
  const accountIndex = useLighterStore(selectUserAccountIndex)

  return useMutation({
    mutationFn: ({ accountTradingMode }: ChangeAccountConfigMutationParams) =>
      updateAccountConfig({ accountIndex, accountTradingMode }),
    onSuccess: (_, { accountTradingMode }) => {
      useLighterStore.setState({ accountTradingMode })

      if (accountTradingMode === AccountTradingMode.CLASSIC) {
        useLighterStore.setState({ showAccountTradingModeModal: false })
      }
    },
    onError: (error) => {
      console.error(error)
    },
  })
}
