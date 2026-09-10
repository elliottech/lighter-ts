import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from 'lighter-ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import './index.css'
import App from './App.tsx'
import { initReactStore } from './utils/initReactStore.ts'
import { wagmiConfig } from './wagmi.ts'
import DataSyncBlocker from './DataSyncBlocker.tsx'
import AccountSideEffects from './AccountSideEffects.ts'

initReactStore()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <DataSyncBlocker>
          <>
            <AccountSideEffects />
            <App />
          </>
        </DataSyncBlocker>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)
