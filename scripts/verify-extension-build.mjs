import { readFile, readdir } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleSyntax =
  /(^|[;}])\s*(?:import\s*(?:[({*]|[\w$]+\s+from)|export\s+(?:default|const|let|var|function|class|\{|\*))/m;
const forbiddenFile =
  /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig(?:\.[^/]*)?\.json|vite(?:\.[^/]*)?\.config\.[^/]+)$/i;
const forbiddenExtension = /\.(?:map|md|ts|tsx|log)$/i;

const listFiles = async (directory) => {
  const files = [];
  const walk = async (currentDirectory, prefix = '') => {
    for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
      const file = posix.join(prefix, entry.name);
      if (entry.isDirectory()) await walk(resolve(currentDirectory, entry.name), file);
      else if (entry.isFile()) files.push(file);
    }
  };
  await walk(directory);
  return files.sort();
};

const addManifestFiles = (manifest, reachable) => {
  const add = (value) => {
    if (typeof value === 'string') reachable.add(value.replace(/^\//, ''));
  };
  const addValues = (value) => Object.values(value ?? {}).forEach(add);

  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  add(manifest.options_page);
  add(manifest.options_ui?.page);
  add(manifest.side_panel?.default_path);
  addValues(manifest.icons);
  addValues(manifest.action?.default_icon);
  addValues(manifest.chrome_url_overrides);
  manifest.content_scripts?.forEach((entry) =>
    [...(entry.js ?? []), ...(entry.css ?? [])].forEach(add),
  );
  manifest.web_accessible_resources?.forEach((entry) => entry.resources?.forEach(add));
};

const localReference = (reference, fromFile) => {
  if (/^(?:[a-z]+:|#|\/\/)/i.test(reference)) return null;
  const withoutQuery = reference.split(/[?#]/, 1)[0];
  const normalized = reference.startsWith('/')
    ? posix.normalize(withoutQuery.slice(1))
    : posix.normalize(posix.join(posix.dirname(fromFile), withoutQuery));
  if (!normalized || normalized === '.' || normalized.startsWith('../')) {
    throw new Error(`${fromFile} contains an invalid build reference: ${reference}`);
  }
  return normalized;
};

const extractReferences = (source, file) => {
  const references = [];
  const patterns = file.endsWith('.html')
    ? [/(?:src|href)=["']([^"']+)["']/g]
    : file.endsWith('.css')
      ? [/url\(\s*["']?([^"')]+)["']?\s*\)/g]
      : file.endsWith('.js')
        ? [
            /\b(?:import|export)\s*(?:[^"'()]*?\s*from\s*)?["']([^"']+)["']/g,
            /\bimport\s*\(\s*["']([^"']+)["']/g,
          ]
        : [];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const reference = localReference(match[1], file);
      if (reference) references.push(reference);
    }
  }
  return references;
};

export const verifyExtensionBuild = async (directory = resolve('dist')) => {
  const dist = resolve(directory);
  const files = await listFiles(dist);
  const fileSet = new Set(files);
  const unexpected = files.filter(
    (file) => forbiddenFile.test(file) || forbiddenExtension.test(file),
  );
  if (unexpected.length) {
    throw new Error(`Forbidden files in extension build: ${unexpected.join(', ')}`);
  }

  const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));
  const packageJson = JSON.parse(
    await readFile(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'),
  );
  if (manifest.version !== packageJson.version) {
    throw new Error(
      `Manifest version ${manifest.version} does not match package version ${packageJson.version}`,
    );
  }

  // Manifest Content Script 以 classic script 运行，必须阻止残留 ESM 语法进入 dist。
  const classicScripts = new Set(
    manifest.content_scripts?.flatMap((entry) => entry.js ?? []) ?? [],
  );
  for (const file of classicScripts) {
    const source = await readFile(resolve(dist, file), 'utf8');
    if (moduleSyntax.test(source)) {
      throw new Error(
        `${file} contains ES module syntax but Manifest content scripts execute as classic scripts`,
      );
    }
  }

  const background = manifest.background?.service_worker;
  if (!background || manifest.background?.type !== 'module') {
    throw new Error('MV3 background service worker must be declared as a module');
  }

  // 从 Manifest 根入口递归遍历 HTML、CSS 和模块引用；未被引用的文件视为陈旧垃圾。
  const reachable = new Set(['manifest.json']);
  addManifestFiles(manifest, reachable);
  const queue = [...reachable];
  while (queue.length) {
    const file = queue.shift();
    if (!fileSet.has(file)) throw new Error(`Build references missing file: ${file}`);
    const source = await readFile(resolve(dist, file), 'utf8');
    for (const reference of extractReferences(source, file)) {
      if (!reachable.has(reference)) {
        reachable.add(reference);
        queue.push(reference);
      }
    }
  }

  const unreachable = files.filter((file) => !reachable.has(file));
  if (unreachable.length) {
    throw new Error(`Unreferenced files in extension build: ${unreachable.join(', ')}`);
  }
  console.log(`Verified ${files.length} reachable extension files with no forbidden artifacts`);
};

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await verifyExtensionBuild(process.argv[2]);
