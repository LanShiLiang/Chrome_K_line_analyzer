import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Manifest = {
  name: string;
  icons?: Record<string, string>;
  action?: { default_icon?: Record<string, string> };
  host_permissions?: string[];
  content_scripts?: Array<{ matches?: string[] }>;
};
type PackageJson = { scripts?: Record<string, string> };

const root = resolve(import.meta.dirname, '..');
const readJson = <T>(file: string) => JSON.parse(readFileSync(resolve(root, file), 'utf8')) as T;
const developmentHosts = ['http://localhost/*', 'http://127.0.0.1/*'];

const pngDimensions = (file: string) => {
  const bytes = readFileSync(resolve(root, file));
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

describe('release manifests', () => {
  const production = readJson<Manifest>('manifest.prod.json');
  const development = readJson<Manifest>('manifest.dev.json');

  it('keeps local page access in development only', () => {
    expect(existsSync(resolve(root, 'manifest.json'))).toBe(false);
    expect(development.name).toContain('(Dev)');
    expect(production.name).toBe('K Line Analyzer');

    for (const host of developmentHosts) {
      expect(development.host_permissions).toContain(host);
      for (const script of development.content_scripts ?? [])
        expect(script.matches).toContain(host);
    }

    const serializedProduction = JSON.stringify(production);
    expect(serializedProduction).not.toMatch(/localhost|127\.0\.0\.1/i);
    expect(serializedProduction).not.toContain('<all_urls>');
  });

  it('declares every required extension icon', () => {
    expect(production.icons).toEqual({
      '16': 'icons/icon16.png',
      '32': 'icons/icon32.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png',
    });
    expect(production.action?.default_icon).toEqual({
      '16': 'icons/icon16.png',
      '32': 'icons/icon32.png',
    });
  });
});

describe('Chrome Web Store assets', () => {
  it('gates release packaging on both recommended real sites', () => {
    const scripts = readJson<PackageJson>('package.json').scripts ?? {};
    expect(scripts['test:e2e:release']).toContain('e2e-binance.mjs binance');
    expect(scripts['test:e2e:release']).toContain('e2e-binance.mjs tonghuashun');
    expect(scripts.package).toContain('test:e2e:release');
  });

  it.each([16, 32, 48, 128])('provides a valid %d px PNG icon', (size) => {
    expect(pngDimensions(`assets/icons/icon${size}.png`)).toEqual({ width: size, height: size });
  });

  it.each([
    ['store-assets/promo-small-440x280.png', 440, 280],
    ['store-assets/screenshot-1-analysis-1280x800.png', 1280, 800],
    ['store-assets/screenshot-2-settings-1280x800.png', 1280, 800],
    ['store-assets/screenshot-3-tonghuashun-1280x800.png', 1280, 800],
  ])('provides correctly sized store artwork: %s', (file, width, height) => {
    expect(pngDimensions(file)).toEqual({ width, height });
  });

  it('documents the privacy and disclosure boundary', () => {
    const privacy = readFileSync(resolve(root, 'PRIVACY.md'), 'utf8');
    const listing = readFileSync(resolve(root, 'docs', 'WEB_STORE_LISTING.md'), 'utf8');
    for (const term of ['Binance', 'TradingView', '同花顺', 'chrome.storage.local', 'Limited Use'])
      expect(privacy).toContain(term);
    for (const term of ['Website content', 'Web browsing activity', '单一用途', '权限说明'])
      expect(listing).toContain(term);
    for (const url of [
      'https://www.binance.com/en/trade/BTC_USDT?type=spot',
      'https://stockpage.10jqka.com.cn/600519/',
    ]) {
      expect(readFileSync(resolve(root, 'README.md'), 'utf8')).toContain(url);
      expect(listing).toContain(url);
    }
  });

  it('uses blue for the product theme while preserving market chart colors', () => {
    const styles = readFileSync(resolve(root, 'src', 'drawer', 'styles.css'), 'utf8');
    const content = readFileSync(resolve(root, 'src', 'content', 'index.ts'), 'utf8');
    const drawer = readFileSync(resolve(root, 'src', 'drawer', 'main.tsx'), 'utf8');

    expect(styles).toContain('--accent: #4f8cff');
    expect(styles).toContain('linear-gradient(90deg, #315fd4 0%, #4f8cff 100%)');
    expect(styles).toContain('body.popup-page');
    expect(styles).not.toMatch(/(?:^|\n)body\s*\{[^}]*min-width:\s*420px/s);
    expect(styles).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(styles).not.toMatch(/#17b890|#00a878|rgba\(0,\s*168,\s*120/i);
    expect(content).toContain("border: '2px solid #4f8cff'");
    expect(drawer).toContain('upColor: colors.rising');
    expect(drawer).toContain('downColor: colors.falling');
  });
});
