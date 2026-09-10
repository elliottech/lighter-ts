import { useAccountEquity, useUserAddress } from 'lighter-ts'

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const TotalEquity = () => {
  const { totalEquity } = useAccountEquity()
  const userAddress = useUserAddress()
  const hasValue = totalEquity !== undefined && totalEquity !== null

  return (
    <section className="card">
      <header className="card-header">
        <h2 className="card-title">Total equity</h2>
      </header>
      <div className="equity-value" data-empty={!hasValue}>
        {hasValue ? usd.format(totalEquity) : '—'}
      </div>
      <p className="equity-hint">
        {userAddress
          ? 'Streamed from the account websocket channel.'
          : 'Connect a wallet to load your account.'}
      </p>
    </section>
  )
}

export default TotalEquity
