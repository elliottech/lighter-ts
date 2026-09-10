import { processWasmCall, processWasmError, waitForWasm } from './utils'
import { type Signers } from 'lighter-ts'

const NIL_MARKET_INDEX = 255

export const signers: Signers = {
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
      window._signCreateOrder(
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
      window._signCreateGroupedOrders(
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
    processWasmCall(window._signCancelOrder(accountIndex, marketId, orderId, nonce)).then(
      processWasmError,
    ),

  signCancelAllOrders: ({ accountIndex, timeInForce, time, nonce, marketId }) =>
    processWasmCall(
      window._signCancelAllOrders(
        accountIndex,
        timeInForce,
        time,
        nonce,
        marketId ?? NIL_MARKET_INDEX,
      ),
    ).then(processWasmError),

  signModifyOrder: ({ accountIndex, marketId, orderId, baseAmount, price, triggerPrice, nonce }) =>
    processWasmCall(
      window._signModifyOrder(
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
      window._signUpdateMargin(accountIndex, marketId, usdcAmount, direction, nonce),
    ).then(processWasmError),

  signUpdateLeverage: ({ accountIndex, marketId, initialMarginFraction, marginMode, nonce }) =>
    processWasmCall(
      window._signUpdateLeverage(accountIndex, marketId, initialMarginFraction, marginMode, nonce),
    ).then(processWasmError),

  signUpdateAccountConfig: ({ accountIndex, accountTradingMode, nonce }) =>
    processWasmCall(window._signUpdateAccountConfig(accountIndex, accountTradingMode, nonce)).then(
      processWasmError,
    ),

  signUpdateAccountAssetConfig: ({ accountIndex, assetIndex, assetMarginMode, nonce }) =>
    processWasmCall(
      window._signUpdateAccountAssetConfig(accountIndex, assetIndex, assetMarginMode, nonce),
    ).then(processWasmError),

  signCreateSubAccount: ({ accountIndex, nonce }) =>
    processWasmCall(window._signCreateSubAccount(accountIndex, nonce)).then(processWasmError),

  signCreatePublicPool: ({
    accountIndex,
    operatorFee,
    initialTotalShares,
    minOperatorShareRate,
    nonce,
  }) =>
    processWasmCall(
      window._signCreatePublicPool(
        accountIndex,
        operatorFee,
        initialTotalShares,
        minOperatorShareRate,
        nonce,
      ),
    ).then(processWasmError),

  signMintShares: ({ accountIndex, publicPoolIndex, shareAmount, nonce }) =>
    processWasmCall(window._signMintShares(accountIndex, publicPoolIndex, shareAmount, nonce)).then(
      processWasmError,
    ),

  signBurnShares: ({ accountIndex, publicPoolIndex, shareAmount, nonce }) =>
    processWasmCall(window._signBurnShares(accountIndex, publicPoolIndex, shareAmount, nonce)).then(
      processWasmError,
    ),

  signUpdatePublicPool: ({
    accountIndex,
    publicPoolIndex,
    status,
    operatorFee,
    minOperatorShareRate,
    nonce,
  }) =>
    processWasmCall(
      window._signUpdatePublicPool(
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
      window._signStakeAssets(accountIndex, stakingPoolIndex, shareAmount, nonce),
    ).then(processWasmError),

  signUnstakeAssets: ({ accountIndex, stakingPoolIndex, shareAmount, nonce }) =>
    processWasmCall(
      window._signUnstakeAssets(accountIndex, stakingPoolIndex, shareAmount, nonce),
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
      window._getTransferTransaction(
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
      window._signTransfer(
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
      window._getApproveIntegratorTransaction(
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
      window._signApproveIntegrator(
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
      window._signWithdraw(accountIndex, assetId, routeType, assetAmount, nonce),
    ).then(processWasmError),

  createClient: ({ seed, chainId, accountIndex, nonce, apiKeyIndex, skipNonce }) =>
    processWasmCall(
      window._createClient(seed, chainId, accountIndex, nonce, apiKeyIndex, skipNonce ?? false),
    ).then(processWasmError),

  createAuthToken: ({ accountIndex, apiKeyIndex }) =>
    waitForWasm().then(() =>
      processWasmCall(window._createAuthToken(accountIndex, apiKeyIndex)).then(processWasmError),
    ),

  getChangePubKeyTransaction: ({ accountIndex, nonce, apiKeyIndex }) =>
    processWasmCall(window._getChangePubKeyTransaction(accountIndex, nonce, apiKeyIndex)).then(
      processWasmError,
    ),

  getRevokePubKeyTransaction: ({ accountIndex, nonce, apiKeyIndex }) =>
    processWasmCall(window._getRevokePubKeyTransaction(accountIndex, nonce, apiKeyIndex)).then(
      processWasmError,
    ),

  signChangePubKey: ({ accountIndex, signature, nonce, apiKeyIndex }) =>
    processWasmCall(window._signChangePubKey(accountIndex, signature, nonce, apiKeyIndex)).then(
      processWasmError,
    ),

  signRevokePubKey: ({ accountIndex, signature, nonce, apiKeyIndex }) =>
    processWasmCall(window._signRevokePubKey(accountIndex, signature, nonce, apiKeyIndex)).then(
      processWasmError,
    ),

  getAirdropAllocationMessage: ({ accountIndex, allocations }) =>
    processWasmCall(window._getAirdropAllocationMessage(accountIndex, allocations)).then(
      processWasmError,
    ),
}
