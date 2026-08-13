import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Manifest Content Script 不能依赖静态 ESM import，因此单独输出自包含 IIFE。
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/index.ts'),
      name: 'KlaContentScript',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
});
