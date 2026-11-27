/** UTC display buckets shared by chart aggregation and trade/listing marks.
 * Fixed intraday intervals stay with the consumer's existing resolution mapping.
 */
export const getCalendarCandleBucketTimeMs = (
  timestampMs: number,
  resolution: '1M' | '1W' | '3D',
): number => {
  const date = new Date(timestampMs)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  const day = date.getUTCDate()
  const dayMs = 86_400_000
  if (resolution === '1M') return Date.UTC(year, month, 1)
  const dayStart = Date.UTC(year, month, day)
  if (resolution === '1W') {
    return dayStart - ((date.getUTCDay() + 6) % 7) * dayMs
  }
  // TradingView aligns 3D periods relative to January 1, including leap years.
  const yearStart = Date.UTC(year, 0, 1)
  return yearStart + Math.floor((dayStart - yearStart) / (3 * dayMs)) * 3 * dayMs
}
