import wasmUrl from './wasm/main.wasm?url'

export const processWasmCall = async <T>(wasmCall: Promise<() => Promise<T>>) => (await wasmCall)()

export const processWasmError = <T extends object>(wasmResponse: T | WasmError) => {
  if ('error' in wasmResponse) {
    const error = new Error(wasmResponse.error)
    console.error(error)
    throw error
  }

  return wasmResponse
}

let wasm: Promise<WebAssembly.WebAssemblyInstantiatedSource> | null = null
let wasmReadyResolve: (v: unknown) => void
const wasmReady = new Promise((resolve) => {
  wasmReadyResolve = resolve
})

function setWasmReady() {
  wasmReadyResolve(true)
}

// Use this to wait for WASM
export async function waitForWasm() {
  return wasmReady
}

export async function initWASM() {
  if (wasm !== null) {
    return wasm
  }
  const go = new window.Go()

  if (WebAssembly.instantiateStreaming) {
    wasm = WebAssembly.instantiateStreaming(fetch(wasmUrl), go.importObject).catch(() =>
      fetch(wasmUrl)
        .then((response) => response.arrayBuffer())
        .then((buffer) => WebAssembly.instantiate(buffer, go.importObject)),
    )
  } else {
    wasm = fetch(wasmUrl)
      .then((response) => response.arrayBuffer())
      .then((buffer) => WebAssembly.instantiate(buffer, go.importObject))
  }

  const instance = await wasm.then(({ instance }) => instance)
  go.run(instance)
  setTimeout(setWasmReady, 10)
}
