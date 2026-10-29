import { defineConfig } from 'vite';
import { fastZrle } from './build/novnc-decode.ts';
export default defineConfig({ base: './', plugins: [fastZrle()] });
