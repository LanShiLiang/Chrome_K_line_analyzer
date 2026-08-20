import type {
  Candle,
  MarketData,
  SelectionImageEvidence,
  SelectionInterpretation,
  SelectionRange,
} from '../model/types';
import type { MarketSite } from '../adapter/sites';
import { MIN_SELECTION_DATE_EVIDENCE } from '../model/types';

type PixelSource = { width: number; height: number; data: Uint8ClampedArray };
type CandleColor = SelectionImageEvidence['candleColors'][number];
type ColorGroup = { start: number; end: number; color: CandleColor };
const MIN_DATE_MATCH_MARGIN = 0.08;

const classifyColor = (red: number, green: number, blue: number): CandleColor => {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  if (max < 70 || max - min < 42) return 'unknown';
  if (green > red * 1.12 && green > blue * 1.08) return 'green';
  // Binance 的跌线偏纯红，而紫/粉色均线常见 red 与 blue 接近；拉开红蓝比可
  // 保留细小蜡烛，同时避免均线在 X 轴上把相邻蜡烛连成一整段。
  if (red > green * 1.12 && red > blue * 1.25) return 'red';
  return 'unknown';
};

// 从截图中寻找红/绿蜡烛（含成交量柱）的纵向颜色簇。先排除横跨图表的价格线，
// 再按 X 轴聚类，因此不依赖某个站点的 DOM 或固定蜡烛宽度。
export function detectCandleColors(source: PixelSource): Omit<SelectionImageEvidence, 'dataUrl'> {
  const { width, height, data } = source;
  if (width < 1 || height < 1 || data.length < width * height * 4)
    return { width, height, candleColors: [], detectedCandles: 0, confidence: 0 };
  const rowColored = new Uint32Array(height);
  const colors = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = (y * width + x) * 4;
      if (data[pixel + 3] < 100) continue;
      const color = classifyColor(data[pixel], data[pixel + 1], data[pixel + 2]);
      if (color === 'unknown') continue;
      colors[y * width + x] = color === 'green' ? 1 : 2;
      rowColored[y] += 1;
    }
  }
  const greenVertical = new Uint32Array(width);
  const redVertical = new Uint32Array(width);
  for (let x = 0; x < width; x += 1) {
    let greenRun = 0;
    let redRun = 0;
    for (let y = 0; y < height; y += 1) {
      if (rowColored[y] > width * 0.32) {
        greenRun = 0;
        redRun = 0;
        continue;
      }
      const color = colors[y * width + x];
      greenRun = color === 1 ? greenRun + 1 : 0;
      redRun = color === 2 ? redRun + 1 : 0;
      greenVertical[x] = Math.max(greenVertical[x], greenRun);
      redVertical[x] = Math.max(redVertical[x], redRun);
    }
  }
  // 均线和成交量均线虽然横跨所有 X 列，但在单个 X 列上通常只有 1–3 像素厚；
  // K 线实体、影线和量柱则形成明显的纵向连续段。用纵向跨度做门槛，避免一条
  // 斜线把整个选区合并成“1 根 K 线”。
  const minVerticalSpan = Math.max(4, Math.floor(height * 0.006));
  const active = Array.from(
    { length: width },
    (_, x) => Math.max(greenVertical[x], redVertical[x]) >= minVerticalSpan,
  );
  const groups: Array<{ start: number; end: number }> = [];
  let start = -1;
  let last = -1;
  for (let x = 0; x < width; x += 1) {
    if (!active[x]) continue;
    if (start < 0) start = x;
    else if (x - last > 1) {
      groups.push({ start, end: last });
      start = x;
    }
    last = x;
  }
  if (start >= 0) groups.push({ start, end: last });

  const colorGroups: ColorGroup[] = groups
    .filter((group) => group.end - group.start + 1 <= Math.max(24, width * 0.08))
    .map((group): ColorGroup => {
      let greenCount = 0;
      let redCount = 0;
      for (let x = group.start; x <= group.end; x += 1) {
        greenCount += greenVertical[x];
        redCount += redVertical[x];
      }
      const total = greenCount + redCount;
      const color =
        total < minVerticalSpan || Math.max(greenCount, redCount) / total < 0.58
          ? 'unknown'
          : greenCount > redCount
            ? 'green'
            : 'red';
      return { ...group, color };
    });
  const knownGroups = colorGroups.filter((group) => group.color !== 'unknown');
  const centers = knownGroups.map((group) => (group.start + group.end) / 2);
  const positiveGaps = centers
    .slice(1)
    .map((center, index) => center - centers[index])
    .filter((gap) => gap >= 2)
    .sort((left, right) => left - right);
  // 相邻实体偶尔会被均线连在一起或因十字星而漏掉。用较小的典型中心间距重建
  // 等间隔槽位，漏检处保留 unknown，避免后续所有蜡烛发生整体错位。
  const candleSpacing = positiveGaps.length
    ? positiveGaps[Math.min(positiveGaps.length - 1, Math.floor(positiveGaps.length * 0.35))]
    : undefined;
  const slotCount = Math.min(
    1000,
    candleSpacing && centers.length > 1
      ? Math.min(
          Math.max(centers.length, Math.round((centers.at(-1)! - centers[0]) / candleSpacing) + 1),
          centers.length * 4,
        )
      : centers.length,
  );
  const candleColors: CandleColor[] = Array.from({ length: slotCount }, () => 'unknown');
  const candleCenters: number[] = Array.from(
    { length: slotCount },
    (_, index) => (centers[0] ?? 0) + index * (candleSpacing ?? 0),
  );
  knownGroups.forEach((group) => {
    const center = (group.start + group.end) / 2;
    const slot = candleSpacing ? Math.round((center - centers[0]) / candleSpacing) : 0;
    if (slot >= 0 && slot < candleColors.length) candleColors[slot] = group.color;
  });
  const known = candleColors.filter((color) => color !== 'unknown').length;
  const confidence = Math.round(
    Math.min(100, (known / Math.max(1, candleColors.length)) * 70 + Math.min(30, known * 2)),
  );
  return {
    width,
    height,
    candleColors,
    candleCenters,
    ...(candleSpacing ? { candleSpacing } : {}),
    detectedCandles: candleColors.length,
    confidence,
  };
}

const marketDirection = (candle: Candle) =>
  candle.close > candle.open ? 'up' : candle.close < candle.open ? 'down' : 'flat';

const observedDirection = (color: CandleColor, site: MarketSite) => {
  if (color === 'unknown') return 'unknown';
  const redMeansUp = site === 'tonghuashun';
  if (color === 'red') return redMeansUp ? 'up' : 'down';
  return redMeansUp ? 'down' : 'up';
};

export function matchCandleSequence(
  colors: CandleColor[],
  candles: Candle[],
  site: MarketSite,
): { startIndex: number; endIndex: number; confidence: number } | undefined {
  const observed = colors.map((color) => observedDirection(color, site));
  const known = observed.filter((direction) => direction !== 'unknown').length;
  if (known < MIN_SELECTION_DATE_EVIDENCE || candles.length < observed.length) return undefined;
  let best = { startIndex: -1, score: -1 };
  let secondScore = -1;
  for (let startIndex = 0; startIndex <= candles.length - observed.length; startIndex += 1) {
    let matches = 0;
    let comparable = 0;
    for (let offset = 0; offset < observed.length; offset += 1) {
      const expected = observed[offset];
      if (expected === 'unknown') continue;
      const actual = marketDirection(candles[startIndex + offset]);
      if (actual === 'flat') continue;
      comparable += 1;
      if (actual === expected) matches += 1;
    }
    if (comparable < MIN_SELECTION_DATE_EVIDENCE) continue;
    const score = matches / comparable;
    if (score > best.score) {
      secondScore = best.score;
      best = { startIndex, score };
    } else if (score > secondScore) secondScore = score;
  }
  const margin = Math.max(0, best.score - Math.max(0, secondScore));
  const confidence = Math.round(
    100 * Math.min(1, best.score * 0.75 + margin * 0.8 + Math.min(0.15, known / 200)),
  );
  if (best.startIndex < 0 || best.score < 0.72 || margin < MIN_DATE_MATCH_MARGIN || confidence < 65)
    return undefined;
  return {
    startIndex: best.startIndex,
    endIndex: best.startIndex + observed.length - 1,
    confidence,
  };
}

export function interpretSelectionRange(
  selection: SelectionRange,
  data: MarketData,
  site: MarketSite,
  allowGeometry: boolean,
): SelectionInterpretation | undefined {
  void allowGeometry; // 保留调用签名；没有可视时间锚点时不再启用几何日期猜测。
  const period = data.period as SelectionInterpretation['period'] | undefined;
  if (!period || data.candles.length === 0) return undefined;
  const match = selection.image
    ? matchCandleSequence(selection.image.candleColors, data.candles, site)
    : undefined;
  if (match) {
    return {
      period,
      startTime: data.candles[match.startIndex].timestamp,
      endTime: data.candles[match.endIndex].timestamp,
      candleCount: match.endIndex - match.startIndex + 1,
      confidence: Math.round((match.confidence + selection.image!.confidence) / 2),
      method: 'image-sequence',
    };
  }
  // 未取得图表可视区的明确起止时间锚点时，不把像素比例映射到整批行情。
  // 历史平移、右侧留白或缓存长度变化都会让这种猜测静默落到错误日期。
  return undefined;
}
