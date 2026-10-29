import wasmUrl from 'zlib-streams/zlib-streams.wasm?url&inline';
import BufferedInflator from './buffered-inflator';
import WasmInflator, { compileInflater } from './wasm-inflator';

let Inflator: new () => BufferedInflator | WasmInflator = BufferedInflator;
let backend: 'wasm' | 'javascript' = 'javascript';
let preparing: Promise<void> | undefined;

// A live ES module binding: noVNC constructs this only after prepareDecoder().
// A separate WASM instance belongs to each ZRLE stream, so reconnecting releases
// its complete heap with the old decoder instead of accumulating native handles.
export { Inflator as default };
export const decoderBackend = () => backend;

export function prepareDecoder(): Promise<void> {
  return preparing ??= load().catch(() => {
    // This is the sole initialization boundary. The tested JS path still works
    // if a deployment's CSP or WebAssembly compiler prevents the fast backend.
    console.warn('WASM 解码器未能初始化，已使用缓冲 JavaScript 解码器。');
  });
}

async function load(): Promise<void> {
  // Keep the 45 KB binary inside the renderer bundle. Packaged file:// launches
  // do not need a network request, an extra server, or a filesystem preload API.
  const bytes = Uint8Array.from(atob(wasmUrl.slice(wasmUrl.indexOf(',') + 1)), character => character.charCodeAt(0));
  const module = await compileInflater(bytes);
  Inflator = class extends WasmInflator {
    constructor() {
      super(module);
      // Report the backend only after the decoder has actually instantiated it.
      backend = 'wasm';
    }
  };
}
