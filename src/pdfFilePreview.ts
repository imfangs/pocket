export const maxPdfPreviewBytes = 20 * 1024 * 1024;
export const maxPdfPreviewPages = 200;
export const pdfPreviewPageBatch = 50;
export const maxMountedPdfPages = 5;
export const maxPdfCanvasPixels = 4 * 1024 * 1024;
const maxCanvasDimension = 4096;

export async function readPdfPreviewBlob(blob: Blob, signal?: AbortSignal): Promise<{ data: Uint8Array }> {
  signal?.throwIfAborted();
  if (blob.size > maxPdfPreviewBytes) throw new Error("PDF 较大，请下载后查看。");
  const data = new Uint8Array(await blob.arrayBuffer());
  signal?.throwIfAborted();
  if (!/^%PDF-\d\.\d/.test(new TextDecoder("ascii").decode(data.subarray(0, 8))))
    throw new Error("此文件不是有效的 PDF，请下载后查看。");
  return { data };
}

export function pdfRenderPlan(pageWidth: number, pageHeight: number, containerWidth: number, pixelRatio = 1) {
  if (![pageWidth, pageHeight].every(value => Number.isFinite(value) && value > 0 && value <= 14400) ||
      pageHeight / pageWidth > 40 || pageWidth / pageHeight > 40)
    throw new Error("此 PDF 页面尺寸暂不支持预览，请下载后查看。");
  const ratio = pageHeight / pageWidth;
  const width = Math.max(1, Math.floor(Math.min(Math.max(1, containerWidth), 1080, maxCanvasDimension / ratio)));
  const height = width * ratio;
  const density = Math.min(Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1, 2,
    maxCanvasDimension / width, maxCanvasDimension / height, Math.sqrt(maxPdfCanvasPixels / (width * height)));
  return { width, height, density };
}

export function nearbyPdfPages(pages: ReadonlyArray<{ top: number; bottom: number }>, viewport: { top: number; bottom: number }) {
  const middle = (viewport.top + viewport.bottom) / 2;
  return pages.map((page, index) => ({ top: page.top, bottom: page.bottom, index }))
    .filter(page => page.bottom >= viewport.top - 750 && page.top <= viewport.bottom + 750)
    .sort((left, right) => Math.abs((left.top + left.bottom) / 2 - middle) - Math.abs((right.top + right.bottom) / 2 - middle))
    .slice(0, maxMountedPdfPages).map(page => page.index).sort((left, right) => left - right);
}
