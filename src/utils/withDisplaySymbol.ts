export const withDisplaySymbol = <T extends { symbol: string }>(
  detail: T,
  displaySymbols: Record<string, string>,
): T & { backend_symbol: string } => ({
  ...detail,
  symbol: displaySymbols[detail.symbol] ?? detail.symbol,
  backend_symbol: detail.symbol,
})
