import { queryClient } from 'lighter-ts'

export const isRegistered = (accountIndex: number) =>
  !!queryClient.getQueryData(['isRegistered', accountIndex])
