import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const createTargetClient = async (cdp, targetId) => {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: false });
  let messageId = 0;
  const send = (method, params = {}) =>
    new Promise((resolveMessage, rejectMessage) => {
      const id = ++messageId;
      const timeout = setTimeout(() => {
        cdp.off('Target.receivedMessageFromTarget', listener);
        rejectMessage(new Error(`Side Panel CDP 调用超时：${method}`));
      }, 30_000);
      const listener = ({ sessionId: receivedSessionId, message }) => {
        if (receivedSessionId !== sessionId) return;
        const response = JSON.parse(message);
        if (response.id !== id) return;
        clearTimeout(timeout);
        cdp.off('Target.receivedMessageFromTarget', listener);
        if (response.error) rejectMessage(new Error(response.error.message));
        else resolveMessage(response.result);
      };
      cdp.on('Target.receivedMessageFromTarget', listener);
      void cdp
        .send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch((error) => {
          clearTimeout(timeout);
          cdp.off('Target.receivedMessageFromTarget', listener);
          rejectMessage(error);
        });
    });

  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails)
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          'Side Panel 脚本执行失败',
      );
    return response.result?.value;
  };

  const waitFor = async (expression, description, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    const body = await evaluate('document.body.innerText');
    throw new Error(`${description}超时\nSide Panel 当前内容：\n${body}`);
  };

  const screenshot = async (path) => {
    const image = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
    });
    await writeFile(path, Buffer.from(image.data, 'base64'));
  };

  return { evaluate, screenshot, send, waitFor };
};

const renderedAnalysisExpression = (expectedCandles) => `(() => {
  const body = document.body.innerText;
  const error = document.querySelector('.error')?.textContent ?? '';
  if (error.includes('当前标签页') || error.includes('旧页面数据')) return false;
  const chart = document.querySelector('.market-chart');
  const evidence = document.querySelectorAll('article');
  const signalValues = document.querySelectorAll('.signal strong');
  const canvases = [...(chart?.querySelectorAll('canvas') ?? [])];
  const paintedCanvas = canvases.some((canvas) => {
    const context = canvas.getContext('2d');
    if (!context || canvas.width < 1 || canvas.height < 1) return false;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    const stride = Math.max(4, Math.floor(pixels.length / 4000 / 4) * 4);
    for (let index = 0; index < pixels.length; index += stride) {
      colors.add(
        pixels[index] + ',' + pixels[index + 1] + ',' + pixels[index + 2] + ',' + pixels[index + 3]
      );
      if (colors.size >= 6) return true;
    }
    return false;
  });
  return body.includes('策略结论') &&
    body.includes('阶段') &&
    body.includes('置信度') &&
    body.includes('分析依据') &&
    chart?.getAttribute('data-candle-count') === '${expectedCandles}' &&
    signalValues.length === 3 &&
    [...signalValues].every((value) => value.textContent?.trim()) &&
    evidence.length > 0 &&
    paintedCanvas;
})()`;

let context;
let sidePanel;
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

  const marketTabId = await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error('未找到 Binance E2E 标签页');
    return tab.id;
  });

  // 通过真实 popup 用户手势打开与 Binance Tab 绑定的 Chrome Side Panel。
  const popupPage = await context.newPage();
  await popupPage.addInitScript((tabId) => {
    chrome.tabs.query = async () => [{ id: tabId }];
  }, marketTabId);
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await popupPage.getByRole('button', { name: '打开侧边分析面板' }).click();
  await marketPage.waitForTimeout(500);

  const cdp = await context.newCDPSession(marketPage);
  const targetDeadline = Date.now() + 10_000;
  let sidePanelTarget;
  while (Date.now() < targetDeadline && !sidePanelTarget) {
    const targets = await cdp.send('Target.getTargets');
    sidePanelTarget = targets.targetInfos.find(
      (target) => target.type === 'page' && target.url.endsWith('/drawer.html'),
    );
    if (!sidePanelTarget) await delay(100);
  }
  if (!sidePanelTarget) throw new Error('真实 Chrome Side Panel 未打开');
  if (context.pages().some((page) => page.url().endsWith('/drawer.html')))
    throw new Error('E2E 错误地把 Drawer 当作普通浏览器 Tab 打开');

  sidePanel = await createTargetClient(cdp, sidePanelTarget.targetId);
  await sidePanel.send('Emulation.setDeviceMetricsOverride', {
    width: 480,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sidePanel.waitFor(
    `document.body.innerText.includes('已识别 Binance')`,
    'Side Panel 识别 Binance',
  );

  // 旁路记录真实 Side Panel 的消息，并制造同一交易页的无害 URL 快照差异。
  await sidePanel.evaluate(`(() => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (queryInfo) => (await query(queryInfo)).map((tab) => {
      if (!tab.url?.includes('binance.com/') || !tab.url.includes('/trade/')) return tab;
      const url = new URL(tab.url);
      url.searchParams.set('theme', 'dark');
      url.searchParams.set('kla_e2e', 'same-market-url-variant');
      return { ...tab, url: url.toString() };
    });
    globalThis.__klaE2EAnalysisTraces = [];
    const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message) => {
      const response = await sendMessage(message);
      if (message?.type === 'RUN_ANALYSIS')
        globalThis.__klaE2EAnalysisTraces.push({ message, response });
      return response;
    };
    return true;
  })()`);

  await sidePanel.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) =>
      item.textContent?.trim() === '开始分析'
    );
    if (!(button instanceof HTMLButtonElement) || button.disabled)
      throw new Error('真实 Side Panel 的开始分析按钮不可用');
    button.click();
    return true;
  })()`);
  await sidePanel.waitFor(renderedAnalysisExpression(200), '渲染 200 根 K 线和分析结果');
  const firstTrace = await sidePanel.evaluate(`globalThis.__klaE2EAnalysisTraces.at(-1)`);
  if (firstTrace?.message?.tabId !== marketTabId)
    throw new Error('RUN_ANALYSIS 未绑定到当前 Binance 标签页');
  if (firstTrace?.response?.data?.context?.tabId !== marketTabId)
    throw new Error('分析响应未绑定到当前 Binance 标签页');
  if (firstTrace?.message?.payload?.config?.analysisCandleCount !== 200)
    throw new Error('默认分析 K 线数量未传入后台');
  if (firstTrace?.response?.data?.marketData?.candles?.length !== 200)
    throw new Error('后台没有返回 200 根 K 线');
  await sidePanel.screenshot(resolve(resultsPath, 'binance-spot-200-candles.png'));

  await sidePanel.evaluate(`(() => {
    const input = document.querySelector('input[type="number"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('未找到分析 K 线数量输入框');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '64');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sidePanel.waitFor(renderedAnalysisExpression(64), '按 64 根 K 线重新分析');
  const secondTrace = await sidePanel.evaluate(`globalThis.__klaE2EAnalysisTraces.at(-1)`);
  if (secondTrace?.message?.payload?.config?.analysisCandleCount !== 64)
    throw new Error('修改后的分析 K 线数量未传入后台');
  if (secondTrace?.response?.data?.marketData?.candles?.length !== 64)
    throw new Error('策略参数变更后后台没有返回 64 根 K 线');
  await sidePanel.screenshot(resolve(resultsPath, 'binance-spot-64-candles.png'));

  await sidePanel.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="重置分析台"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('未找到重置分析台按钮');
    button.click();
    return true;
  })()`);
  await sidePanel.waitFor(
    `(() => {
      const input = document.querySelector('input[type="number"]');
      return document.body.innerText.includes('等待分析') &&
        input instanceof HTMLInputElement &&
        input.value === '200' &&
        !document.querySelector('.market-chart') &&
        !document.querySelector('.signal');
    })()`,
    '重置分析台',
  );
  await sidePanel.screenshot(resolve(resultsPath, 'binance-spot-reset.png'));
  console.log(`Binance Spot real Side Panel E2E passed: ${BINANCE_SPOT_URL}`);
} catch (error) {
  if (sidePanel)
    await sidePanel
      .screenshot(resolve(resultsPath, 'binance-spot-e2e-failure.png'))
      .catch(() => undefined);
  throw error;
} finally {
  await context?.close().catch(() => undefined);
  await rm(profilePath, { recursive: true, force: true });
}
