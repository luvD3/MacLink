import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePath, type Plugin } from 'vite';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(require.resolve('@novnc/novnc')));
const zrle = normalizePath(path.join(root, 'core/decoders/zrle.js'));
// Vite module IDs use forward slashes, including on Windows. Returning native
// paths here would create a second module with a separate live Inflator binding.
const adapter = normalizePath(fileURLToPath(new URL('../src/renderer/vnc/inflator.ts', import.meta.url)));
const decoder = normalizePath(fileURLToPath(new URL('../src/renderer/vnc/zrle-decoder.ts', import.meta.url)));
const rfb = normalizePath(path.join(root, 'core/rfb.js'));

/** The single integration point with the pinned noVNC 1.7 decoder. Other
 * encodings, authentication, clipboard, and input remain upstream modules. */
export function fastZrle(): Plugin {
  return {
    name: 'maclink-fast-zrle',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === '@maclink/novnc-zlib') return normalizePath(path.join(root, 'vendor/pako/lib/zlib/inflate.js'));
      if (source === '@maclink/novnc-zstream') return normalizePath(path.join(root, 'vendor/pako/lib/zlib/zstream.js'));
      if (source === '@maclink/novnc-zrle') return zrle;
      if (source === '@maclink/novnc-rfb') return rfb;
      if (source === './decoders/zrle.js' && importer && normalizePath(importer) === rfb) return decoder;
      if (source === '../inflator.js' && importer && normalizePath(importer) === zrle) return adapter;
    },
  };
}
