import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// 打包前删除同名旧包，避免 Unix zip 的增量更新保留已经从 dist 删除的条目。
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('release', { recursive: true });
const zip = resolve('release', `k-line-analyzer-${pkg.version}.zip`);
await rm(zip, { force: true });

if (process.platform === 'win32') {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Compress-Archive -Path (Join-Path $env:KLA_DIST_DIR "*") -DestinationPath $env:KLA_ZIP_PATH -CompressionLevel Optimal',
    ],
    {
      env: { ...process.env, KLA_DIST_DIR: resolve('dist'), KLA_ZIP_PATH: zip },
      stdio: 'inherit',
    },
  );
} else {
  execFileSync('zip', ['-q', '-r', zip, '.'], { cwd: resolve('dist'), stdio: 'inherit' });
}

const bytes = await readFile(zip);
await writeFile(
  'release/checksums.txt',
  `${createHash('sha256').update(bytes).digest('hex')}  ${basename(zip)}\n`,
);
console.log(`Packaged ${basename(zip)} (${bytes.length} bytes) and updated checksums.txt`);
