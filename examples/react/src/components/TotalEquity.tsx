import { useAccountEquity } from 'lighter-ts'

const TotalEquity = () => {
  const { totalEquity } = useAccountEquity()
  const totalEquityString = totalEquity ? `$${totalEquity?.toFixed(2)}` : '-'
  return <div>Total equity: {totalEquityString}</div>
}

export default TotalEquity
