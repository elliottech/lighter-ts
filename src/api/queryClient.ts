import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      retryOnMount: false,
      retry: 0,
    },
    // React Query holds mutations while the browser reports offline and runs them
    // once it is back. A tx would then be signed and sent long after the click.
    mutations: {
      networkMode: 'always',
    },
  },
})
