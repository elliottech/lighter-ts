import type { TFunction } from 'i18next'
import { OrderStatusEnum, OrderTimeInForceEnum, OrderTypeEnum } from 'zklighter-perps'

import { OrderType } from '../../types/order'
import { TxGroupingTypes, TxOrderTypes, TxTimeInForceTypes } from '../../types/user'
import type { Order } from '../types'

export type TimeInForce = 'gtd' | 'ioc'
export type TimeInForceUnit = 's' | 'm' | 'h' | 'd'

export const getTimestampDiff = (value: number, unit: TimeInForceUnit) => {
  switch (unit) {
    case 's':
      return value * 1000
    case 'm':
      return value * 60 * 1000
    case 'h':
      return value * 60 * 60 * 1000
    case 'd':
      return value * 24 * 60 * 60 * 1000
  }
}

const TIME_IN_FORCE_INPUT_MAX_VALUES = {
  d: 4 * 7,
  h: 24 * 4 * 7,
  m: 60 * 24 * 4 * 7,
  s: 60 * 60 * 24 * 4 * 7,
} as const

export const validateAndParseTIFValue = (value: string, unit: TimeInForceUnit) => {
  if (value === '') {
    return ''
  }

  const intValue = parseInt(value, 10)

  if (Number.isNaN(intValue)) {
    return ''
  }

  const maxValue = TIME_IN_FORCE_INPUT_MAX_VALUES[unit]

  return `${Math.min(Math.floor(intValue), maxValue)}`
}

export const getOrderExpiry = (
  orderType: OrderType,
  timeInForce: TimeInForce,
  timeInForceValue: string,
  timeInForceUnit: TimeInForceUnit,
  runtimeMinutes: string,
  runtimeHours: string,
  now: number = Date.now(),
) => {
  switch (orderType) {
    case OrderType.Market: {
      return 0
    }
    case OrderType.Conditional: {
      return now + getTimestampDiff(28, 'd')
    }
    case OrderType.Limit:
    case OrderType.Scale: {
      if (timeInForce === 'ioc') {
        return 0
      }
      return now + getTimestampDiff(Number(timeInForceValue), timeInForceUnit)
    }
    case OrderType.Twap: {
      return (
        now +
        getTimestampDiff(10, 's') + // 10 seconds buffer in case there is a delay in the tx
        getTimestampDiff(Number(runtimeMinutes), 'm') +
        getTimestampDiff(Number(runtimeHours), 'h')
      )
    }
  }
}

export const getChildSLTPOrderExpiry = (
  parentOrderType: OrderType,
  timeInForce: TimeInForce,
  timeInForceValue: string,
  timeInForceUnit: TimeInForceUnit,
  now: number = Date.now(),
) => {
  if (parentOrderType === OrderType.Market || timeInForce === 'ioc') {
    return now + getTimestampDiff(28, 'd')
  }

  return now + getTimestampDiff(Number(timeInForceValue), timeInForceUnit)
}

export const getOrderTimeInForce = (
  orderType: OrderType,
  timeInForce: TimeInForce,
  postOnly: boolean,
  limitPrice: number,
): TxTimeInForceTypes => {
  switch (orderType) {
    case OrderType.Market: {
      return TxTimeInForceTypes.OrderImmediateOrCancel
    }
    case OrderType.Conditional: {
      return limitPrice
        ? TxTimeInForceTypes.OrderGoodTillTime
        : TxTimeInForceTypes.OrderImmediateOrCancel
    }
    case OrderType.Limit:
    case OrderType.Scale: {
      if (timeInForce === 'ioc') {
        return TxTimeInForceTypes.OrderImmediateOrCancel
      }

      if (postOnly) {
        return TxTimeInForceTypes.OrderPostOnly
      }

      return TxTimeInForceTypes.OrderGoodTillTime
    }
    case OrderType.Twap: {
      return TxTimeInForceTypes.OrderGoodTillTime
    }
  }
}

export const getOrderType = (
  orderType: OrderType,
  triggerPrice: number,
  limitPrice: number,
  markPrice: number,
  isShort: boolean,
): TxOrderTypes => {
  switch (orderType) {
    case OrderType.Limit: {
      return TxOrderTypes.OrderTypeLimit
    }
    case OrderType.Market: {
      return TxOrderTypes.OrderTypeMarket
    }
    case OrderType.Conditional: {
      if (isShort ? triggerPrice < markPrice : triggerPrice > markPrice) {
        return limitPrice ? TxOrderTypes.OrderTypeStopLossLimit : TxOrderTypes.OrderTypeStopLoss
      }

      return limitPrice ? TxOrderTypes.OrderTypeTakeProfitLimit : TxOrderTypes.OrderTypeTakeProfit
    }
    case OrderType.Twap: {
      return TxOrderTypes.OrderTypeTWAP
    }
    case OrderType.Scale: {
      return TxOrderTypes.OrderTypeLimit
    }
  }
}

export const getOrderTypeFromTx = (orderType: TxOrderTypes): OrderTypeEnum => {
  switch (orderType) {
    case TxOrderTypes.OrderTypeLimit: {
      return OrderTypeEnum.Limit
    }
    case TxOrderTypes.OrderTypeMarket: {
      return OrderTypeEnum.Market
    }
    case TxOrderTypes.OrderTypeStopLoss: {
      return OrderTypeEnum.StopLoss
    }
    case TxOrderTypes.OrderTypeStopLossLimit: {
      return OrderTypeEnum.StopLossLimit
    }
    case TxOrderTypes.OrderTypeTakeProfit: {
      return OrderTypeEnum.TakeProfit
    }
    case TxOrderTypes.OrderTypeTakeProfitLimit: {
      return OrderTypeEnum.TakeProfitLimit
    }
    case TxOrderTypes.OrderTypeTWAP: {
      return OrderTypeEnum.Twap
    }
  }
}

export const getOrderPriceFromParams = (
  orderType: OrderType,
  limitPrice: number,
  marketOrderPrice: number,
  twapOrderPrice: number,
  triggerOrderPrice: number,
) => {
  switch (orderType) {
    case OrderType.Market: {
      return marketOrderPrice
    }
    case OrderType.Conditional: {
      return limitPrice || triggerOrderPrice
    }
    case OrderType.Limit: {
      return limitPrice
    }
    case OrderType.Twap: {
      return twapOrderPrice
    }
    case OrderType.Scale: {
      return 0 as never // we don't use this util for scale
    }
  }
}

export const getPlaceOrderButtonOrderTypeLabel = (orderType: OrderType, t: TFunction) => {
  switch (orderType) {
    case OrderType.Market:
      return t('market')
    case OrderType.Limit:
      return t('limit')
    case OrderType.Conditional: {
      return t('conditional')
    }
    case OrderType.Twap:
      return t('twap')
    case OrderType.Scale:
      return t('scale')
  }
}
export const getNotifOrderTypeLabel = (orderType: Omit<OrderType, 'scale'>, t: TFunction) => {
  switch (orderType) {
    case OrderTypeEnum.Market: {
      return t('market')
    }
    case OrderTypeEnum.Limit: {
      return t('limit')
    }
    case OrderTypeEnum.StopLoss: {
      return t('sl_market')
    }
    case OrderTypeEnum.StopLossLimit: {
      return t('sl_limit')
    }
    case OrderTypeEnum.TakeProfit: {
      return t('tp_market')
    }
    case OrderTypeEnum.TakeProfitLimit: {
      return t('tp_limit')
    }
    case OrderTypeEnum.Twap: {
      return t('twap')
    }
    default: {
      return '' as never
    }
  }
}

export const getStatusCopy = (order: Order | undefined, t: TFunction) => {
  if (!order) {
    return ''
  }
  const filledBaseAmount = order.filled_base_amount ?? 0
  switch (order.status) {
    case OrderStatusEnum.Canceled:
    case OrderStatusEnum.CanceledPostOnly:
    case OrderStatusEnum.CanceledReduceOnly:
    case OrderStatusEnum.CanceledPositionNotAllowed:
    case OrderStatusEnum.CanceledMarginNotAllowed:
    case OrderStatusEnum.CanceledTooMuchSlippage:
    case OrderStatusEnum.CanceledNotEnoughLiquidity:
    case OrderStatusEnum.CanceledSelfTrade:
    case OrderStatusEnum.CanceledOco:
    case OrderStatusEnum.CanceledChild:
    case OrderStatusEnum.CanceledLiquidation:
    case OrderStatusEnum.CanceledInvalidBalance: {
      if (filledBaseAmount > 0) {
        return t('partially_filled')
      }
      return t('canceled')
    }

    case OrderStatusEnum.CanceledExpired: {
      return t('expired')
    }
    case OrderStatusEnum.Filled: {
      return t('filled')
    }
    case OrderStatusEnum.Open: {
      return t('open')
    }
    case OrderStatusEnum.Pending: {
      switch (order?.type) {
        case OrderTypeEnum.Twap:
        case OrderTypeEnum.StopLoss:
        case OrderTypeEnum.StopLossLimit:
        case OrderTypeEnum.TakeProfit:
        case OrderTypeEnum.TakeProfitLimit: {
          return t('open')
        }
        default: {
          return t('pending')
        }
      }
    }
    default: {
      return ''
    }
  }
}

export const getOrderErrorCopy = (order: Order | undefined, t: TFunction) => {
  if (!order) {
    return null
  }

  switch (order.status) {
    case OrderStatusEnum.CanceledPostOnly: {
      return t('post_only')
    }
    case OrderStatusEnum.CanceledReduceOnly: {
      return t('reduce_only')
    }
    case OrderStatusEnum.CanceledSelfTrade: {
      return t('order_status_canceled_self_trade_description')
    }
    case OrderStatusEnum.CanceledPositionNotAllowed: {
      return t('order_status_canceled_position_not_allowed_description')
    }
    case OrderStatusEnum.CanceledMarginNotAllowed: {
      return t('order_status_canceled_margin_not_allowed_description')
    }
    case OrderStatusEnum.CanceledInvalidBalance: {
      return t('order_status_canceled_invalid_balance_description')
    }
    case OrderStatusEnum.CanceledTooMuchSlippage: {
      return t('order_status_canceled_too_much_slippage_description')
    }
    case OrderStatusEnum.CanceledNotEnoughLiquidity: {
      if (
        order.time_in_force === OrderTimeInForceEnum.ImmediateOrCancel &&
        order.type === OrderTypeEnum.Limit
      ) {
        return order.is_ask
          ? t('order_status_canceled_not_enough_liquidity_ioc_ask_description')
          : t('order_status_canceled_not_enough_liquidity_ioc_bid_description')
      }

      return t('order_status_canceled_not_enough_liquidity_description')
    }
    default: {
      return null
    }
  }
}

export const getOrderSuccess = ({
  orderType,
  status,
  filledBaseAmount,
}: {
  orderType: Omit<OrderType, 'scale'> | undefined
  status: OrderStatusEnum | undefined
  filledBaseAmount: number
}) => {
  switch (status) {
    case OrderStatusEnum.CanceledInvalidBalance:
    case OrderStatusEnum.Canceled:
    case OrderStatusEnum.CanceledPostOnly:
    case OrderStatusEnum.CanceledReduceOnly:
    case OrderStatusEnum.CanceledPositionNotAllowed:
    case OrderStatusEnum.CanceledMarginNotAllowed:
    case OrderStatusEnum.CanceledTooMuchSlippage:
    case OrderStatusEnum.CanceledNotEnoughLiquidity:
    case OrderStatusEnum.CanceledSelfTrade:
    case OrderStatusEnum.CanceledExpired:
    case OrderStatusEnum.CanceledOco:
    case OrderStatusEnum.CanceledChild:
    case OrderStatusEnum.CanceledLiquidation: {
      if (filledBaseAmount > 0) {
        return 'success'
      }
      return 'fail'
    }

    case OrderStatusEnum.Filled:
    case OrderStatusEnum.Open: {
      return 'success'
    }
    case OrderStatusEnum.Pending: {
      switch (orderType) {
        case OrderTypeEnum.Twap:
        case OrderTypeEnum.StopLoss:
        case OrderTypeEnum.StopLossLimit:
        case OrderTypeEnum.TakeProfit:
        case OrderTypeEnum.TakeProfitLimit: {
          return 'success'
        }
        default: {
          return 'pending'
        }
      }
    }
    default: {
      return 'pending'
    }
  }
}

export const getGroupingType = (groupingType: 'OTO' | 'OCO' | 'OTOCO') => {
  switch (groupingType) {
    case 'OTO':
      return TxGroupingTypes.GroupingTypeOto
    case 'OCO':
      return TxGroupingTypes.GroupingTypeOco
    case 'OTOCO':
      return TxGroupingTypes.GroupingTypeOtoco
  }
}
