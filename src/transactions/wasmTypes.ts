import type { TxResponse } from '../types/order'

export type WasmError = { error: string }
type WasmResponse<T> = Promise<() => Promise<T | WasmError>>

interface GoRuntime {
  importObject: WebAssembly.Imports
  run(instance: WebAssembly.Instance): Promise<void>
}

/** Set on `globalThis` by `wasm_exec.js`. */
export type GoConstructor = new () => GoRuntime

/** Functions the signer wasm registers on `globalThis` once it runs. */
export interface WasmExports {
  _createECDSAClient: (
    seed: string,
    chainId: number,
    accountIndex: number,
    nonce: number,
    expiredAt: number,
    apiKeyIndex: number,
    skipNonce?: boolean,
  ) => WasmResponse<{ pk: string; prv: string; body: string }>
  _getChangeECDSAPubKeyTransaction: (
    accountIndex: number,
    nonce: number,
    expiredAt: number,
    apiKeyIndex: number,
  ) => ReturnType<WasmExports['_getChangePubKeyTransaction']>
  _getRevokeECDSAPubKeyTransaction: (
    accountIndex: number,
    nonce: number,
    expiredAt: number,
    apiKeyIndex: number,
  ) => ReturnType<WasmExports['_getRevokePubKeyTransaction']>
  _signChangeECDSAPubKey: (
    accountIndex: number,
    signature: string,
    nonce: number,
    expiredAt: number,
    apiKeyIndex: number,
  ) => WasmResponse<TxResponse>
  _signRevokeECDSAPubKey: (
    accountIndex: number,
    signature: string,
    nonce: number,
    expiredAt: number,
    apiKeyIndex: number,
  ) => WasmResponse<TxResponse>
  _createClient: (
    seed: string,
    chainId: number,
    accountIndex: number,
    nonce: number,
    apiKeyIndex: number,
    skipNonce?: boolean,
  ) => WasmResponse<{ pk: string; prv: string; body: string }>
  _signChangePubKey: (
    accountIndex: number,
    signature: string,
    nonce: number,
    apiKeyIndex: number,
  ) => WasmResponse<TxResponse>
  _signRevokePubKey: (
    accountIndex: number,
    signature: string,
    nonce: number,
    apiKeyIndex: number,
  ) => WasmResponse<TxResponse>
  _signCreateOrder: (
    accountIndex: number,
    orderBookIndex: number,
    clientOrderIndex: number,
    baseAmount: string,
    price: string,
    isAsk: number,
    orderType: number,
    timeInForce: number,
    reduceOnly: number,
    triggerPrice: string,
    orderExpiry: number,
    nonce: number,
    integratorAccountIndex?: number,
    integratorTakerFee?: number,
    integratorMakerFee?: number,
  ) => WasmResponse<TxResponse>
  _signCreateGroupedOrders: (
    accountIndex: number,
    groupingType: number,
    orderCount: number,
    ...rest: (string | number)[]
  ) => WasmResponse<TxResponse>
  _signCancelOrder: (
    accountIndex: number,
    marketId: number,
    orderId: string,
    nonce: number,
  ) => WasmResponse<TxResponse>
  _signCreateSubAccount: (accountIndex: number, nonce: number) => WasmResponse<TxResponse>
  _signCancelAllOrders: (
    accountIndex: number,
    timeInForce: number,
    time: number,
    nonce: number,
    marketId?: number,
  ) => WasmResponse<TxResponse>
  _signModifyOrder: (
    accountIndex: number,
    marketId: number,
    orderId: string,
    newBaseAmount: number,
    newPrice: number,
    triggerPrice: number,
    nonce: number,
  ) => WasmResponse<TxResponse>
  _signTransfer: (
    accountIndex: number,
    signature: string,
    nonce: number,
    apiKeyIndex: number,
    toAccountIndex: number,
    assetId: number,
    fromRouteType: number,
    toRouteType: number,
    assetAmount: number,
    usdcFee: number,
    memo?: Array<number>,
  ) => WasmResponse<TxResponse>
  // ========= Public Pool =========
  _signCreatePublicPool: (
    accountIndex: number,
    operatorFee: number,
    initialTotalShares: number,
    minOperatorShareRate: number,
    nonce: number,
  ) => WasmResponse<TxResponse>
  _signMintShares: (
    accountIndex: number,
    publicPoolIndex: number,
    shareAmount: string,
    nonce: number,
  ) => WasmResponse<TxResponse>
  _signBurnShares: (
    accountIndex: number,
    publicPoolIndex: number,
    shareAmount: string,
    nonce: number,
  ) => WasmResponse<TxResponse>
  _signStakeAssets: (
    accountIndex: number,
    stakingPoolIndex: number,
    shareAmount: string,
    nonce: number,
  ) => WasmResponse<TxResponse>
  _signUnstakeAssets: (
    accountIndex: number,
    stakingPoolIndex: number,
    shareAmount: string,
    nonce: number,
  ) => WasmResponse<TxResponse>
  _signUpdatePublicPool: (
    accountIndex: number,
    publicPoolIndex: number,
    status: number,
    operatorFee: number,
    minOperatorShareRate: number,
    nonce: number,
  ) => WasmResponse<TxResponse>
  _createAuthToken: (
    accountIndex: number,
    apiKeyIndex: number,
  ) => WasmResponse<{
    accountIndex: number
    deadline: number
    apiKeyIndex: number
    signature: string
    token: string
  }>
  _signStrategyServerCommand: (
    accountIndex: number,
    payload: string,
  ) => WasmResponse<{ signature: string }>
  _verifyStrategyServerCommand: (
    keyType: number,
    publicKey: string,
    payload: string,
    signature: string,
  ) => WasmResponse<{ valid: boolean }>
  _signUpdateLeverage: (
    accountIndex: number,
    marketId: number,
    initialMarginFraction: number,
    marginMode: number,
    nonce: number,
  ) => WasmResponse<TxResponse>
  _signUpdateAccountConfig: (
    accountIndex: number,
    accountTradingMode: number,
    nonce: number,
  ) => WasmResponse<TxResponse>
  _signUpdateAccountAssetConfig: (
    accountIndex: number,
    assetIndex: number,
    assetMarginMode: number,
    nonce: number,
  ) => WasmResponse<TxResponse>
  _signUpdateMargin: (
    accountIndex: number,
    marketId: number,
    usdcAmount: number,
    direction: 0 | 1,
    nonce: number,
  ) => WasmResponse<TxResponse>
  _signWithdraw: (
    accountIndex: number,
    assetId: number,
    routeType: number,
    assetAmount: string,
    nonce: number,
  ) => WasmResponse<TxResponse>
  _getRevokePubKeyTransaction: (
    accountIndex: number,
    nonce: number,
    apiKeyIndex: number,
  ) => WasmResponse<{
    success: boolean
    pk: string
    pubKeySuccess: boolean
    body: string
  }>
  _getChangePubKeyTransaction: (
    accountIndex: number,
    nonce: number,
    apiKeyIndex: number,
  ) => WasmResponse<{ pk: string; body: string }>
  _getApproveIntegratorTransaction: (
    accountIndex: number,
    nonce: number,
    apiKeyIndex: number,
    integratorAccountIndex: number,
    maxPerpsTakerFee: number,
    maxPerpsMakerFee: number,
    maxSpotTakerFee: number,
    maxSpotMakerFee: number,
    approvalExpiry: number,
  ) => WasmResponse<{ body: string }>
  _signApproveIntegrator: (
    accountIndex: number,
    signature: string,
    nonce: number,
    apiKeyIndex: number,
    integratorAccountIndex: number,
    maxPerpsTakerFee: number,
    maxPerpsMakerFee: number,
    maxSpotTakerFee: number,
    maxSpotMakerFee: number,
    approvalExpiry: number,
  ) => WasmResponse<TxResponse>
  _getTransferTransaction: (
    accountIndex: number,
    nonce: number,
    apiKeyIndex: number,
    toAccountIndex: number,
    assetId: number,
    fromRouteType: number,
    toRouteType: number,
    assetAmount: number,
    usdcFee: number,
    memo?: Array<number>,
  ) => WasmResponse<{ pk: string; body: string }>
  _getAirdropAllocationMessage: (
    accountIndex: number,
    allocations: string,
  ) => WasmResponse<{ message: string }>
}
