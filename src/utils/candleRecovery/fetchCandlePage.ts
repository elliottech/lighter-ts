// Timeout each page, not the entire range: long outages may require many
// healthy requests. Cancellation also aborts both price sources together.
export async function fetchCandlePage<T>(
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController()
  if (signal?.aborted) {
    const error = new Error('Candle request aborted')
    error.name = 'AbortError'
    throw error
  }
  let abort = () => {}
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    // Settle independently of transport cancellation: a custom fetch/middleware
    // may ignore AbortSignal. Late fulfillment/rejection remains handled.
    return await new Promise<T>((resolve, reject) => {
      const cancel = (message: string, name = 'AbortError') => {
        const error = new Error(message)
        error.name = name
        reject(error)
        controller.abort()
      }
      abort = () => cancel('Candle request aborted')
      signal?.addEventListener('abort', abort, { once: true })
      timeout = setTimeout(() => cancel('Candle request timeout', 'TimeoutError'), timeoutMs)
      run(controller.signal).then(resolve, reject)
    })
  } finally {
    controller.abort()
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}
