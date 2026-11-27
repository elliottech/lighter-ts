import { shouldUseECDSA } from '../lib/env'
import type { Signers } from '../types/signers'
import type { WasmError, WasmExports } from './wasmTypes'

const NIL_MARKET_INDEX = 255

type KeyExports = Pick<
  WasmExports,
  | '_createClient'
  | '_getChangePubKeyTransaction'
  | '_getRevokePubKeyTransaction'
  | '_signChangePubKey'
  | '_signRevokePubKey'
>

const getKeyExports = (wasm: WasmExports, expiredAt?: number): KeyExports => {
  if (!shouldUseECDSA()) return wasm
  if (expiredAt === undefined)
    throw new Error('ECDSA pubkey transaction requires expiredAt in unix milliseconds')
  return {
    _createClient: (seed, chainId, accountIndex, nonce, apiKeyIndex, skipNonce) =>
      wasm._createECDSAClient(
        seed,
        chainId,
        accountIndex,
        nonce,
        expiredAt,
        apiKeyIndex,
        skipNonce,
      ),
    _getChangePubKeyTransaction: (accountIndex, nonce, apiKeyIndex) =>
      wasm._getChangeECDSAPubKeyTransaction(accountIndex, nonce, expiredAt, apiKeyIndex),
    _getRevokePubKeyTransaction: (accountIndex, nonce, apiKeyIndex) =>
      wasm._getRevokeECDSAPubKeyTransaction(accountIndex, nonce, expiredAt, apiKeyIndex),
    _signChangePubKey: (accountIndex, signature, nonce, apiKeyIndex) =>
      wasm._signChangeECDSAPubKey(accountIndex, signature, nonce, expiredAt, apiKeyIndex),
    _signRevokePubKey: (accountIndex, signature, nonce, apiKeyIndex) =>
      wasm._signRevokeECDSAPubKey(accountIndex, signature, nonce, expiredAt, apiKeyIndex),
  }
}

export const createWasmSigners = ({
  getWasm,
  processWasmCall,
  processWasmError,
  waitForWasm,
}: {
  getWasm: () => WasmExports
  processWasmCall: <T>(wasmCall: Promise<() => Promise<T>>) => Promise<T>
  processWasmError: <T extends object>(wasmResponse: T | WasmError) => T
  waitForWasm: () => Promise<unknown>
}): Signers => ({
  signCreateOrder: ({
    accountIndex,
    orderBookIndex,
    clientOrderIndex,
    baseAmount,
    price,
    isAsk,
    orderType,
    timeInForce,
    reduceOnly,
    triggerPrice,
    orderExpiry,
    nonce,
    integratorFees,
  }) =>
    processWasmCall(
      getWasm()._signCreateOrder(
        accountIndex,
        orderBookIndex,
        clientOrderIndex,
        baseAmount.toString(),
        price.toString(),
        isAsk,
        orderType,
        timeInForce,
        reduceOnly,
        triggerPrice.toString(),
        orderExpiry,
        nonce,
        // Omit entirely when there are no integrator fees: any value here,
        // even 0, makes the wasm sign the integrator-fee order variant
        ...(integratorFees
          ? [integratorFees.accountIndex, integratorFees.takerFee, integratorFees.makerFee]
          : []),
      ),
    ).then(processWasmError),

  signCreateGroupedOrders: ({ accountIndex, groupingType, orders, nonce, integratorFees }) => {
    const args = orders.reduce(
      (acc, order) => {
        acc.push(order.orderBookIndex)
        acc.push(order.clientOrderIndex)
        acc.push(order.baseAmount.toString())
        acc.push(order.price.toString())
        acc.push(order.isAsk)
        acc.push(order.orderType)
        acc.push(order.timeInForce)
        acc.push(order.reduceOnly)
        acc.push(order.triggerPrice.toString())
        acc.push(order.orderExpiry)
        return acc
      },
      [] as (string | number)[],
    )

    return processWasmCall(
      getWasm()._signCreateGroupedOrders(
        accountIndex,
        groupingType,
        orders.length,
        ...args,
        nonce,
        ...(integratorFees
          ? [integratorFees.accountIndex, integratorFees.takerFee, integratorFees.makerFee]
          : []),
      ),
    ).then(processWasmError)
  },

  signCancelOrder: ({ accountIndex, marketId, orderId, nonce }) =>
    processWasmCall(getWasm()._signCancelOrder(accountIndex, marketId, orderId, nonce)).then(
      processWasmError,
    ),

  signCancelAllOrders: ({ accountIndex, timeInForce, time, nonce, marketId }) =>
    processWasmCall(
      getWasm()._signCancelAllOrders(
        accountIndex,
        timeInForce,
        time,
        nonce,
        marketId ?? NIL_MARKET_INDEX,
      ),
    ).then(processWasmError),

  signModifyOrder: ({ accountIndex, marketId, orderId, baseAmount, price, triggerPrice, nonce }) =>
    processWasmCall(
      getWasm()._signModifyOrder(
        accountIndex,
        marketId,
        orderId,
        baseAmount,
        price,
        triggerPrice,
        nonce,
      ),
    ).then(processWasmError),

  signUpdateMargin: ({ accountIndex, marketId, usdcAmount, direction, nonce }) =>
    processWasmCall(
      getWasm()._signUpdateMargin(accountIndex, marketId, usdcAmount, direction, nonce),
    ).then(processWasmError),

  signUpdateLeverage: ({ accountIndex, marketId, initialMarginFraction, marginMode, nonce }) =>
    processWasmCall(
      getWasm()._signUpdateLeverage(
        accountIndex,
        marketId,
        initialMarginFraction,
        marginMode,
        nonce,
      ),
    ).then(processWasmError),

  signUpdateAccountConfig: ({ accountIndex, accountTradingMode, nonce }) =>
    processWasmCall(
      getWasm()._signUpdateAccountConfig(accountIndex, accountTradingMode, nonce),
    ).then(processWasmError),

  signUpdateAccountAssetConfig: ({ accountIndex, assetIndex, assetMarginMode, nonce }) =>
    processWasmCall(
      getWasm()._signUpdateAccountAssetConfig(accountIndex, assetIndex, assetMarginMode, nonce),
    ).then(processWasmError),

  signCreateSubAccount: ({ accountIndex, nonce }) =>
    processWasmCall(getWasm()._signCreateSubAccount(accountIndex, nonce)).then(processWasmError),

  signCreatePublicPool: ({
    accountIndex,
    operatorFee,
    initialTotalShares,
    minOperatorShareRate,
    nonce,
  }) =>
    processWasmCall(
      getWasm()._signCreatePublicPool(
        accountIndex,
        operatorFee,
        initialTotalShares,
        minOperatorShareRate,
        nonce,
      ),
    ).then(processWasmError),

  signMintShares: ({ accountIndex, publicPoolIndex, shareAmount, nonce }) =>
    processWasmCall(
      getWasm()._signMintShares(accountIndex, publicPoolIndex, shareAmount, nonce),
    ).then(processWasmError),

  signBurnShares: ({ accountIndex, publicPoolIndex, shareAmount, nonce }) =>
    processWasmCall(
      getWasm()._signBurnShares(accountIndex, publicPoolIndex, shareAmount, nonce),
    ).then(processWasmError),

  signUpdatePublicPool: ({
    accountIndex,
    publicPoolIndex,
    status,
    operatorFee,
    minOperatorShareRate,
    nonce,
  }) =>
    processWasmCall(
      getWasm()._signUpdatePublicPool(
        accountIndex,
        publicPoolIndex,
        status,
        operatorFee,
        minOperatorShareRate,
        nonce,
      ),
    ).then(processWasmError),

  signStakeAssets: ({ accountIndex, stakingPoolIndex, shareAmount, nonce }) =>
    processWasmCall(
      getWasm()._signStakeAssets(accountIndex, stakingPoolIndex, shareAmount, nonce),
    ).then(processWasmError),

  signUnstakeAssets: ({ accountIndex, stakingPoolIndex, shareAmount, nonce }) =>
    processWasmCall(
      getWasm()._signUnstakeAssets(accountIndex, stakingPoolIndex, shareAmount, nonce),
    ).then(processWasmError),

  getTransferTransaction: ({
    accountIndex,
    nonce,
    apiKeyIndex,
    toAccountIndex,
    assetId,
    fromRouteType,
    toRouteType,
    assetAmount,
    usdcFee,
    memo,
  }) =>
    processWasmCall(
      getWasm()._getTransferTransaction(
        accountIndex,
        nonce,
        apiKeyIndex,
        toAccountIndex,
        assetId,
        fromRouteType,
        toRouteType,
        assetAmount,
        usdcFee,
        memo ?? [],
      ),
    ).then(processWasmError),

  signTransfer: ({
    accountIndex,
    signature,
    nonce,
    apiKeyIndex,
    toAccountIndex,
    assetId,
    fromRouteType,
    toRouteType,
    assetAmount,
    usdcFee,
    memo,
  }) =>
    processWasmCall(
      getWasm()._signTransfer(
        accountIndex,
        signature,
        nonce,
        apiKeyIndex,
        toAccountIndex,
        assetId,
        fromRouteType,
        toRouteType,
        assetAmount,
        usdcFee,
        memo ?? [],
      ),
    ).then(processWasmError),

  getApproveIntegratorTransaction: ({
    accountIndex,
    nonce,
    apiKeyIndex,
    integratorAccountIndex,
    maxPerpsTakerFee,
    maxPerpsMakerFee,
    maxSpotTakerFee,
    maxSpotMakerFee,
    approvalExpiry,
  }) =>
    processWasmCall(
      getWasm()._getApproveIntegratorTransaction(
        accountIndex,
        nonce,
        apiKeyIndex,
        integratorAccountIndex,
        maxPerpsTakerFee,
        maxPerpsMakerFee,
        maxSpotTakerFee,
        maxSpotMakerFee,
        approvalExpiry,
      ),
    ).then(processWasmError),

  signApproveIntegrator: ({
    accountIndex,
    signature,
    nonce,
    apiKeyIndex,
    integratorAccountIndex,
    maxPerpsTakerFee,
    maxPerpsMakerFee,
    maxSpotTakerFee,
    maxSpotMakerFee,
    approvalExpiry,
  }) =>
    processWasmCall(
      getWasm()._signApproveIntegrator(
        accountIndex,
        signature,
        nonce,
        apiKeyIndex,
        integratorAccountIndex,
        maxPerpsTakerFee,
        maxPerpsMakerFee,
        maxSpotTakerFee,
        maxSpotMakerFee,
        approvalExpiry,
      ),
    ).then(processWasmError),

  signWithdraw: ({ accountIndex, assetId, routeType, assetAmount, nonce }) =>
    processWasmCall(
      getWasm()._signWithdraw(accountIndex, assetId, routeType, assetAmount, nonce),
    ).then(processWasmError),

  createClient: async ({ seed, chainId, accountIndex, nonce, apiKeyIndex, skipNonce, expiredAt }) =>
    processWasmCall(
      getKeyExports(getWasm(), expiredAt)._createClient(
        seed,
        chainId,
        accountIndex,
        nonce,
        apiKeyIndex,
        skipNonce ?? false,
      ),
    ).then(processWasmError),

  createAuthToken: ({ accountIndex, apiKeyIndex }) =>
    waitForWasm().then(() =>
      processWasmCall(getWasm()._createAuthToken(accountIndex, apiKeyIndex)).then(processWasmError),
    ),

  signStrategyServerCommand: ({ accountIndex, payload }) =>
    processWasmCall(getWasm()._signStrategyServerCommand(accountIndex, payload)).then(
      processWasmError,
    ),

  getChangePubKeyTransaction: async ({ accountIndex, nonce, apiKeyIndex, expiredAt }) =>
    processWasmCall(
      getKeyExports(getWasm(), expiredAt)._getChangePubKeyTransaction(
        accountIndex,
        nonce,
        apiKeyIndex,
      ),
    ).then(processWasmError),

  getRevokePubKeyTransaction: async ({ accountIndex, nonce, apiKeyIndex, expiredAt }) =>
    processWasmCall(
      getKeyExports(getWasm(), expiredAt)._getRevokePubKeyTransaction(
        accountIndex,
        nonce,
        apiKeyIndex,
      ),
    ).then(processWasmError),

  signChangePubKey: async ({ accountIndex, signature, nonce, apiKeyIndex, expiredAt }) =>
    processWasmCall(
      getKeyExports(getWasm(), expiredAt)._signChangePubKey(
        accountIndex,
        signature,
        nonce,
        apiKeyIndex,
      ),
    ).then(processWasmError),

  signRevokePubKey: async ({ accountIndex, signature, nonce, apiKeyIndex, expiredAt }) =>
    processWasmCall(
      getKeyExports(getWasm(), expiredAt)._signRevokePubKey(
        accountIndex,
        signature,
        nonce,
        apiKeyIndex,
      ),
    ).then(processWasmError),

  getAirdropAllocationMessage: ({ accountIndex, allocations }) =>
    processWasmCall(getWasm()._getAirdropAllocationMessage(accountIndex, allocations)).then(
      processWasmError,
    ),
})
