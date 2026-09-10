export enum TxTypes {
  TxTypeL2ChangePubKey = 8,
  TxTypeL2CreateSubAccount = 9,
  TxTypeL2CreatePublicPool = 10,
  TxTypeL2UpdatePublicPool = 11,
  TxTypeL2Transfer = 12,
  TxTypeL2Withdraw = 13,
  TxTypeL2CreateOrder = 14,
  TxTypeL2CancelOrder = 15,
  TxTypeL2CancelAllOrders = 16,
  TxTypeL2ModifyOrder = 17,
  TxTypeL2MintShares = 18,
  TxTypeL2BurnShares = 19,
  TxTypeL2UpdateLeverage = 20,
  TxTypeL2CreateGroupedOrders = 28,
  TxTypeL2UpdateMargin = 29,
  TxTypeL2StakeAssets = 35,
  TxTypeL2UnstakeAssets = 36,
  TxTypeL2UpdateAccountConfig = 41,
  TxTypeL2UpdateAccountAssetConfig = 42,
  TxTypeL2ApproveIntegrator = 45,
}

export enum TxOrderTypes {
  OrderTypeLimit = 0,
  OrderTypeMarket = 1,
  OrderTypeStopLoss = 2,
  OrderTypeStopLossLimit = 3,
  OrderTypeTakeProfit = 4,
  OrderTypeTakeProfitLimit = 5,
  OrderTypeTWAP = 6,
}

export enum TxTimeInForceTypes {
  OrderImmediateOrCancel = 0,
  OrderGoodTillTime = 1,
  OrderPostOnly = 2,
}

export enum TxGroupingTypes {
  GroupingType = 0,
  GroupingTypeOto = 1,
  GroupingTypeOco = 2,
  GroupingTypeOtoco = 3,
}
