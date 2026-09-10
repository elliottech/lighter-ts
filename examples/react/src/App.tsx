import './App.css'
import AuthenticateForm from './components/AuthenticateForm'
import { ConnectWallet } from './components/ConnectWallet'
import TotalEquity from './components/TotalEquity'

function App() {
  return (
    <>
      <h2>Lighter React Demo</h2>
      <ConnectWallet />
      <AuthenticateForm />
      <TotalEquity />
    </>
  )
}

export default App
