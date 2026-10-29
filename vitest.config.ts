import { defineConfig } from 'vitest/config';
import { fastZrle } from './build/novnc-decode.ts';
export default defineConfig({ plugins: [fastZrle()], test: { include: ['tests/**/*.test.ts'], environment: 'node' } });
