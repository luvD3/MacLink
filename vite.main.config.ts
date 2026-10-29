import { defineConfig } from 'vite';
export default defineConfig({
  build: { rollupOptions: { external: ['electron', 'bufferutil', 'utf-8-validate'] } },
});
