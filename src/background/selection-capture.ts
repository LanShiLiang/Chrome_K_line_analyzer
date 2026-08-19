import type { SelectionImageEvidence, SelectionRange } from '../core/model/types';
import { detectCandleColors } from '../core/selection/image';

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
  if (tab.windowId === undefined || !tab.active) throw new Error('Selection tab is not active');
  const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const source = await createImageBitmap(await (await fetch(screenshot)).blob());
  const scaleX = source.width / selection.viewport.width;
  const scaleY = source.height / selection.viewport.height;
  const sourceX = Math.max(0, Math.floor(selection.rect.left * scaleX));
  const sourceY = Math.max(0, Math.floor(selection.rect.top * scaleY));
  const sourceWidth = Math.max(
    1,
    Math.min(source.width - sourceX, Math.ceil(selection.rect.width * scaleX)),
  );
  const sourceHeight = Math.max(
    1,
    Math.min(source.height - sourceY, Math.ceil(selection.rect.height * scaleY)),
  );
  const analysisCanvas = new OffscreenCanvas(sourceWidth, sourceHeight);
  const analysisContext = analysisCanvas.getContext('2d', { willReadFrequently: true });
  if (!analysisContext) throw new Error('Unable to create selection image context');
  analysisContext.drawImage(
    source,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );
  source.close();
  const pixels = analysisContext.getImageData(0, 0, sourceWidth, sourceHeight);
  const detected = detectCandleColors(pixels);

  const previewScale = Math.min(1, 640 / sourceWidth, 360 / sourceHeight);
  const previewWidth = Math.max(1, Math.round(sourceWidth * previewScale));
  const previewHeight = Math.max(1, Math.round(sourceHeight * previewScale));
  const preview = new OffscreenCanvas(previewWidth, previewHeight);
  const previewContext = preview.getContext('2d');
  if (!previewContext) throw new Error('Unable to create selection preview context');
  previewContext.drawImage(analysisCanvas, 0, 0, previewWidth, previewHeight);
  const dataUrl = await blobToDataUrl(await preview.convertToBlob({ type: 'image/png' }));
  return { ...detected, dataUrl };
}
