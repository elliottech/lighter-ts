import { useConnect, useConnection, useConnectors } from 'wagmi'
import { useLighterStore } from 'lighter-ts'
import { useEffect } from 'react'
import { useLogOut } from '../hooks/useLogOut'

// EIP-6963 discovery gives every installed extension its own connector, so
// prefer MetaMask when it's there and fall back to the generic `injected()` one
// that's always registered in the config.
const useInjectedConnector = () => {
  const connectors = useConnectors()

  return (
    connectors.find((connector) => connector.id === 'io.metamask') ??
    connectors.find((connector) => connector.id === 'injected') ??
    connectors[0]
  )
}

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

export const ConnectWallet = () => {
  const { address, isConnected } = useConnection()
  const connector = useInjectedConnector()
  const { mutate: connect, isPending, error } = useConnect()
  const logout = useLogOut()

  useEffect(() => {
    if (address) {
      useLighterStore.setState({
        l1Address: address,
        l1Initialized: true,
      })
    } else {
      useLighterStore.setState({
        l1Address: '',
        l1Initialized: false,
      })
    }
  }, [address])

  if (isConnected && address) {
    return (
      <div className="wallet">
        <span className="wallet-chip mono" title={address}>
          <span className="wallet-dot" aria-hidden="true" />
          {shortAddress(address)}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            logout()
          }}
        >
          Disconnect
        </button>
      </div>
    )
  }

  return (
    <div className="wallet">
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={!connector || isPending}
        onClick={() => connector && connect({ connector })}
      >
        {isPending && <span className="spinner" aria-hidden="true" />}
        {isPending ? 'Connecting…' : 'Connect wallet'}
      </button>
      {error && <span className="wallet-error">{error.message}</span>}
    </div>
  )
}
