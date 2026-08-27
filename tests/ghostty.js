import { readFile } from 'node:fs/promises'
import { GhosttyCore } from '@wterm/ghostty'

const wasmPath = readFile(new URL('../node_modules/@wterm/ghostty/wasm/ghostty-vt.wasm', import.meta.url))
  .then(wasm => `data:application/wasm;base64,${wasm.toString('base64')}`)

export const createGhosttyCore = async () => GhosttyCore.load({ wasmPath: await wasmPath })
