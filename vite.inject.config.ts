import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// MAIN world 注入脚本同样保持自包含，避免依赖扩展 URL 下的模块加载。
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, 'src/inject/index.ts'),
      name: 'KlaMainWorldHook',
      formats: ['iife'],
      fileName: () => 'inject.js',
    },
  },
});
