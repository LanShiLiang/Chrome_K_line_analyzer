import{readFile}from'node:fs/promises';
import{resolve}from'node:path';

const dist=resolve('dist');
const manifest=JSON.parse(await readFile(resolve(dist,'manifest.json'),'utf8'));
const classicScripts=new Set(
  manifest.content_scripts.flatMap(entry=>entry.js??[]),
);
const moduleSyntax=/(^|[;}])\s*(?:import\s*(?:[({*]|[\w$]+\s+from)|export\s+(?:default|const|let|var|function|class|\{|\*))/m;

for(const file of classicScripts){
  const source=await readFile(resolve(dist,file),'utf8');
  if(moduleSyntax.test(source))throw new Error(`${file} contains ES module syntax but Manifest content scripts execute as classic scripts`);
}

const background=manifest.background?.service_worker;
if(!background||manifest.background?.type!=='module')throw new Error('MV3 background service worker must be declared as a module');
await readFile(resolve(dist,background),'utf8');
console.log(`Verified ${classicScripts.size} classic content scripts and module service worker`);
