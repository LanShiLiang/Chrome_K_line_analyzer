import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { copyFileSync } from 'node:fs';

export default defineConfig({
  plugins: [react(), {name:'copy-manifest',closeBundle(){copyFileSync('manifest.json','dist/manifest.json')}}],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        drawer: resolve(import.meta.dirname, 'drawer.html'),
        popup: resolve(import.meta.dirname, 'popup.html'),
        options: resolve(import.meta.dirname, 'options.html'),
        background: resolve(import.meta.dirname, 'src/background/index.ts'),
        content: resolve(import.meta.dirname, 'src/content/index.ts'),
        inject: resolve(import.meta.dirname, 'src/inject/index.ts'),
      },
      output: {
        entryFileNames: ({ name }) => `${name}.js`,
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
