import{defineConfig}from'vite';
import{resolve}from'node:path';

export default defineConfig({
  build:{
    outDir:'dist',
    emptyOutDir:true,
    lib:{entry:resolve(import.meta.dirname,'src/content/index.ts'),name:'KlaContentScript',formats:['iife'],fileName:()=> 'content.js'},
  },
});
