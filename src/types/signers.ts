import type { RouteType } from '../store/types'
import type {
  CancelAllOrdersParams,
  CancelOrderParams,
  CreateOrderParams,
  GroupedOrderParams,
  ModifyOrderParams,
  TxResponse,
} from './order'

export type UpdateMarginParams = {
  accountIndex: number
  marketId: number
  usdcAmount: number
  direction: 0 | 1
}

export type UpdateLeverageParams = {
  accountIndex: number
  marketId: number
  marginMode: number
  initialMarginFraction: number
}

export type UpdateAccountConfigParams = {
  accountIndex: number
  accountTradingMode: number
}

export type UpdateAccountAssetConfigParams = {
  accountIndex: number
  assetIndex: number
  assetMarginMode: number
}

export type CreateSubAccountParams = {
  accountIndex: number
}

export type CreatePublicPoolParams = {
  accountIndex: number
  operatorFee: number
  initialTotalShares: number
  minOperatorShareRate: number
}

export type SharesParams = {
  accountIndex: number
  publicPoolIndex: number
  shareAmount: string
}

export type UpdatePublicPoolParams = {
  accountIndex: number
  publicPoolIndex: number
  status: number
  operatorFee: number
  minOperatorShareRate: number
}

export type StakeParams = {
  accountIndex: number
  stakingPoolIndex: number
  shareAmount: string
}

export type WithdrawParams = {
  accountIndex: number
  assetId: number
  routeType: RouteType
  assetAmount: string
}

export type TransferParams = {
  accountIndex: number
  signature: string
  toAccountIndex: number
  assetId: number
  fromRouteType: RouteType
  toRouteType: RouteType
  assetAmount: number
  usdcFee: number
  memo?: number[]
  nonce?: number
  apiKeyIndex?: number
}

export type TransferMemo = number[] | string

export type PrepareTransferRequestParams = {
  signMessage?: (message: string) => Promise<string | undefined>
  accountIndex: number
  toAccountIndex: number
  assetId: number
  fromRouteType: RouteType
  toRouteType: RouteType
  assetAmount: number
  usdcFee: number
  targetAddress?: string
  memo?: TransferMemo
}

export type PreparedTransferRequest = {
  accountIndex: number
  toAccountIndex: number
  assetAmount: number
  assetId: number
  fromRouteType: RouteType
  toRouteType: RouteType
  usdcFee: number
  signature: string
  memo?: number[]
  nonce: number
  apiKeyIndex: number
}

export type TransferTransactionParams = {
  accountIndex: number
  toAccountIndex: number
  assetId: number
  fromRouteType: RouteType
  toRouteType: RouteType
  assetAmount: number
  usdcFee: number
  apiKeyIndex: number
  memo?: number[]
}

export type TransferTransaction = { body: string }

export type CreateClientParams = {
  seed: string
  chainId: number
  accountIndex: number
  nonce: number
  apiKeyIndex: number
  skipNonce?: boolean
}

export type CreateClientResult = { pk: string; prv: string; body: string }

export type PubKeyTransactionParams = {
  accountIndex: number
  nonce: number
  apiKeyIndex: number
}

export type PubKeyTransaction = { pk: string; body: string }

export type PubKeySignParams = {
  accountIndex: number
  signature: string
  nonce: number
  apiKeyIndex: number
}

export type CreateAuthTokenParams = {
  accountIndex: number
  apiKeyIndex: number
}

export type AuthToken = { token: string; deadline: number }

export type AirdropAllocationParams = {
  accountIndex: number
  allocations: string
}

export type AirdropAllocationMessage = { message: string }

// Fees are in millionths of notional (FeeTick = 1_000_000 <=> 100%, so 1 bp = 100)
export type ApproveIntegratorTxParams = {
  accountIndex: number
  integratorAccountIndex: number
  maxPerpsTakerFee: number
  maxPerpsMakerFee: number
  maxSpotTakerFee: number
  maxSpotMakerFee: number
  approvalExpiry: number
}

export type ApproveIntegratorTransactionParams = ApproveIntegratorTxParams & {
  nonce: number
  apiKeyIndex: number
}

export type ApproveIntegratorTransaction = { body: string }

export type PrepareApproveIntegratorRequestParams = ApproveIntegratorTxParams & {
  signMessage: (message: string) => Promise<string | undefined>
}

// apiKeyIndex is part of the signed L1 body, so it is carried from the prepare
// step rather than re-read at submit time — the wallet prompt in between can
// outlast a change of active API key.
export type PreparedApproveIntegratorRequest = ApproveIntegratorTransactionParams & {
  signature: string
}

export interface Signers {
  signCreateOrder: (
    params: CreateOrderParams & { nonce: number; clientOrderIndex: number },
  ) => Promise<TxResponse>
  signCancelOrder: (params: CancelOrderParams & { nonce: number }) => Promise<TxResponse>
  signCancelAllOrders: (params: CancelAllOrdersParams & { nonce: number }) => Promise<TxResponse>
  signModifyOrder: (params: ModifyOrderParams & { nonce: number }) => Promise<TxResponse>
  signCreateGroupedOrders: (
    params: Omit<GroupedOrderParams, 'orders'> & {
      nonce: number
      orders: (CreateOrderParams & { clientOrderIndex: number })[]
    },
  ) => Promise<TxResponse>

  signUpdateMargin: (params: UpdateMarginParams & { nonce: number }) => Promise<TxResponse>
  signUpdateLeverage: (params: UpdateLeverageParams & { nonce: number }) => Promise<TxResponse>
  signUpdateAccountConfig: (
    params: UpdateAccountConfigParams & { nonce: number },
  ) => Promise<TxResponse>
  signUpdateAccountAssetConfig: (
    params: UpdateAccountAssetConfigParams & { nonce: number },
  ) => Promise<TxResponse>

  signCreateSubAccount: (params: CreateSubAccountParams & { nonce: number }) => Promise<TxResponse>

  signCreatePublicPool: (params: CreatePublicPoolParams & { nonce: number }) => Promise<TxResponse>
  signMintShares: (params: SharesParams & { nonce: number }) => Promise<TxResponse>
  signBurnShares: (params: SharesParams & { nonce: number }) => Promise<TxResponse>
  signUpdatePublicPool: (params: UpdatePublicPoolParams & { nonce: number }) => Promise<TxResponse>
  signStakeAssets: (params: StakeParams & { nonce: number }) => Promise<TxResponse>
  signUnstakeAssets: (params: StakeParams & { nonce: number }) => Promise<TxResponse>

  signTransfer: (
    params: TransferParams & { nonce: number; apiKeyIndex: number },
  ) => Promise<TxResponse>
  getApproveIntegratorTransaction: (
    params: ApproveIntegratorTransactionParams,
  ) => Promise<ApproveIntegratorTransaction>
  signApproveIntegrator: (
    params: ApproveIntegratorTransactionParams & { signature: string },
  ) => Promise<TxResponse>
  signWithdraw: (params: WithdrawParams & { nonce: number }) => Promise<TxResponse>
  getTransferTransaction: (
    params: TransferTransactionParams & { nonce: number },
  ) => Promise<TransferTransaction>

  createClient: (params: CreateClientParams) => Promise<CreateClientResult>
  createAuthToken: (params: CreateAuthTokenParams) => Promise<AuthToken>
  getChangePubKeyTransaction: (params: PubKeyTransactionParams) => Promise<PubKeyTransaction>
  getRevokePubKeyTransaction: (params: PubKeyTransactionParams) => Promise<PubKeyTransaction>
  signChangePubKey: (params: PubKeySignParams) => Promise<TxResponse>
  signRevokePubKey: (params: PubKeySignParams) => Promise<TxResponse>
  getAirdropAllocationMessage: (
    params: AirdropAllocationParams,
  ) => Promise<AirdropAllocationMessage>
}
