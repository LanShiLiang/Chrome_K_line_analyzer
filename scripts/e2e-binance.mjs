import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const E2E_PROFILES = {
  binance: {
    label: 'Binance',
    url: process.env.KLA_BINANCE_E2E_URL ?? 'https://www.binance.com/en/trade/BTC_USDT?type=spot',
    urlPattern: /binance\.com\/en\/trade\/BTC_USDT/i,
    hostMarker: 'binance.com/',
    pathMarker: '/trade/',
    screenshotPrefix: 'binance-spot',
  },
  tonghuashun: {
    label: '同花顺',
    url: process.env.KLA_TONGHUASHUN_E2E_URL ?? 'https://stockpage.10jqka.com.cn/600519/',
    urlPattern: /stockpage\.10jqka\.com\.cn\/600519\//i,
    hostMarker: 'stockpage.10jqka.com.cn/',
    pathMarker: '/600519/',
    screenshotPrefix: 'tonghuashun-600519',
  },
};
const profileName = process.argv[2] ?? 'binance';
const profile = E2E_PROFILES[profileName];
if (!profile)
  throw new Error(
    `未知 E2E 站点：${profileName}；可选值为 ${Object.keys(E2E_PROFILES).join('、')}`,
  );
const localeName = process.argv[3] ?? 'en-US';
const E2E_LOCALES = {
  'en-US': {
    language: 'en',
    popupTitle: 'Volume-Price Analyzer',
    popupButton: 'Open Side Panel',
    drawerTitle: 'Volume-Price Workbench',
    evidenceTitle: 'Analysis Evidence',
  },
  'zh-CN': {
    language: 'zh',
    popupTitle: '量价分析器',
    popupButton: '打开侧边分析面板',
    drawerTitle: '量价分析台',
    evidenceTitle: '分析依据',
  },
};
const locale = E2E_LOCALES[localeName];
if (!locale)
  throw new Error(
    `Unknown E2E locale: ${localeName}. Expected ${Object.keys(E2E_LOCALES).join(', ')}`,
  );
const localeSlug = localeName.toLowerCase();
const extensionPath = resolve('dist');
const resultsPath = resolve('test-results');
const resultPath = (suffix) =>
  resolve(resultsPath, `${profile.screenshotPrefix}-${localeSlug}-${suffix}.png`);
const profilePath = await mkdtemp(join(tmpdir(), `kla-${profileName}-e2e-`));

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
    const diagnostics = await evaluate('globalThis.__klaE2EWaitDiagnostics');
    throw new Error(
      `${description}超时\nSide Panel 当前内容：\n${body}\n诊断：${JSON.stringify(diagnostics)}`,
    );
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
  const error = document.querySelector('.error')?.textContent ?? '';
  const chart = document.querySelector('.market-chart');
  const analysisWindow = document.querySelector('[data-testid="analysis-window"]');
  const evidenceHeading = document.querySelector('[data-testid="analysis-evidence-heading"]');
  const evidenceSection = evidenceHeading?.closest('section');
  const rationale = evidenceSection?.querySelectorAll('article, .warning') ?? [];
  const signalValues = document.querySelectorAll('.signal strong');
  const action = document.querySelector('[data-testid="analysis-action"]')?.textContent?.trim();
  const stage = document.querySelector('[data-testid="analysis-stage"]')?.textContent?.trim();
  const internalKeywords = ['BUY', 'SELL', 'HOLD', 'RISK', 'ACCUMULATION', 'SPRING_TEST', 'MARKUP', 'DISTRIBUTION', 'MARKDOWN', 'UNKNOWN'];
  const canvases = [...(chart?.querySelectorAll('canvas') ?? [])];
  const canvasColorCounts = canvases.map((canvas) => {
    const context = canvas.getContext('2d');
    if (!context || canvas.width < 1 || canvas.height < 1) return 0;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    const stepX = Math.max(1, Math.floor(canvas.width / 48));
    const stepY = Math.max(1, Math.floor(canvas.height / 32));
    for (let y = 0; y < canvas.height; y += stepY) {
      for (let x = 0; x < canvas.width; x += stepX) {
        const index = (y * canvas.width + x) * 4;
        colors.add(
          pixels[index] + ',' + pixels[index + 1] + ',' + pixels[index + 2] + ',' + pixels[index + 3]
        );
        if (colors.size >= 3) return colors.size;
      }
    }
    return colors.size;
  });
  const diagnostics = {
    expectedCandles: '${expectedCandles}',
    renderedCandles: chart?.getAttribute('data-candle-count'),
    signalValues: [...signalValues].map((value) => value.textContent?.trim()),
    rationaleCount: rationale.length,
    canvasColorCounts,
    evidenceHeading: evidenceHeading?.textContent?.trim(),
    action,
    stage,
    hasLocalizedValues: Boolean(action && stage) && !internalKeywords.includes(action) && !internalKeywords.includes(stage),
    error
  };
  globalThis.__klaE2EWaitDiagnostics = diagnostics;
  return diagnostics.evidenceHeading === ${JSON.stringify(locale.evidenceTitle)} &&
    diagnostics.hasLocalizedValues &&
    diagnostics.renderedCandles === diagnostics.expectedCandles &&
    analysisWindow?.textContent?.includes(diagnostics.expectedCandles) &&
    diagnostics.signalValues.length === 3 &&
    diagnostics.signalValues.every(Boolean) &&
    diagnostics.rationaleCount > 0 &&
    diagnostics.canvasColorCounts.some((count) => count >= 3) &&
    !error;
})()`;

const responsiveLayoutExpression = `(() => {
  const viewportWidth = document.documentElement.clientWidth;
  const pageScrollWidth = Math.max(
    document.documentElement.scrollWidth,
    document.body.scrollWidth
  );
  const selectors = [
    'main',
    'header',
    'section',
    'details',
    '.actions',
    '.signal',
    '.market-chart'
  ];
  const overflowingElements = [...document.querySelectorAll(selectors.join(','))]
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > viewportWidth + 1;
    })
    .map((element) => ({
      tag: element.tagName,
      className: element.className,
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right
    }));
  const diagnostics = { viewportWidth, pageScrollWidth, overflowingElements };
  globalThis.__klaE2EResponsiveDiagnostics = diagnostics;
  return pageScrollWidth <= viewportWidth + 1 && overflowingElements.length === 0;
})()`;

const collapsedLayoutExpression = `(() => {
  const drawer = document.querySelector('.drawer-shell');
  const viewportWidth = document.documentElement.clientWidth;
  return drawer instanceof HTMLElement &&
    [...drawer.children].every((child) => getComputedStyle(child).display === 'none') &&
    getComputedStyle(drawer, '::before').content.includes('↔') &&
    Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= viewportWidth + 1;
})()`;

const blockActiveMarketRequests = async (serviceWorker) => {
  await serviceWorker.evaluate(() => {
    globalThis.__klaE2EOriginalFetch ??= globalThis.fetch.bind(globalThis);
    globalThis.__klaE2EAbortState = { started: 0, aborted: 0 };
    globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input));
      if (!url.includes('data-api.binance.vision') && !url.includes('d.10jqka.com.cn'))
        return globalThis.__klaE2EOriginalFetch(input, init);
      globalThis.__klaE2EAbortState.started += 1;
      return new Promise((_resolve, reject) => {
        const abort = () => {
          globalThis.__klaE2EAbortState.aborted += 1;
          reject(init?.signal?.reason ?? new DOMException('E2E cancellation', 'AbortError'));
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      });
    };
  });
};

const restoreActiveMarketRequests = async (serviceWorker) => {
  await serviceWorker.evaluate(() => {
    if (globalThis.__klaE2EOriginalFetch) globalThis.fetch = globalThis.__klaE2EOriginalFetch;
  });
};

const waitForAbortedMarketRequest = async (serviceWorker, description) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await serviceWorker.evaluate(() => globalThis.__klaE2EAbortState);
    if (state?.started === 1 && state?.aborted === 1) return;
    await delay(50);
  }
  const state = await serviceWorker.evaluate(() => globalThis.__klaE2EAbortState);
  throw new Error(`${description}未中止唯一的行情请求：${JSON.stringify(state)}`);
};

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
      `--lang=${localeName}`,
      '--no-first-run',
      '--disable-default-apps',
    ],
  });

  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(serviceWorker.url()).host;
  const [marketPage] = context.pages();
  await marketPage.goto(profile.url, {
    waitUntil: 'load',
    timeout: 60_000,
  });
  await marketPage.waitForURL(profile.urlPattern, { timeout: 60_000 });
  await marketPage.waitForTimeout(2_000);

  const marketTabId = await serviceWorker.evaluate(async (label) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error(`未找到 ${label} E2E 标签页`);
    return tab.id;
  }, profile.label);
  const scriptingProbe = await serviceWorker.evaluate(async (tabId) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => true,
    });
    return result?.result;
  }, marketTabId);
  if (scriptingProbe !== true)
    throw new Error(`${profile.label} 页面不允许按需恢复 Content Script`);

  // 通过真实 popup 用户手势打开与当前行情 Tab 绑定的 Chrome Side Panel。
  const popupPage = await context.newPage();
  await popupPage.addInitScript((tabId) => {
    chrome.tabs.query = async () => [{ id: tabId }];
  }, marketTabId);
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await popupPage.setViewportSize({ width: 460, height: 280 });
  await popupPage.waitForTimeout(220);
  const popupLayout = await popupPage.evaluate(() => ({
    bodyWidth: document.body.getBoundingClientRect().width,
    shellWidth: document.querySelector('.popup-shell')?.getBoundingClientRect().width,
  }));
  if (popupLayout.bodyWidth !== 420 || popupLayout.shellWidth !== 420)
    throw new Error(`Popup 宽度异常：${JSON.stringify(popupLayout)}`);
  const actualLocale = await popupPage.evaluate(() => chrome.i18n.getUILanguage());
  if (!actualLocale.toLowerCase().startsWith(locale.language))
    throw new Error(`Chrome UI locale mismatch: expected ${localeName}, received ${actualLocale}`);
  const popupTitle = (await popupPage.locator('h1').textContent())?.trim();
  if (popupTitle !== locale.popupTitle)
    throw new Error(`Popup locale mismatch: expected ${locale.popupTitle}, received ${popupTitle}`);
  await popupPage.screenshot({
    path: resolve(resultsPath, `popup-${localeSlug}-blue-theme.png`),
    type: 'png',
  });
  const openPanelButton = popupPage.locator('[data-testid="open-side-panel"]');
  if ((await openPanelButton.textContent())?.trim() !== locale.popupButton)
    throw new Error(`Popup action is not localized for ${localeName}`);
  await openPanelButton.click();
  await marketPage.bringToFront();
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
    `document.querySelector('[data-testid="market-status"]')?.getAttribute('data-site') === ${JSON.stringify(profileName)}`,
    `Side Panel recognizes ${profile.label}`,
  );
  const localizedDrawerTitle = await sidePanel.evaluate(
    `document.querySelector('h1')?.textContent?.trim()`,
  );
  if (localizedDrawerTitle !== locale.drawerTitle)
    throw new Error(
      `Side Panel locale mismatch: expected ${locale.drawerTitle}, received ${localizedDrawerTitle}`,
    );

  // 旁路记录真实 Side Panel 的消息，并制造同一交易页的无害 URL 快照差异。
  await sidePanel.evaluate(`(() => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (queryInfo) => (await query(queryInfo)).map((tab) => {
      if (!tab.url?.includes(${JSON.stringify(profile.hostMarker)}) ||
          !tab.url.includes(${JSON.stringify(profile.pathMarker)})) return tab;
      const url = new URL(tab.url);
      url.searchParams.set('theme', 'dark');
      url.searchParams.set('kla_e2e', 'same-market-url-variant');
      return { ...tab, url: url.toString() };
    });
    globalThis.__klaE2EAnalysisTraces = [];
    globalThis.__klaE2EControlTraces = [];
    globalThis.__klaE2EContentRecovery = { forcedFailures: 0, injections: [] };
    const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message) => {
      const response = await sendMessage(message);
      if (message?.type === 'RUN_ANALYSIS')
        globalThis.__klaE2EAnalysisTraces.push({ message, response });
      if (message?.type === 'CANCEL_ANALYSIS' || message?.type === 'RESET_ANALYSIS')
        globalThis.__klaE2EControlTraces.push({ message, response });
      return response;
    };
    const sendTabMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = async (tabId, message, options) => {
      if (message?.type === 'START_SELECTION' &&
          globalThis.__klaE2EContentRecovery.forcedFailures === 0) {
        globalThis.__klaE2EContentRecovery.forcedFailures += 1;
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
      return options === undefined
        ? sendTabMessage(tabId, message)
        : sendTabMessage(tabId, message, options);
    };
    const executeScript = chrome.scripting.executeScript.bind(chrome.scripting);
    chrome.scripting.executeScript = async (injection) => {
      if (injection?.files?.some((file) => file === 'inject.js' || file === 'content.js')) {
        globalThis.__klaE2EContentRecovery.injections.push({
          files: injection.files,
          world: injection.world
        });
        // 此页已有真实 Content Script；记录生产恢复调用但避免在测试页重复安装监听器。
        return [];
      }
      return executeScript(injection);
    };
    return true;
  })()`);

  // 人为挂起真实后台行情请求，验证 Loading 可见、取消会中止当前请求且不发送重试。
  await blockActiveMarketRequests(serviceWorker);
  await sidePanel.evaluate(`(() => {
    const button = document.querySelector('[data-testid="run-analysis"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled)
      throw new Error('取消测试前的开始分析按钮不可用');
    button.click();
    return true;
  })()`);
  await sidePanel.waitFor(
    `(() => {
      const dialog = document.querySelector('[data-testid="config-dialog"]');
      const backdrop = document.querySelector('.config-dialog-backdrop');
      const input = dialog?.querySelector('input[type="number"]');
      const remember = dialog?.querySelector('input[type="checkbox"]');
      const start = document.querySelector('[data-testid="run-analysis"]');
      const settings = document.querySelector('[data-testid="open-config"]');
      const backdropBounds = backdrop?.getBoundingClientRect();
      const startBounds = start?.getBoundingClientRect();
      const settingsBounds = settings?.getBoundingClientRect();
      return dialog?.getAttribute('role') === 'dialog' &&
        input instanceof HTMLInputElement && input.value === '200' && input.min === '5' &&
        remember instanceof HTMLInputElement && !remember.checked &&
        backdropBounds?.top === 0 && backdropBounds.bottom === innerHeight &&
        settingsBounds && startBounds && settingsBounds.right <= startBounds.right &&
        settingsBounds.left >= startBounds.left &&
        getComputedStyle(settings).backgroundImage === 'none' &&
        Boolean(document.querySelector('[data-testid="confirm-config"]'));
    })()`,
    '首次开始分析弹出参数配置浮窗',
  );
  await sidePanel.screenshot(resultPath('config-dialog'));
  await sidePanel.send('Emulation.setDeviceMetricsOverride', {
    width: 480,
    height: 360,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sidePanel.waitFor(
    `(() => {
      const backdrop = document.querySelector('.config-dialog-backdrop')?.getBoundingClientRect();
      const dialog = document.querySelector('[data-testid="config-dialog"]')?.getBoundingClientRect();
      return backdrop?.top === 0 && backdrop.bottom === innerHeight &&
        dialog && dialog.top >= 10 && dialog.bottom <= innerHeight - 10;
    })()`,
    '低高度侧栏中的完整参数浮窗',
  );
  await sidePanel.screenshot(resultPath('config-dialog-short-height'));
  await sidePanel.send('Emulation.setDeviceMetricsOverride', {
    width: 480,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sidePanel.evaluate(`(() => {
    const remember = document.querySelector('[data-testid="config-dialog"] input[type="checkbox"]');
    if (!(remember instanceof HTMLInputElement)) throw new Error('未找到保留配置复选框');
    remember.click();
    document.querySelector('[data-testid="confirm-config"]')?.click();
    return true;
  })()`);
  await sidePanel.waitFor(
    `(() => {
      const loading = document.querySelector('[data-testid="analysis-loading"]');
      const cancel = document.querySelector('[data-testid="cancel-analysis"]');
      return loading?.getAttribute('aria-busy') === 'true' &&
        cancel instanceof HTMLButtonElement && !cancel.disabled &&
        !document.querySelector('[data-testid="analysis-empty"]') &&
        !document.querySelector('.market-chart') &&
        document.body.innerText.trim().length > 100;
    })()`,
    '普通分析 Loading 界面',
  );
  await sidePanel.screenshot(resultPath('analysis-loading'));
  await sidePanel.evaluate(`document.querySelector('[data-testid="cancel-analysis"]')?.click()`);
  await sidePanel.waitFor(
    `(() => {
      const control = globalThis.__klaE2EControlTraces.at(-1);
      return !document.querySelector('[data-testid="analysis-loading"]') &&
        Boolean(document.querySelector('[data-testid="analysis-empty"]')) &&
        !document.querySelector('.error') &&
        control?.message?.type === 'CANCEL_ANALYSIS' && control.response?.ok === true;
    })()`,
    '取消普通分析并清理界面状态',
  );
  await waitForAbortedMarketRequest(serviceWorker, '取消普通分析');
  await sidePanel.waitFor(
    `globalThis.__klaE2EAnalysisTraces.at(-1)?.response?.error?.code === 'E_ANALYSIS_CANCELLED'`,
    '后台确认普通分析已取消',
  );
  await sidePanel.screenshot(resultPath('analysis-cancelled'));
  await restoreActiveMarketRequests(serviceWorker);

  await sidePanel.evaluate(`(() => {
    const button = document.querySelector('[data-testid="run-analysis"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled)
      throw new Error('真实 Side Panel 的开始分析按钮不可用');
    button.click();
    return true;
  })()`);
  await sidePanel.waitFor(renderedAnalysisExpression(200), '渲染 200 根 K 线和分析结果');
  const firstTrace = await sidePanel.evaluate(`globalThis.__klaE2EAnalysisTraces.at(-1)`);
  if (firstTrace?.message?.tabId !== marketTabId)
    throw new Error(`RUN_ANALYSIS 未绑定到当前 ${profile.label} 标签页`);
  if (firstTrace?.response?.data?.context?.tabId !== marketTabId)
    throw new Error(`分析响应未绑定到当前 ${profile.label} 标签页`);
  if (firstTrace?.message?.payload?.config?.analysisCandleCount !== 200)
    throw new Error('默认分析 K 线数量未传入后台');
  if (firstTrace?.response?.data?.marketData?.candles?.length !== 200)
    throw new Error('后台没有返回 200 根 K 线');

  // 在已有结果上再次挂起请求并点击右上角重置，验证重置会取消后台任务、清空全部
  // Tab 级状态，并允许下一次分析从干净状态成功运行。
  await blockActiveMarketRequests(serviceWorker);
  await sidePanel.evaluate(`document.querySelector('[data-testid="run-analysis"]')?.click()`);
  await sidePanel.waitFor(
    `Boolean(document.querySelector('[data-testid="analysis-loading"]')) &&
      !document.querySelector('.market-chart') && !document.querySelector('.signal')`,
    '重置前进入 Loading 状态',
  );
  await sidePanel.evaluate(`document.querySelector('[data-testid="reset-analyzer"]')?.click()`);
  await sidePanel.waitFor(
    `(() => {
      const control = globalThis.__klaE2EControlTraces.at(-1);
      return Boolean(document.querySelector('[data-testid="analysis-empty"]')) &&
        !document.querySelector('[data-testid="config-dialog"]') &&
        !document.querySelector('[data-testid="analysis-loading"]') &&
        !document.querySelector('.market-chart') && !document.querySelector('.signal') &&
        !document.querySelector('.error') &&
        control?.message?.type === 'RESET_ANALYSIS' && control.response?.ok === true;
    })()`,
    '计算期间可靠重置分析台',
  );
  await waitForAbortedMarketRequest(serviceWorker, '计算期间重置');
  await sidePanel.screenshot(resultPath('reset-during-analysis'));
  await restoreActiveMarketRequests(serviceWorker);
  await sidePanel.evaluate(`document.querySelector('[data-testid="run-analysis"]')?.click()`);
  await sidePanel.waitFor(
    `Boolean(document.querySelector('[data-testid="config-dialog"]'))`,
    '重置后恢复参数确认浮窗',
  );
  await sidePanel.evaluate(`(() => {
    const remember = document.querySelector('[data-testid="config-dialog"] input[type="checkbox"]');
    if (remember instanceof HTMLInputElement && !remember.checked) remember.click();
    document.querySelector('[data-testid="confirm-config"]')?.click();
  })()`);
  await sidePanel.waitFor(renderedAnalysisExpression(200), '重置后重新分析 200 根 K 线');
  const postResetTrace = await sidePanel.evaluate(`globalThis.__klaE2EAnalysisTraces.at(-1)`);
  if (postResetTrace?.response?.data?.marketData?.candles?.length !== 200)
    throw new Error('重置后的下一次分析残留了旧任务状态');

  // 回归真实用户操作：先放宽 Side Panel，再缩窄，所有内容和图表容器都必须重新排版。
  await sidePanel.send('Emulation.setDeviceMetricsOverride', {
    width: 640,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sidePanel.waitFor(responsiveLayoutExpression, 'Side Panel 放宽后的响应式布局');
  await sidePanel.send('Emulation.setDeviceMetricsOverride', {
    width: 300,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sidePanel.waitFor(responsiveLayoutExpression, 'Side Panel 缩窄后的响应式布局');
  await sidePanel.screenshot(resultPath('responsive-300px'));
  await sidePanel.send('Emulation.setDeviceMetricsOverride', {
    width: 80,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sidePanel.waitFor(collapsedLayoutExpression, 'Side Panel 极窄折叠状态');
  await sidePanel.screenshot(resultPath('collapsed-80px'));
  await sidePanel.send('Emulation.setDeviceMetricsOverride', {
    width: 480,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sidePanel.waitFor(
    `(() => {
      if (!(${responsiveLayoutExpression})) return false;
      const drawer = document.querySelector('.drawer-shell');
      const heading = document.querySelector('h1');
      return document.documentElement.scrollLeft === 0 &&
        document.body.scrollLeft === 0 &&
        (drawer?.getBoundingClientRect().left ?? -1) >= 0 &&
        (heading?.getBoundingClientRect().left ?? -1) >= 0;
    })()`,
    'Side Panel 恢复宽度后归零横向滚动并完整显示左侧内容',
  );
  await sidePanel.screenshot(resultPath('200-candles'));
  await marketPage.screenshot({
    path: resultPath('market-page'),
    type: 'png',
  });

  const settingsHoverPoint = await sidePanel.evaluate(`(() => {
    const settings = document.querySelector('[data-testid="open-config"]');
    if (!(settings instanceof HTMLButtonElement) || settings.disabled)
      throw new Error('齿轮悬停测试前按钮不可用');
    const bounds = settings.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  })()`);
  await sidePanel.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: settingsHoverPoint.x,
    y: settingsHoverPoint.y,
  });
  await sidePanel.waitFor(
    `(() => {
      const settings = document.querySelector('[data-testid="open-config"]');
      const icon = settings?.querySelector('svg');
      if (!(settings instanceof HTMLButtonElement) || !(icon instanceof SVGElement)) return false;
      const buttonStyle = getComputedStyle(settings);
      const glowStyle = getComputedStyle(settings, '::before');
      const iconStyle = getComputedStyle(icon);
      return buttonStyle.backgroundColor === 'rgba(0, 0, 0, 0)' &&
        buttonStyle.backgroundImage === 'none' &&
        glowStyle.opacity === '1' &&
        iconStyle.transform !== 'none' &&
        iconStyle.filter.includes('drop-shadow');
    })()`,
    '齿轮透明悬停、局部光晕与上移动效',
  );
  await sidePanel.screenshot(resultPath('settings-hover'));
  await sidePanel.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });

  await sidePanel.evaluate(`document.querySelector('[data-testid="open-config"]')?.click()`);
  await sidePanel.waitFor(
    `Boolean(document.querySelector('[data-testid="config-dialog"]'))`,
    '齿轮重新打开参数浮窗',
  );
  await sidePanel.evaluate(`(() => {
    const input = document.querySelector('input[type="number"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('未找到分析 K 线数量输入框');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '64');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sidePanel.evaluate(`document.querySelector('[data-testid="confirm-config"]')?.click()`);
  await sidePanel.evaluate(`document.querySelector('[data-testid="run-analysis"]')?.click()`);
  await sidePanel.waitFor(renderedAnalysisExpression(64), '按 64 根 K 线重新分析');
  const secondTrace = await sidePanel.evaluate(`globalThis.__klaE2EAnalysisTraces.at(-1)`);
  if (secondTrace?.message?.payload?.config?.analysisCandleCount !== 64)
    throw new Error('修改后的分析 K 线数量未传入后台');
  if (secondTrace?.response?.data?.marketData?.candles?.length !== 64)
    throw new Error('策略参数变更后后台没有返回 64 根 K 线');
  await sidePanel.screenshot(resultPath('64-candles'));

  for (const period of ['30m', '1h', '4h']) {
    await sidePanel.evaluate(`document.querySelector('[data-testid="open-config"]')?.click()`);
    await sidePanel.waitFor(
      `Boolean(document.querySelector('[data-testid="config-dialog"]'))`,
      `打开 ${period} 参数浮窗`,
    );
    await sidePanel.evaluate(`(() => {
      const select = document.querySelector('select');
      if (!(select instanceof HTMLSelectElement)) throw new Error('未找到行情周期选择框');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, ${JSON.stringify(period)});
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sidePanel.evaluate(`document.querySelector('[data-testid="confirm-config"]')?.click()`);
    await sidePanel.evaluate(`document.querySelector('[data-testid="run-analysis"]')?.click()`);
    await sidePanel.waitFor(
      `(() => {
        const trace = globalThis.__klaE2EAnalysisTraces.at(-1);
        return trace?.message?.payload?.config?.analysisPeriod === ${JSON.stringify(period)} &&
          trace?.response?.ok === true &&
          trace.response.data.marketData?.period === ${JSON.stringify(period)} &&
          trace.response.data.marketData?.candles?.length === 64 &&
          Boolean(document.querySelector('[data-testid="analysis-action"]'));
      })()`,
      `${period} 周期分析`,
    );
  }
  await sidePanel.screenshot(resultPath('intraday-periods'));

  await sidePanel.evaluate(`document.querySelector('[data-testid="open-config"]')?.click()`);
  await sidePanel.waitFor(
    `Boolean(document.querySelector('[data-testid="config-dialog"]'))`,
    '打开参数浮窗验证非法数量',
  );
  await sidePanel.evaluate(`(() => {
    globalThis.__klaE2ETraceCountBeforeInvalidInput = globalThis.__klaE2EAnalysisTraces.length;
    const input = document.querySelector('input[type="number"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('未找到分析 K 线数量输入框');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sidePanel.waitFor(
    `(() => {
      const input = document.querySelector('input[type="number"]');
      const error = document.querySelector('[data-testid="config-validation"]')?.textContent ?? '';
      return input instanceof HTMLInputElement && input.value === '' &&
        input.min === '5' && error.length > 0 &&
        globalThis.__klaE2EAnalysisTraces.length === globalThis.__klaE2ETraceCountBeforeInvalidInput;
    })()`,
    '允许清空输入且不触发行情请求',
  );
  await sidePanel.evaluate(`(() => {
    const input = document.querySelector('input[type="number"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '4');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sidePanel.evaluate(`document.querySelector('[data-testid="confirm-config"]')?.click()`);
  await sidePanel.waitFor(
    `(() => {
      const input = document.querySelector('input[type="number"]');
      const error = document.querySelector('[data-testid="config-validation"]')?.textContent ?? '';
      return input instanceof HTMLInputElement && input.value === '4' && error.includes('5') &&
        globalThis.__klaE2EAnalysisTraces.length === globalThis.__klaE2ETraceCountBeforeInvalidInput;
    })()`,
    '小于 5 根时仅显示校验提示且不请求行情',
  );
  await sidePanel.screenshot(resultPath('4-candles-validation'));
  await sidePanel.evaluate(`(() => {
    const input = document.querySelector('input[type="number"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '64');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sidePanel.evaluate(`document.querySelector('[data-testid="confirm-config"]')?.click()`);

  if (profileName === 'tonghuashun') {
    const chartBounds = await marketPage.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.dataset.klaE2eUnsupportedPeriodChart = 'true';
      canvas.width = 900;
      canvas.height = 420;
      Object.assign(canvas.style, {
        position: 'fixed',
        left: '80px',
        top: '110px',
        width: '900px',
        height: '420px',
        zIndex: '2147483000',
        border: '1px solid #d8dee8',
        background: '#ffffff',
      });
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建同花顺框选 E2E Canvas');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      for (let index = 0; index < 30; index += 1) {
        const rising = index % 3 !== 1;
        const color = rising ? '#f23645' : '#089981';
        const x = 35 + index * 28;
        const openY = 210 + Math.sin(index / 4) * 55;
        const closeY = openY + (rising ? -24 : 20);
        context.strokeStyle = color;
        context.fillStyle = color;
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(x, Math.min(openY, closeY) - 15);
        context.lineTo(x, Math.max(openY, closeY) + 15);
        context.stroke();
        context.fillRect(x - 5, Math.min(openY, closeY), 10, Math.abs(closeY - openY));
      }
      const period = document.createElement('button');
      period.textContent = '120分';
      Object.assign(period.style, {
        position: 'fixed',
        left: '80px',
        top: '70px',
        zIndex: '2147483001',
        fontWeight: '900',
        color: '#111827',
      });
      document.documentElement.append(canvas, period);
      const rect = canvas.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    });
    await serviceWorker.evaluate(() => {
      chrome.tabs.captureVisibleTab = async () => {
        throw new Error('E2E forced captureVisibleTab permission failure');
      };
    });
    await sidePanel.evaluate(`document.querySelector('[data-testid="select-candles"]')?.click()`);
    await marketPage.waitForSelector('[data-kla-selection-overlay="true"]', { timeout: 5_000 });
    await marketPage.mouse.move(chartBounds.left + 15, chartBounds.top + 15);
    await marketPage.mouse.down();
    await marketPage.mouse.move(
      chartBounds.left + chartBounds.width - 15,
      chartBounds.top + chartBounds.height - 15,
      { steps: 12 },
    );
    await marketPage.mouse.up();
    await sidePanel.waitFor(
      `(() => {
        const trace = globalThis.__klaE2EAnalysisTraces.at(-1);
        const summary = document.querySelector('[data-testid="selection-summary"]');
        const error = document.querySelector('.error-block')?.textContent ?? '';
        return Number(summary?.getAttribute('data-detected-candles') ?? 0) >= 12 &&
          trace?.response?.error?.code === 'E_SELECTION_PERIOD_UNSUPPORTED' &&
          error.includes('120m');
      })()`,
      '同花顺 120 分图像可识别并明确提示周期不支持',
    );
    await sidePanel.screenshot(resultPath('selection-120m-unsupported'));
  }

  if (profileName === 'binance') {
    const response = await fetch(
      'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=30m&limit=300',
    );
    if (!response.ok) throw new Error(`无法准备 30m 框选 E2E 行情：HTTP ${response.status}`);
    const fixtureRows = await response.json();
    const chartBounds = await marketPage.evaluate((rows) => {
      const selected = rows.slice(160, 220);
      const canvas = document.createElement('canvas');
      canvas.dataset.klaE2eSelectionChart = 'true';
      canvas.width = 900;
      canvas.height = 420;
      Object.assign(canvas.style, {
        position: 'fixed',
        left: '80px',
        top: '110px',
        width: '900px',
        height: '420px',
        zIndex: '2147483000',
        border: '1px solid #33414b',
        background: '#101820',
      });
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建 30m 框选 E2E Canvas');
      context.fillStyle = '#101820';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const lows = selected.map((row) => Number(row[3]));
      const highs = selected.map((row) => Number(row[2]));
      const low = Math.min(...lows);
      const high = Math.max(...highs);
      const toY = (price) => 35 + ((high - price) / Math.max(high - low, 1)) * 225;
      const step = 840 / selected.length;
      const volumeMax = Math.max(...selected.map((row) => Number(row[5])));
      selected.forEach((row, index) => {
        const open = Number(row[1]);
        const candleHigh = Number(row[2]);
        const candleLow = Number(row[3]);
        const close = Number(row[4]);
        const color = close >= open ? '#0ECB81' : '#F6465D';
        const x = 30 + index * step + step / 2;
        context.strokeStyle = color;
        context.fillStyle = color;
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(x, toY(candleHigh));
        context.lineTo(x, toY(candleLow));
        context.stroke();
        const bodyTop = Math.min(toY(open), toY(close));
        const bodyHeight = Math.max(3, Math.abs(toY(open) - toY(close)));
        context.fillRect(x - 4, bodyTop, 8, bodyHeight);
        const volumeHeight = (Number(row[5]) / Math.max(volumeMax, 1)) * 92;
        context.fillRect(x - 4, 395 - volumeHeight, 8, volumeHeight);
      });
      context.strokeStyle = '#33414b';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(20, 285);
      context.lineTo(880, 285);
      context.stroke();
      const drawOverlay = (color, yAt) => {
        context.strokeStyle = color;
        context.lineWidth = 2;
        context.beginPath();
        for (let x = 20; x <= 880; x += 2) {
          const y = yAt(x);
          if (x === 20) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      };
      // 使用真实行情图常见的红绿连续均线复现“整段被合并为 1 根”的历史回归。
      drawOverlay('#F6465D', (x) => 175 + Math.sin(x / 95) * 14);
      drawOverlay('#0ECB81', (x) => 365 + Math.sin(x / 70) * 5);
      drawOverlay('#B07CFF', (x) => 115 + x / 14);
      const period = document.createElement('button');
      period.textContent = '30m';
      Object.assign(period.style, {
        position: 'fixed',
        left: '80px',
        top: '70px',
        zIndex: '2147483001',
        fontWeight: '700',
        color: '#f5f7fa',
      });
      document.documentElement.append(canvas, period);
      window.postMessage(
        {
          channel: 'KLA_MARKET_RESPONSE',
          payload: {
            id: 'kla-e2e-binance-30m',
            siteId: 'binance',
            symbol: 'BTCUSDT',
            period: '30m',
            pageUrl: location.href,
            url: 'wss://stream.binance.com/ws/btcusdt@kline_30m',
            method: 'WS',
            status: 101,
            requestAt: Date.now() - 1000,
            responseAt: Date.now() + 60_000,
            source: 'websocket',
            raw: rows,
            confidence: 100,
          },
        },
        location.origin,
      );
      const rect = canvas.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }, fixtureRows);
    await marketPage.waitForTimeout(300);
    // 本 E2E 直接打开 popup.html，未经过 Chrome 工具栏动作，因此不会获得 activeTab
    // 的临时截图授权。注入同一活动页的真实视口截图，只替代权限入口，后续裁剪、
    // 像素识别、消息同步仍完整运行生产代码。
    const viewportImage = `data:image/png;base64,${(
      await marketPage.screenshot({ type: 'png' })
    ).toString('base64')}`;
    await serviceWorker.evaluate((dataUrl) => {
      chrome.tabs.captureVisibleTab = async () => dataUrl;
    }, viewportImage);
    await sidePanel.evaluate(`(() => {
      const button = document.querySelector('[data-testid="select-candles"]');
      if (!(button instanceof HTMLButtonElement) || button.disabled)
        throw new Error('框选 K 线按钮不可用');
      button.click();
      return true;
    })()`);
    await marketPage.waitForSelector('[data-kla-selection-overlay="true"]', { timeout: 5_000 });
    const recoveryTrace = await sidePanel.evaluate(`globalThis.__klaE2EContentRecovery`);
    if (
      recoveryTrace?.forcedFailures !== 1 ||
      recoveryTrace?.injections?.length !== 2 ||
      recoveryTrace.injections[0]?.world !== 'MAIN' ||
      recoveryTrace.injections[0]?.files?.[0] !== 'inject.js' ||
      recoveryTrace.injections[1]?.world !== 'ISOLATED' ||
      recoveryTrace.injections[1]?.files?.[0] !== 'content.js'
    )
      throw new Error(`Content Script 自恢复链路不完整：${JSON.stringify(recoveryTrace)}`);
    const recoveryError = await sidePanel.evaluate(
      `document.querySelector('.error')?.textContent ?? ''`,
    );
    if (recoveryError.includes('Receiving end does not exist'))
      throw new Error('Content Script 自恢复后仍向用户显示原始连接错误');
    await marketPage.screenshot({
      path: resultPath('selection-recovered-overlay'),
      type: 'png',
    });
    await sidePanel.evaluate(`document.querySelector('[data-testid="reset-analyzer"]')?.click()`);
    await marketPage.waitForSelector('[data-kla-selection-overlay="true"]', {
      state: 'detached',
      timeout: 5_000,
    });
    await sidePanel.waitFor(
      `Boolean(document.querySelector('[data-testid="analysis-empty"]')) &&
        !document.querySelector('[data-testid="selection-summary"]')`,
      '重置可靠关闭尚未完成的框选遮罩',
    );
    await sidePanel.evaluate(`document.querySelector('[data-testid="select-candles"]')?.click()`);
    await marketPage.waitForSelector('[data-kla-selection-overlay="true"]', { timeout: 5_000 });
    const startX = chartBounds.left + 20;
    const endX = chartBounds.left + chartBounds.width - 20;
    const startY = chartBounds.top + 10;
    const endY = chartBounds.top + chartBounds.height - 30;
    await blockActiveMarketRequests(serviceWorker);
    await marketPage.mouse.move(startX, startY);
    await marketPage.mouse.down();
    await marketPage.mouse.move(endX, endY, { steps: 12 });
    await marketPage.mouse.up();
    await sidePanel.waitFor(
      `(() => {
        const summary = document.querySelector('[data-testid="selection-summary"]');
        const image = summary?.querySelector('img');
        return Number(summary?.getAttribute('data-detected-candles') ?? 0) >= 5 &&
          image instanceof HTMLImageElement && image.src.startsWith('data:image/png;base64,') &&
          Boolean(document.querySelector('[data-testid="analysis-loading"]'));
      })()`,
      '本地截取图像并自动进入框选分析',
    );
    await sidePanel.screenshot(resultPath('selection-recognized'));
    await sidePanel.waitFor(
      `(() => {
        const loading = document.querySelector('[data-testid="analysis-loading"]');
        const selection = document.querySelector('[data-testid="selection-summary"]');
        return loading?.getAttribute('aria-busy') === 'true' &&
          Boolean(document.querySelector('[data-testid="cancel-analysis"]')) &&
          Boolean(selection) && !document.querySelector('.market-chart') &&
          !document.querySelector('.signal');
      })()`,
      '框选分析 Loading 界面',
    );
    await sidePanel.screenshot(resultPath('selection-loading'));
    await sidePanel.evaluate(`document.querySelector('[data-testid="cancel-analysis"]')?.click()`);
    await sidePanel.waitFor(
      `(() => {
        const control = globalThis.__klaE2EControlTraces.at(-1);
        return !document.querySelector('[data-testid="analysis-loading"]') &&
          !document.querySelector('[data-testid="selection-summary"]') &&
          Boolean(document.querySelector('[data-testid="analysis-empty"]')) &&
          !document.querySelector('.market-chart') && !document.querySelector('.signal') &&
          !document.querySelector('.error') &&
          control?.message?.type === 'CANCEL_ANALYSIS' && control.response?.ok === true;
      })()`,
      '取消框选分析并清理选区状态',
    );
    await waitForAbortedMarketRequest(serviceWorker, '取消框选分析');
    await sidePanel.waitFor(
      `globalThis.__klaE2EAnalysisTraces.at(-1)?.response?.error?.code === 'E_ANALYSIS_CANCELLED'`,
      '后台确认框选分析已取消',
    );
    await sidePanel.screenshot(resultPath('selection-cancelled'));
    const cancelledState = await sidePanel.evaluate(`(async () => {
      const traceCount = globalThis.__klaE2EAnalysisTraces.length;
      const response = await chrome.runtime.sendMessage({
        id: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
        type: 'GET_STATE',
        source: 'drawer',
        tabId: ${marketTabId},
        payload: { url: ${JSON.stringify(profile.url)}, title: '' },
        timestamp: Date.now()
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        selection: response?.data?.selection,
        traceCount,
        nextTraceCount: globalThis.__klaE2EAnalysisTraces.length
      };
    })()`);
    if (cancelledState?.selection || cancelledState?.traceCount !== cancelledState?.nextTraceCount)
      throw new Error(`取消后的框选状态复活或自动重跑：${JSON.stringify(cancelledState)}`);
    await restoreActiveMarketRequests(serviceWorker);
    await sidePanel.evaluate(`(() => {
      const button = document.querySelector('[data-testid="select-candles"]');
      if (!(button instanceof HTMLButtonElement) || button.disabled)
        throw new Error('取消后无法重新框选');
      button.click();
      return true;
    })()`);
    await marketPage.waitForSelector('[data-kla-selection-overlay="true"]', { timeout: 5_000 });
    await marketPage.mouse.move(startX, startY);
    await marketPage.mouse.down();
    await marketPage.mouse.move(endX, endY, { steps: 12 });
    await marketPage.mouse.up();
    await sidePanel.waitFor(
      `(() => {
        const trace = globalThis.__klaE2EAnalysisTraces.at(-1);
        const interpretation = trace?.response?.data?.selection?.interpretation;
        const marketData = trace?.response?.data?.marketData;
        return trace?.response?.ok === true &&
          trace.response.data.context?.mode === 'selection' &&
          interpretation?.period === '30m' &&
          interpretation.candleCount >= 20 &&
          interpretation.startTime < interpretation.endTime &&
          marketData?.period === '30m' &&
          marketData.candles?.length === interpretation.candleCount &&
          Boolean(document.querySelector('[data-testid="analysis-action"]')) &&
          document.querySelector('[data-testid="selection-summary"]')?.textContent?.includes('30');
      })()`,
      '30m 框选日期、区间行情与分析结果闭环',
    );
    await sidePanel.screenshot(resultPath('selection-analysis'));

    await sidePanel.evaluate(`document.querySelector('[data-testid="run-analysis"]')?.click()`);
    await sidePanel.waitFor(
      `Boolean(document.querySelector('[data-testid="config-dialog"]'))`,
      '框选后首次手工分析仍需确认参数',
    );
    await sidePanel.evaluate(`(() => {
      const remember = document.querySelector('[data-testid="config-dialog"] input[type="checkbox"]');
      if (remember instanceof HTMLInputElement && !remember.checked) remember.click();
      document.querySelector('[data-testid="confirm-config"]')?.click();
    })()`);
    await sidePanel.waitFor(
      `(() => {
        const trace = globalThis.__klaE2EAnalysisTraces.at(-1);
        return trace?.response?.ok === true &&
          trace.response.data.context?.mode === 'configured-request' &&
          !document.querySelector('[data-testid="selection-summary"]') &&
          Boolean(document.querySelector('[data-testid="analysis-window"]'));
      })()`,
      '手工分析替换框选状态和结果',
    );
    await sidePanel.screenshot(resultPath('manual-replaces-selection'));
  }

  await sidePanel.evaluate(`document.querySelector('[data-testid="open-config"]')?.click()`);
  await sidePanel.waitFor(
    `Boolean(document.querySelector('[data-testid="config-dialog"]'))`,
    '重新打开参数浮窗取消保留配置',
  );
  await sidePanel.evaluate(`(() => {
    const remember = document.querySelector('[data-testid="config-dialog"] input[type="checkbox"]');
    if (!(remember instanceof HTMLInputElement) || !remember.checked)
      throw new Error('保留配置状态未正确恢复');
    remember.click();
    document.querySelector('[data-testid="confirm-config"]')?.click();
    globalThis.__klaE2ETraceCountBeforePromptRestore = globalThis.__klaE2EAnalysisTraces.length;
    document.querySelector('[data-testid="run-analysis"]')?.click();
    return true;
  })()`);
  await sidePanel.waitFor(
    `Boolean(document.querySelector('[data-testid="config-dialog"]')) &&
      globalThis.__klaE2EAnalysisTraces.length === globalThis.__klaE2ETraceCountBeforePromptRestore`,
    '取消保留配置后开始分析重新弹窗且不提前请求',
  );
  await sidePanel.evaluate(
    `document.querySelector('[data-testid="config-dialog"] button.icon')?.click()`,
  );

  await sidePanel.evaluate(`(() => {
    const button = document.querySelector('[data-testid="reset-analyzer"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('未找到重置分析台按钮');
    button.click();
    return true;
  })()`);
  await sidePanel.waitFor(
    `(() => {
      return document.querySelector('[data-testid="analysis-empty"]') &&
        !document.querySelector('[data-testid="config-dialog"]') &&
        !document.querySelector('.market-chart') &&
        !document.querySelector('.signal') &&
        !document.querySelector('[data-testid="selection-summary"]');
    })()`,
    '重置分析台',
  );
  await sidePanel.screenshot(resultPath('reset'));
  console.log(`${profile.label} real Side Panel E2E passed: ${profile.url}`);
} catch (error) {
  if (sidePanel) await sidePanel.screenshot(resultPath('e2e-failure')).catch(() => undefined);
  throw error;
} finally {
  await context?.close().catch(() => undefined);
  await rm(profilePath, { recursive: true, force: true });
}
