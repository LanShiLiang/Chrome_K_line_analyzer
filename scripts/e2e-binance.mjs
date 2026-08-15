import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const BINANCE_SPOT_URL =
  process.env.KLA_BINANCE_E2E_URL ?? 'https://www.binance.com/en/trade/ETH_USDT?type=spot';
const extensionPath = resolve('dist');
const resultsPath = resolve('test-results');
const profilePath = await mkdtemp(join(tmpdir(), 'kla-binance-e2e-'));

const existingPath = async (...paths) => {
  for (const path of paths) {
    if (!path) continue;
    try {
      await access(path);
      return path;
    } catch {
      // Try the next supported browser path.
    }
  }
};

const executablePath = await existingPath(
  process.env.KLA_CHROME_PATH,
  chromium.executablePath(),
  process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : undefined,
  process.platform === 'win32'
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : undefined,
  process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined,
  process.platform === 'linux' ? '/usr/bin/google-chrome' : undefined,
  process.platform === 'linux' ? '/usr/bin/chromium' : undefined,
);

if (!executablePath)
  throw new Error('未找到 Chrome/Edge；可通过 KLA_CHROME_PATH 指定 Chromium 可执行文件');

const clickButton = (page, label) =>
  page.evaluate((text) => {
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error(`未找到按钮：${text}`);
    if (button.disabled) throw new Error(`按钮不可用：${text}`);
    button.click();
  }, label);

const waitForText = (page, text, timeout = 20_000) =>
  page.waitForFunction((expected) => document.body.textContent?.includes(expected), text, {
    timeout,
  });

let context;
let drawerPage;
try {
  await mkdir(resultsPath, { recursive: true });
  context = await chromium.launchPersistentContext(profilePath, {
    executablePath,
    headless: false,
    viewport: { width: 1500, height: 1000 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--disable-default-apps',
    ],
  });

  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(serviceWorker.url()).host;
  const [marketPage] = context.pages();
  await marketPage.goto(BINANCE_SPOT_URL, {
    waitUntil: 'load',
    timeout: 60_000,
  });
  await marketPage.waitForURL(/binance\.com\/en\/trade\/ETH_USDT/, { timeout: 60_000 });
  await marketPage.waitForTimeout(2_000);

  drawerPage = await context.newPage();
  // activeTab 权限可能在 SPA 导航后只返回 Tab ID；这是本次回归的真实边界。
  await drawerPage.addInitScript(() => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (queryInfo) =>
      (await query(queryInfo)).map((tab) => ({ ...tab, url: undefined, title: undefined }));
  });
  await drawerPage.goto(`chrome-extension://${extensionId}/drawer.html`);
  await drawerPage.waitForSelector('.status');
  await drawerPage.waitForTimeout(100);
  await serviceWorker.evaluate(async (targetUrl) => {
    const tabs = await chrome.tabs.query({});
    const marketTab =
      tabs.find((tab) => tab.url?.startsWith(targetUrl)) ??
      tabs.find((tab) => !tab.active && !tab.url?.startsWith('chrome-extension://'));
    if (marketTab?.id === undefined) throw new Error('未找到 Binance E2E 标签页');
    await chrome.tabs.update(marketTab.id, { active: true });
  }, BINANCE_SPOT_URL);
  await waitForText(drawerPage, '已识别 Binance');

  await clickButton(drawerPage, '开始分析');
  await waitForText(drawerPage, 'K线与成交量', 30_000);
  await waitForText(drawerPage, '最近 200 根 K 线');
  await drawerPage.waitForFunction(
    () => {
      const chart = document.querySelector('.market-chart');
      const canvas = chart?.querySelector('canvas');
      return Boolean(
        chart?.getAttribute('data-candle-count') === '200' &&
          canvas &&
          canvas.width > 0 &&
          canvas.height > 0,
      );
    },
    undefined,
    { timeout: 15_000 },
  );
  await drawerPage.screenshot({
    path: resolve(resultsPath, 'binance-spot-200-candles.png'),
    fullPage: true,
  });

  await drawerPage.evaluate(() => {
    const input = document.querySelector('input[type="number"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('未找到分析 K 线数量输入框');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '64');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitForText(drawerPage, '最近 64 根 K 线', 30_000);
  await drawerPage.waitForFunction(
    () => document.querySelector('.market-chart')?.getAttribute('data-candle-count') === '64',
  );
  await drawerPage.screenshot({
    path: resolve(resultsPath, 'binance-spot-64-candles.png'),
    fullPage: true,
  });

  await clickButton(drawerPage, '重置分析台');
  await waitForText(drawerPage, '等待分析');
  await drawerPage.waitForFunction(() => {
    const input = document.querySelector('input[type="number"]');
    return input instanceof HTMLInputElement && input.value === '200';
  });
  if (await drawerPage.locator('.market-chart').count())
    throw new Error('重置后仍然保留旧行情图表');

  await drawerPage.screenshot({
    path: resolve(resultsPath, 'binance-spot-reset.png'),
    fullPage: true,
  });
  console.log(`Binance Spot E2E passed: ${BINANCE_SPOT_URL}`);
} catch (error) {
  if (drawerPage)
    await drawerPage
      .screenshot({ path: resolve(resultsPath, 'binance-spot-e2e-failure.png'), fullPage: true })
      .catch(() => undefined);
  throw error;
} finally {
  await context?.close().catch(() => undefined);
  await rm(profilePath, { recursive: true, force: true });
}
