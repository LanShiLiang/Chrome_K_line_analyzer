import type { SelectionImageEvidence, SelectionRange } from '../core/model/types';
import { detectCandleColors } from '../core/selection/image';
import { message, type LocalizedMessage } from '../shared/i18n-types';

const MAX_ANALYSIS_WIDTH = 1800;
const MAX_ANALYSIS_HEIGHT = 1200;
const MAX_ANALYSIS_PIXELS = 2_000_000;

export class SelectionCaptureError extends Error {
  constructor(
    readonly userMessage: LocalizedMessage,
    readonly guidance: LocalizedMessage[],
    options?: ErrorOptions,
  ) {
    super(userMessage.key, options);
    this.name = 'SelectionCaptureError';
  }
}

export function fitSelectionAnalysisSize(width: number, height: number) {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const scale = Math.min(
    1,
    MAX_ANALYSIS_WIDTH / safeWidth,
    MAX_ANALYSIS_HEIGHT / safeHeight,
    Math.sqrt(MAX_ANALYSIS_PIXELS / (safeWidth * safeHeight)),
  );
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

const blobToDataUrl = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  const chunkSize = 8192;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    let text = '';
    for (const byte of chunk) text += String.fromCharCode(byte);
    chunks.push(text);
  }
  return `data:${blob.type};base64,${btoa(chunks.join(''))}`;
};

export async function captureSelectionImage(
  tabId: number,
  selection: SelectionRange,
): Promise<SelectionImageEvidence> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId === undefined || !tab.active)
    throw new SelectionCaptureError(message('error_selection_capture_inactive'), [
      message('guidance_selection_keep_tab_active'),
    ]);
  let source: ImageBitmap;
  let viewportCapture = true;
  try {
    const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    source = await createImageBitmap(await (await fetch(screenshot)).blob());
  } catch (error) {
    if (!selection.pageImage?.dataUrl)
      throw new SelectionCaptureError(
        message('error_selection_capture_permission'),
        [message('guidance_selection_keep_tab_active'), message('guidance_selection_retry')],
        { cause: error },
      );
    try {
      source = await createImageBitmap(await (await fetch(selection.pageImage.dataUrl)).blob());
      viewportCapture = false;
    } catch (fallbackError) {
      throw new SelectionCaptureError(
        message('error_selection_capture_permission'),
        [message('guidance_selection_keep_tab_active'), message('guidance_selection_retry')],
        { cause: fallbackError },
      );
    }
  }
  const scaleX = viewportCapture ? source.width / selection.viewport.width : 1;
  const scaleY = viewportCapture ? source.height / selection.viewport.height : 1;
  const sourceX = viewportCapture ? Math.max(0, Math.floor(selection.rect.left * scaleX)) : 0;
  const sourceY = viewportCapture ? Math.max(0, Math.floor(selection.rect.top * scaleY)) : 0;
  const sourceWidth = viewportCapture
    ? Math.max(1, Math.min(source.width - sourceX, Math.ceil(selection.rect.width * scaleX)))
    : source.width;
  const sourceHeight = viewportCapture
    ? Math.max(1, Math.min(source.height - sourceY, Math.ceil(selection.rect.height * scaleY)))
    : source.height;
  const analysisSize = fitSelectionAnalysisSize(sourceWidth, sourceHeight);
  const analysisCanvas = new OffscreenCanvas(analysisSize.width, analysisSize.height);
  const analysisContext = analysisCanvas.getContext('2d', { willReadFrequently: true });
  if (!analysisContext) {
    source.close();
    throw new SelectionCaptureError(message('error_selection_capture_canvas'), [
      message('guidance_selection_smaller_area'),
      message('guidance_selection_retry'),
    ]);
  }
  analysisContext.drawImage(
    source,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    analysisSize.width,
    analysisSize.height,
  );
  source.close();
  let detected: ReturnType<typeof detectCandleColors>;
  try {
    const pixels = analysisContext.getImageData(0, 0, analysisSize.width, analysisSize.height);
    detected = detectCandleColors(pixels);
  } catch (error) {
    throw new SelectionCaptureError(
      message('error_selection_capture_pixels'),
      [message('guidance_selection_smaller_area'), message('guidance_selection_main_chart')],
      { cause: error },
    );
  }

  const previewScale = Math.min(1, 640 / analysisSize.width, 360 / analysisSize.height);
  const previewWidth = Math.max(1, Math.round(analysisSize.width * previewScale));
  const previewHeight = Math.max(1, Math.round(analysisSize.height * previewScale));
  const preview = new OffscreenCanvas(previewWidth, previewHeight);
  const previewContext = preview.getContext('2d');
  if (!previewContext)
    throw new SelectionCaptureError(message('error_selection_capture_preview'), [
      message('guidance_selection_retry'),
    ]);
  previewContext.drawImage(analysisCanvas, 0, 0, previewWidth, previewHeight);
  let dataUrl: string;
  try {
    dataUrl = await blobToDataUrl(await preview.convertToBlob({ type: 'image/png' }));
  } catch (error) {
    throw new SelectionCaptureError(
      message('error_selection_capture_preview'),
      [message('guidance_selection_retry')],
      { cause: error },
    );
  }
  return { ...detected, dataUrl };
}
