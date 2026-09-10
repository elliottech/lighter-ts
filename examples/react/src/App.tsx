import './App.css'
import { useUserAddress } from 'lighter-ts'
import AuthenticateForm from './components/AuthenticateForm'
import { ConnectWallet } from './components/ConnectWallet'
import TotalEquity from './components/TotalEquity'

const LighterMark = () => (
  <svg className="brand-mark" viewBox="0 0 48 48" aria-hidden="true">
    <path d="M15.9414 40L22.9339 33.4584V8L15.9414 14.8957V40Z" fill="currentColor" />
    <path d="M25.062 40L32.0545 33.4739V23.3334L25.062 30.2094V40Z" fill="currentColor" />
  </svg>
)

function App() {
  const userAddress = useUserAddress()

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="https://lighter.xyz" target="_blank" rel="noreferrer">
          <LighterMark />
          <span>lighter-ts</span>
          <span className="brand-tag">React example</span>
        </a>
        <ConnectWallet />
      </header>

      <main className="content">
        <div className="intro">
          <h1>Lighter React demo</h1>
          <p>
            Connect a wallet, register a trading key and read live account state through{' '}
            <code>lighter-ts</code>.
          </p>
        </div>

        {userAddress ? (
          <AuthenticateForm />
        ) : (
          <section className="card card-empty">
            <strong>No wallet connected</strong>
            <span>Connect an injected wallet to authenticate with Lighter.</span>
          </section>
        )}

        <TotalEquity />
      </main>

      <footer className="footer">
        <a href="https://github.com/elliottech/lighter-ts" target="_blank" rel="noreferrer">
          GitHub
        </a>
        <a href="https://apidocs.lighter.xyz" target="_blank" rel="noreferrer">
          API docs
        </a>
        <a href="https://lighter.xyz" target="_blank" rel="noreferrer">
          lighter.xyz
        </a>
      </footer>
    </div>
  )
}

export default App
