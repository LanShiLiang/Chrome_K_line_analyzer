import { access, copyFile, cp, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import { verifyExtensionBuild } from './verify-extension-build.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const cacheRoot = resolve(root, 'node_modules', '.cache', 'k-line-analyzer');
const runRoot = resolve(cacheRoot, `build-${process.pid}-${Date.now()}`);
const uiDir = resolve(runRoot, 'ui');
const contentDir = resolve(runRoot, 'content');
const injectDir = resolve(runRoot, 'inject');
const assembledDir = resolve(runRoot, 'assembled');
const previousDist = resolve(runRoot, 'previous-dist');

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const buildTarget = (configFile, outDir) =>
  build({
    root,
    configFile: resolve(root, configFile),
    build: { outDir, emptyOutDir: true },
  });

// IIFE 构建只允许产生约定入口，防止未来配置变化把额外文件静默带入发布包。
const copyIsolatedScript = async (sourceDir, fileName) => {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isFile() || entries[0].name !== fileName) {
    throw new Error(
      `${fileName} build emitted unexpected entries: ${entries.map(({ name }) => name).join(', ')}`,
    );
  }
  await copyFile(resolve(sourceDir, fileName), resolve(assembledDir, fileName));
};

// 全部构建与审计通过后才替换 dist；发布失败时保留上一份可用产物。
const publishDist = async () => {
  const hadDist = await exists(dist);
  if (hadDist) await rename(dist, previousDist);

  try {
    await rename(assembledDir, dist);
  } catch (error) {
    if (hadDist && !(await exists(dist))) await rename(previousDist, dist);
    throw error;
  }

  await rm(previousDist, { recursive: true, force: true });
};

await mkdir(runRoot, { recursive: true });

try {
  // 三类目标互不覆盖，可以并行完成，随后再合并成唯一发布目录。
  await Promise.all([
    buildTarget('vite.config.ts', uiDir),
    buildTarget('vite.content.config.ts', contentDir),
    buildTarget('vite.inject.config.ts', injectDir),
  ]);

  await cp(uiDir, assembledDir, { recursive: true });
  await copyIsolatedScript(contentDir, 'content.js');
  await copyIsolatedScript(injectDir, 'inject.js');
  await copyFile(resolve(root, 'manifest.json'), resolve(assembledDir, 'manifest.json'));
  await verifyExtensionBuild(assembledDir);
  await publishDist();
  console.log(`Published verified extension build to ${dist}`);
} finally {
  await rm(runRoot, { recursive: true, force: true });
}
