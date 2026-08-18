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

const localDevelopmentPattern = /(?:localhost|127\.0\.0\.1)/i;
const supportedLocales = ['en', 'zh_CN'];

const placeholderNames = (entry) => Object.keys(entry?.placeholders ?? {}).sort();

const validateLocales = async (dist, files, manifest) => {
  if (manifest.default_locale !== 'en')
    throw new Error(`Extension default_locale must be en, received ${manifest.default_locale}`);

  const expectedFiles = supportedLocales.map((locale) => `_locales/${locale}/messages.json`);
  const actualFiles = files.filter((file) => file.startsWith('_locales/'));
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles))
    throw new Error(
      `Extension locales must be exactly ${expectedFiles.join(', ')}; received ${actualFiles.join(', ')}`,
    );

  const catalogs = Object.fromEntries(
    await Promise.all(
      supportedLocales.map(async (locale) => [
        locale,
        JSON.parse(await readFile(resolve(dist, `_locales/${locale}/messages.json`), 'utf8')),
      ]),
    ),
  );
  const englishKeys = Object.keys(catalogs.en).sort();
  for (const locale of supportedLocales) {
    const catalog = catalogs[locale];
    const keys = Object.keys(catalog).sort();
    if (JSON.stringify(keys) !== JSON.stringify(englishKeys))
      throw new Error(`${locale} locale keys do not match the default English catalog`);
    for (const key of keys) {
      if (typeof catalog[key]?.message !== 'string' || !catalog[key].message.trim())
        throw new Error(`${locale} locale contains an empty or invalid message: ${key}`);
      if (
        JSON.stringify(placeholderNames(catalog[key])) !==
        JSON.stringify(placeholderNames(catalogs.en[key]))
      )
        throw new Error(`${locale} locale placeholders do not match English for ${key}`);
    }
  }

  for (const match of JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) {
    if (!catalogs.en[match[1]])
      throw new Error(`Manifest references a missing localization message: ${match[1]}`);
  }
  return expectedFiles;
};

export const verifyExtensionBuild = async (
  directory = resolve('dist'),
  { profile = 'prod' } = {},
) => {
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
  const expectedManifest = JSON.parse(
    await readFile(resolve(import.meta.dirname, '..', `manifest.${profile}.json`), 'utf8'),
  );
  if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest))
    throw new Error(`Build manifest does not match manifest.${profile}.json`);
  if (profile === 'prod' && localDevelopmentPattern.test(JSON.stringify(manifest)))
    throw new Error('Production manifest contains localhost or 127.0.0.1 access');
  if (profile === 'dev' && !localDevelopmentPattern.test(JSON.stringify(manifest)))
    throw new Error('Development manifest must retain local test-page access');
  const packageJson = JSON.parse(
    await readFile(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'),
  );
  if (manifest.version !== packageJson.version) {
    throw new Error(
      `Manifest version ${manifest.version} does not match package version ${packageJson.version}`,
    );
  }
  const localeFiles = await validateLocales(dist, files, manifest);

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
  const reachable = new Set(['manifest.json', ...localeFiles]);
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
  console.log(
    `Verified ${files.length} reachable ${profile} extension files with no forbidden artifacts`,
  );
};

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun)
  await verifyExtensionBuild(process.argv[2] ?? resolve('dist'), {
    profile: process.argv[3] ?? 'prod',
  });
