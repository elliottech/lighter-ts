import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import LighterWs from './LighterWs'

class FakeWebSocket {
  static last: FakeWebSocket | null = null
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: unknown) => void) | null = null
  close = vi.fn()
  send = vi.fn()

  constructor(readonly url: string) {
    FakeWebSocket.last = this
  }
}

const socket = () => {
  if (!FakeWebSocket.last) throw new Error('no socket')
  return FakeWebSocket.last
}

describe('LighterWs', () => {
  const onOpen = vi.fn()
  const onClose = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    onOpen.mockReset()
    onClose.mockReset()
    new LighterWs({ baseUrl: 'wss://example.test/stream', encoding: 'json', onOpen, onClose })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps a query carried by the base URL', () => {
    new LighterWs({
      baseUrl: 'wss://example.test/stream?password=abc',
      encoding: 'json',
      onOpen,
      onClose,
    })
    expect(socket().url).toBe('wss://example.test/stream?password=abc&encoding=json&readonly=true')
  })

  it('reports an error before open as a close, once', () => {
    const ws = socket()
    ws.onerror?.()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(ws.close).toHaveBeenCalledTimes(1)
    // A browser fires `close` after `error`; nothing is listening by then.
    expect(ws.onclose).toBeNull()
    expect(ws.onerror).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('leaves an error after open to the close event', () => {
    const ws = socket()
    ws.onopen?.()
    ws.onerror?.()
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(ws.close).not.toHaveBeenCalled()
    ws.onclose?.()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
