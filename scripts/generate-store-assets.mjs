import { access, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const mode = process.argv[2] ?? 'store';
if (!['icons', 'store'].includes(mode))
  throw new Error(`Unknown asset mode: ${mode}. Expected icons or store.`);
const iconSource = resolve(root, 'assets', 'icons', 'icon.svg');
const iconDirectory = resolve(root, 'assets', 'icons');
const storeDirectory = resolve(root, 'store-assets');
const marketScreenshot = resolve(root, 'test-results', 'binance-spot-market-page.png');
const analysisScreenshot = resolve(root, 'test-results', 'binance-spot-200-candles.png');
const settingsScreenshot = resolve(root, 'test-results', 'binance-spot-64-candles.png');

const existingPath = async (...paths) => {
  for (const path of paths) {
    if (!path) continue;
    try {
      await access(path);
      return path;
    } catch {
      // Try the next browser path.
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

const asDataUrl = async (path, mimeType) =>
  `data:${mimeType};base64,${(await readFile(path)).toString('base64')}`;

await access(iconSource);
await Promise.all([
  mkdir(iconDirectory, { recursive: true }),
  mkdir(storeDirectory, { recursive: true }),
]);

const icon = await asDataUrl(iconSource, 'image/svg+xml');

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage();

const capture = async (width, height, output, body, omitBackground = false) => {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif; }
  </style></head><body>${body}</body></html>`);
  await page.evaluate(async () => document.fonts.ready);
  await page.screenshot({ path: output, type: 'png', omitBackground });
};

try {
  for (const size of [16, 32, 48, 128]) {
    await capture(
      size,
      size,
      resolve(iconDirectory, `icon${size}.png`),
      `<img src="${icon}" width="${size}" height="${size}" alt="" />`,
      true,
    );
  }

  if (mode === 'icons') {
    console.log(`Generated extension icons in ${iconDirectory}`);
  } else {
    await Promise.all([
      access(marketScreenshot),
      access(analysisScreenshot),
      access(settingsScreenshot),
    ]);
    const [market, analysis, settings] = await Promise.all([
      asDataUrl(marketScreenshot, 'image/png'),
      asDataUrl(analysisScreenshot, 'image/png'),
      asDataUrl(settingsScreenshot, 'image/png'),
    ]);

    const promoCandles = `<svg viewBox="0 0 440 280" width="440" height="280" aria-hidden="true">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0b171d"/><stop offset="1" stop-color="#152c33"/></linearGradient></defs>
    <rect width="440" height="280" fill="url(#bg)"/>
    <g opacity=".28" stroke="#4c6872"><path d="M0 56h440M0 112h440M0 168h440M0 224h440M88 0v280M176 0v280M264 0v280M352 0v280"/></g>
    <g opacity=".75" stroke-width="5"><path d="M64 183v-70" stroke="#17b890"/><rect x="54" y="128" width="20" height="38" rx="3" fill="#17b890"/><path d="M365 165V91" stroke="#ef6461"/><rect x="355" y="111" width="20" height="34" rx="3" fill="#ef6461"/></g>
    <path d="M34 215 112 174l54 18 76-99 56 38 108-82" fill="none" stroke="#ffc857" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>
  </svg>`;
    await capture(
      440,
      280,
      resolve(storeDirectory, 'promo-small-440x280.png'),
      `${promoCandles}<img src="${icon}" alt="" style="position:absolute;width:144px;height:144px;left:148px;top:68px;filter:drop-shadow(0 18px 24px #0008)" />`,
    );

    const storeScreenshot = (panel, title, subtitle, position) => `
    <div style="position:absolute;inset:0;background:#071014">
      <img src="${market}" alt="" style="width:100%;height:100%;object-fit:cover;filter:saturate(.72) brightness(.52)" />
      <div style="position:absolute;inset:0;background:linear-gradient(90deg,#071014ee 0%,#071014b8 48%,#07101444 100%)"></div>
    </div>
    <div style="position:absolute;left:54px;top:52px;display:flex;align-items:center;gap:14px;color:#dffdf8;font-size:20px;font-weight:700;letter-spacing:.08em">
      <img src="${icon}" alt="" style="width:54px;height:54px" /> K LINE ANALYZER
    </div>
    <div style="position:absolute;left:58px;top:238px;width:610px;color:white">
      <h1 style="font-size:48px;line-height:1.16;margin:0 0 20px;letter-spacing:-.03em">${title}</h1>
      <p style="font-size:22px;line-height:1.55;margin:0;color:#b8c8ce">${subtitle}</p>
      <div style="display:flex;gap:10px;margin-top:30px;color:#d8e3e7;font-size:15px">
        <span style="border:1px solid #3a5a63;background:#0f2229cc;padding:9px 14px">Volume Price Analysis</span>
        <span style="border:1px solid #3a5a63;background:#0f2229cc;padding:9px 14px">Wyckoff</span>
        <span style="border:1px solid #3a5a63;background:#0f2229cc;padding:9px 14px">Local Processing</span>
      </div>
    </div>
    <div style="position:absolute;right:34px;top:26px;width:430px;height:748px;background:#101820;border:1px solid #46616b;box-shadow:0 28px 70px #000b;overflow:hidden">
      <img src="${panel}" alt="" style="width:100%;height:100%;object-fit:cover;object-position:${position}" />
    </div>`;

    await capture(
      1280,
      800,
      resolve(storeDirectory, 'screenshot-1-analysis-1280x800.png'),
      storeScreenshot(
        analysis,
        '在行情页旁完成本地量价分析',
        '用同一批 K 线展示策略结论、分析依据、关键价位与成交量图表。',
        'top',
      ),
    );
    await capture(
      1280,
      800,
      resolve(storeDirectory, 'screenshot-2-settings-1280x800.png'),
      storeScreenshot(
        settings,
        '参数调整后即时重新分析',
        '支持日、周、月周期与 20–1000 根 K 线；设置保存在 Chrome Storage。',
        'bottom',
      ),
    );
    console.log(`Generated Chrome Web Store assets in ${storeDirectory}`);
  }
} finally {
  await browser.close();
}
