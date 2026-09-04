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
    // 原生 Side Panel 的默认截图裁剪框可能沿用调整宽度前的值，显式使用当前视口。
    const clip = await evaluate(`({
      x: 0, y: 0, width: innerWidth,
      height: document.querySelector('[data-testid="config-dialog"]')
        ? innerHeight
        : Math.max(innerHeight, document.documentElement.scrollHeight),
      scale: 1
    })`);
    const image = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip,
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
  // Test the shipped permission boundary, not a test-only dynamic injection.
  const runtimePermissions = await serviceWorker.evaluate(
    () => chrome.runtime.getManifest().permissions,
  );
  if (JSON.stringify(runtimePermissions) !== JSON.stringify(['storage', 'activeTab', 'sidePanel']))
    throw new Error(`${profile.label} 生产扩展包含未审核的权限`);

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
    const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message) => {
      const response = await sendMessage(message);
      if (message?.type === 'RUN_ANALYSIS')
        globalThis.__klaE2EAnalysisTraces.push({ message, response });
      if (message?.type === 'CANCEL_ANALYSIS' || message?.type === 'RESET_ANALYSIS')
        globalThis.__klaE2EControlTraces.push({ message, response });
      return response;
    };
    return true;
  })()`);

  // 暂停入口的生产回归：页面不能建遮罩，后台不接受旧选区，UI 忽略迟到广播。
  await sidePanel.waitFor(
    `!document.querySelector('[data-testid="select-candles"]') &&
      document.querySelector('[data-testid="analysis-config-summary"]')?.textContent.includes('200')`,
    '隐藏框选并展示当前分析参数',
  );
  const selectionGate = await serviceWorker.evaluate(async (tabId) => {
    const message = { type: 'START_SELECTION', source: 'drawer', tabId };
    return chrome.tabs.sendMessage(tabId, message);
  }, marketTabId);
  if (selectionGate?.error?.code !== 'E_SELECTION_DISABLED')
    throw new Error('Content Script 仍接受框选入口');
  if (await marketPage.locator('[data-kla-selection-overlay]').count())
    throw new Error('禁用框选后仍出现遮罩');
  await sidePanel.evaluate(`(async () => {
    for (const message of [
      { type: 'SELECTION_DONE', payload: {} },
      { type: 'RUN_ANALYSIS', payload: { mode: 'selection' } }
    ]) {
      const response = await chrome.runtime.sendMessage({ ...message, source: 'drawer', tabId: ${marketTabId} });
      if (response?.error?.code !== 'E_SELECTION_DISABLED') throw new Error('后台仍接受旧选区');
    }
    globalThis.__klaE2EAnalysisTraces = [];
  })()`);
  await serviceWorker.evaluate(async (tabId) => {
    await chrome.runtime.sendMessage({
      type: 'SELECTION_UPDATED',
      source: 'background',
      tabId,
      payload: { capturedAt: Date.now(), recognitionStatus: 'ready', image: {} },
    });
  }, marketTabId);
  await delay(250);
  await sidePanel.waitFor(
    `!document.querySelector('[data-testid="selection-summary"]') &&
      !document.querySelector('[data-testid="analysis-loading"]') &&
      globalThis.__klaE2EAnalysisTraces.length === 0`,
    '迟到选区不会自动重跑',
  );
  await sidePanel.screenshot(resultPath('selection-disabled'));

  // 真实键盘事件验证焦点循环、Esc 返回入口、Enter 提交，以及保存失败保留草稿。
  const pressKey = async (key, windowsVirtualKeyCode, modifiers = 0) => {
    await sidePanel.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      windowsVirtualKeyCode,
      modifiers,
      ...(key === 'Enter' ? { text: '\r' } : {}),
    });
    await sidePanel.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      windowsVirtualKeyCode,
      modifiers,
    });
  };
  const openSettings = async () => {
    await sidePanel.evaluate(`(() => {
      const button = document.querySelector('[data-testid="open-config"]');
      button.focus(); button.click();
    })()`);
    await sidePanel.waitFor(
      `document.querySelector('[data-testid="config-dialog"]')?.contains(document.activeElement) &&
        document.getElementById('root').inert`,
      '设置弹窗接管键盘焦点',
    );
  };
  await openSettings();
  await sidePanel.evaluate(`document.querySelector('[data-testid="confirm-config"]').focus()`);
  await pressKey('Tab', 9);
  await sidePanel.waitFor(
    `document.activeElement === document.querySelector('[data-testid="config-dialog"] button.icon')`,
    'Tab 焦点从末尾回到开头',
  );
  await pressKey('Tab', 9, 8);
  await sidePanel.waitFor(
    `document.activeElement === document.querySelector('[data-testid="confirm-config"]')`,
    'Shift Tab 焦点回到末尾',
  );
  await pressKey('Escape', 27);
  await sidePanel.waitFor(
    `!document.querySelector('[data-testid="config-dialog"]') &&
      !document.getElementById('root').inert &&
      document.activeElement === document.querySelector('[data-testid="open-config"]')`,
    'Esc 关闭后焦点回到设置入口',
  );
  await openSettings();
  await sidePanel.evaluate(`(() => {
    const input = document.querySelector('input[type="number"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '96');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async (...args) => {
      chrome.storage.local.set = originalSet;
      throw new Error('E2E storage failure');
    };
  })()`);
  await pressKey('Enter', 13);
  await sidePanel.waitFor(
    `document.querySelector('[data-testid="config-save-error"]')?.textContent.length > 0 &&
      document.querySelector('input[type="number"]')?.value === '96' &&
      document.querySelector('[data-testid="analysis-config-summary"]')?.textContent.includes('200') &&
      globalThis.__klaE2EAnalysisTraces.length === 0`,
    '保存失败时保留草稿、不改变生效参数、不发起分析',
  );
  await sidePanel.screenshot(resultPath('settings-save-error'));
  await sidePanel.evaluate(`document.querySelector('[data-testid="confirm-config"]').click()`);
  await sidePanel.waitFor(
    `!document.querySelector('[data-testid="config-dialog"]') &&
      document.querySelector('[data-testid="analysis-config-summary"]')?.textContent.includes('96') &&
      globalThis.__klaE2EAnalysisTraces.length === 0`,
    '重试成功后只应用设置，不自动分析',
  );
  await sidePanel.evaluate(`document.querySelector('[data-testid="reset-analyzer"]').click()`);
  await sidePanel.waitFor(
    `document.querySelector('[data-testid="analysis-config-summary"]')?.textContent.includes('200') &&
      !document.querySelector('[data-testid="run-analysis"]').disabled`,
    '恢复默认配置后继续完整分析回归',
  );

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
  await sidePanel.waitFor(
    `!document.querySelector('[data-testid="config-dialog"]')`,
    '保存参数完成',
  );
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
    await sidePanel.waitFor(
      `!document.querySelector('[data-testid="config-dialog"]')`,
      '保存周期完成',
    );
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

  // Selection is disabled in this release; negative coverage runs before analysis.
  await sidePanel.waitFor(
    `!document.querySelector('[data-testid="config-dialog"]')`,
    '保存有效根数完成',
  );

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
    return true;
  })()`);
  await sidePanel.waitFor(
    `!document.querySelector('[data-testid="config-dialog"]')`,
    '取消记住配置完成',
  );
  await sidePanel.evaluate(`document.querySelector('[data-testid="run-analysis"]')?.click()`);
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

  // 保存请求未完成时不重复提交；即使切换标签页，迟到保存也不能触发新标的分析。
  await sidePanel.evaluate(`document.querySelector('[data-testid="run-analysis"]').click()`);
  await sidePanel.waitFor(
    `Boolean(document.querySelector('[data-testid="config-dialog"]'))`,
    '切页前打开分析配置',
  );
  await sidePanel.evaluate(`(() => {
    globalThis.__klaE2ETraceCountBeforeSave = globalThis.__klaE2EAnalysisTraces.length;
    globalThis.__klaE2ESaveCalls = 0;
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async (...args) => {
      globalThis.__klaE2ESaveCalls += 1;
      await new Promise(resolve => { globalThis.__klaE2EReleaseSave = resolve; });
      chrome.storage.local.set = originalSet;
      return originalSet(...args);
    };
    const confirm = document.querySelector('[data-testid="confirm-config"]');
    confirm.click(); confirm.click();
  })()`);
  await sidePanel.waitFor(
    `document.querySelector('[data-testid="config-dialog"]')?.getAttribute('aria-busy') === 'true' &&
      document.querySelector('[data-testid="confirm-config"]').disabled &&
      globalThis.__klaE2ESaveCalls === 1`,
    '保存中提供反馈并阻止重复提交',
  );
  await pressKey('Escape', 27);
  if (
    !(await sidePanel.evaluate(`Boolean(document.querySelector('[data-testid="config-dialog"]'))`))
  )
    throw new Error('保存过程中意外关闭弹窗');
  const otherPage = await context.newPage();
  await otherPage.goto('about:blank');
  await otherPage.bringToFront();
  await sidePanel.waitFor(
    `document.querySelector('[data-testid="market-status"]')?.getAttribute('data-site') === 'unsupported' &&
      !document.querySelector('[data-testid="config-dialog"]') &&
      document.querySelector('[data-testid="run-analysis"]').disabled &&
      !document.querySelector('.market-chart') && !document.getElementById('root').inert`,
    '切换到不支持页面关闭旧弹窗并清理结果',
  );
  await sidePanel.evaluate(`globalThis.__klaE2EReleaseSave()`);
  await delay(250);
  if (
    !(await sidePanel.evaluate(
      `globalThis.__klaE2EAnalysisTraces.length === globalThis.__klaE2ETraceCountBeforeSave`,
    ))
  )
    throw new Error('旧弹窗保存完成后意外触发了新标签页分析');
  await marketPage.bringToFront();
  await otherPage.close();
  await sidePanel.waitFor(
    `document.querySelector('[data-testid="market-status"]')?.getAttribute('data-site') === ${JSON.stringify(profileName)} &&
      !document.querySelector('[data-testid="run-analysis"]').disabled &&
      !document.querySelector('[data-testid="config-dialog"]')`,
    '切回行情页后可正常开始分析',
  );
  await sidePanel.screenshot(resultPath('tab-switch-recovered'));
  console.log(`${profile.label} real Side Panel E2E passed: ${profile.url}`);
} catch (error) {
  if (sidePanel) await sidePanel.screenshot(resultPath('e2e-failure')).catch(() => undefined);
  throw error;
} finally {
  await context?.close().catch(() => undefined);
  await rm(profilePath, { recursive: true, force: true });
}
