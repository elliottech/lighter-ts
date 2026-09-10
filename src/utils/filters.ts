import { getUnixTime, startOfMinute, sub as subDuration } from 'date-fns'

export type Timeline = '1d' | '1w' | '1m' | '3m' | '6m' | 'ytd' | 'all-time'

export const PNL_HOURLY_RETENTION_SECONDS = 10 * 24 * 60 * 60
export const PNL_HOURLY_RETENTION_BUFFER_SECONDS = 1

export const TIMELINES: Timeline[] = ['1d', '1w', '1m', '3m', '6m', 'ytd', 'all-time']

export const getTimelineStartTimestamp = (timeline: Timeline) => {
  switch (timeline) {
    case '1d': {
      return getUnixTime(subDuration(startOfMinute(new Date()), { days: 1 }))
    }
    case '1w': {
      return getUnixTime(subDuration(startOfMinute(new Date()), { weeks: 1 }))
    }
    case '1m': {
      return getUnixTime(subDuration(startOfMinute(new Date()), { months: 1 }))
    }
    case '3m': {
      return getUnixTime(subDuration(startOfMinute(new Date()), { months: 3 }))
    }
    case '6m': {
      return getUnixTime(subDuration(startOfMinute(new Date()), { months: 6 }))
    }
    case 'ytd': {
      const currentYear = new Date().getUTCFullYear()
      return getUnixTime(new Date(Date.UTC(currentYear, 0, 1)))
    }
    case 'all-time': {
      return getUnixTime(new Date(Date.UTC(2025, 0, 16)))
    }
  }
}

export const getTimelineResolution = (timeline: Timeline) => {
  switch (timeline) {
    case '1d':
    case '1w':
      return '1h'
    case '1m':
    case '3m':
    case '6m':
    case 'ytd':
    case 'all-time':
      return '1d'
  }
}

export const getCustomRangeResolution = (
  startTimestamp: number,
  endTimestamp: number,
  currentTimestamp = Math.ceil(Date.now() / 1000),
) => {
  const sevenDaysInSeconds = 7 * 24 * 60 * 60
  const earliestHourlyTimestamp =
    currentTimestamp - PNL_HOURLY_RETENTION_SECONDS + PNL_HOURLY_RETENTION_BUFFER_SECONDS
  const isWithinHourlyRetention = startTimestamp > earliestHourlyTimestamp

  if (isWithinHourlyRetention && endTimestamp - startTimestamp <= sevenDaysInSeconds) {
    return '1h'
  }
  return '1d'
}

export const getPnlCustomRangeStartTimestamp = (startTimestamp: number, endTimestamp: number) =>
  Math.min(Math.max(startTimestamp, getTimelineStartTimestamp('all-time')), endTimestamp)

export const getTimelineTitleKey = (timeline: Timeline) => {
  switch (timeline) {
    case '1d':
      return 'pnl_balance_chart_timeline_1d_title'
    case '1w':
      return 'pnl_balance_chart_timeline_1w_title'
    case '1m':
      return 'pnl_balance_chart_timeline_1m_title'
    case '3m':
      return 'pnl_balance_chart_timeline_3m_title'
    case '6m':
      return 'pnl_balance_chart_timeline_6m_title'
    case 'ytd':
      return 'pnl_balance_chart_timeline_ytd_title'
    case 'all-time':
      return 'pnl_balance_chart_timeline_all_time_title'
  }
}

export type TypeSelector = (typeof TYPE_SELECTOR_OPTIONS)[number]
export type TypeSelectorOption = (typeof TYPE_SELECTOR_OPTIONS)[number]['key']

export const TYPE_SELECTOR_OPTIONS = [
  { key: 'total_pnl', titleKey: 'total_equity_title' },
  { key: 'trade_spot_pnl', titleKey: 'spot_equity_title' },
  { key: 'trade_pnl', titleKey: 'perps_equity_title' },
  { key: 'pool_pnl', titleKey: 'public_pool_equity_title' },
  { key: 'staking_pnl', titleKey: 'staking_equity_title' },
] as const
