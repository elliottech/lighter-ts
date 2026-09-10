export const UserPreferrableDateFormat = {
  MONTH_DAY_YEAR: 'M/d/yyyy', // default
  DAY_MONTH_YEAR: 'd/M/yyyy',
}

export type DateFormat =
  | 'DAY_HOUR_MINUTE'
  | 'MONTH_DAY'
  | 'MONTH_DAY_HOUR_MINUTE'
  | 'MONTH_DAY_HOUR_MINUTE_SECOND'
  | 'MONTH_DAY_YEAR'
  | 'MONTH_DAY_YEAR_HOUR_MINUTE'
  | 'MONTH_DAY_YEAR_HOUR_MINUTE_SECOND'
  | 'HOUR_MINUTE'
  | 'HOUR_MINUTE_SECOND'

export const MonthDayDateFormat = {
  DAY_HOUR_MINUTE: 'd HH:mm',
  MONTH_DAY: 'M/d',
  MONTH_DAY_HOUR_MINUTE: 'M/d HH:mm',
  MONTH_DAY_HOUR_MINUTE_SECOND: 'M/d HH:mm:ss',
  MONTH_DAY_YEAR: 'M/d/yyyy',
  MONTH_DAY_YEAR_HOUR_MINUTE: 'M/d/yyyy HH:mm',
  MONTH_DAY_YEAR_HOUR_MINUTE_SECOND: 'M/d/yyyy HH:mm:ss',
  HOUR_MINUTE: 'HH:mm',
  HOUR_MINUTE_SECOND: 'HH:mm:ss',
} as const
export const DayMonthDateFormat = {
  DAY_HOUR_MINUTE: 'd HH:mm',
  MONTH_DAY: 'd/M',
  MONTH_DAY_HOUR_MINUTE: 'd/M HH:mm',
  MONTH_DAY_HOUR_MINUTE_SECOND: 'd/M HH:mm:ss',
  MONTH_DAY_YEAR: 'd/M/yyyy',
  MONTH_DAY_YEAR_HOUR_MINUTE: 'd/M/yyyy HH:mm',
  MONTH_DAY_YEAR_HOUR_MINUTE_SECOND: 'd/M/yyyy HH:mm:ss',
  HOUR_MINUTE: 'HH:mm',
  HOUR_MINUTE_SECOND: 'HH:mm:ss',
} as const

export type DateFormatterFunc = (date: Date | number | string, dateFormat: DateFormat) => string
