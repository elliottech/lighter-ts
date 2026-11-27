export const tickOnSecondBoundaries = (endMs: number, tick: () => void) => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const schedule = () => {
    const msToBoundary = (((endMs - Date.now()) % 1000) + 1000) % 1000
    timeout = setTimeout(() => {
      tick()
      if (!stopped && Date.now() < endMs) schedule()
    }, msToBoundary || 1000)
  }
  schedule()
  return () => {
    stopped = true
    clearTimeout(timeout)
  }
}
