import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { DocumentProps } from "react-pdf";
import { t, useLocale } from "./i18n";
import { maxPdfPreviewPages, nearbyPdfPages, pdfPreviewPageBatch, pdfRenderPlan, readPdfPreviewBlob } from "./pdfFilePreview";
import "./pdf-file-content.css";

type PdfLibrary = typeof import("react-pdf");
let libraryPromise: Promise<PdfLibrary> | undefined;
const loadLibrary = () => libraryPromise ??= import("react-pdf").then(library => {
  library.pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  return library;
}).catch(error => { libraryPromise = undefined; throw error; });
const loadError = "PDF 暂时无法预览，可下载原文件。";

function scrollingParent(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement;
  while (parent && parent !== document.body) {
    if (/(?:auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
    parent = parent.parentElement;
  }
  return null;
}

function PdfPage({ library, pdf, number, active, width, failed }: {
  library: PdfLibrary; pdf: PDFDocumentProxy; number: number; active: boolean; width: number; failed: () => void;
}) {
  useLocale();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const loadedPage = useRef<PDFPageProxy | null>(null);
  const renderedCanvas = useRef<HTMLCanvasElement | null>(null);
  const releaseCanvas = () => {
    const canvas = renderedCanvas.current;
    if (canvas) { canvas.width = 0; canvas.height = 0; renderedCanvas.current = null; }
  };
  useEffect(() => { if (!active) { releaseCanvas(); loadedPage.current?.cleanup(); } }, [active]);
  useEffect(() => () => { releaseCanvas(); loadedPage.current?.cleanup(); }, []);
  useEffect(() => {
    if (!active || size) return;
    let current = true;
    void pdf.getPage(number).then(page => {
      const viewport = page.getViewport({ scale: 1 });
      pdfRenderPlan(viewport.width, viewport.height, width);
      if (current) { loadedPage.current = page; setSize({ width: viewport.width, height: viewport.height }); }
      else page.cleanup();
    }).catch(() => { if (current) failed(); });
    return () => { current = false; };
  }, [active, pdf, number, size, width, failed]);
  const plan = size ? pdfRenderPlan(size.width, size.height, width, typeof window === "undefined" ? 1 : window.devicePixelRatio) : null;
  const Page = library.Page;
  return <section className="pdf-file-page-slot" data-pdf-page={number} aria-label={t("第{{page}}页", { page: number })}
    style={{ aspectRatio: size ? `${size.width} / ${size.height}` : "1 / 1.4142" }}>
    {active && plan ? <Page pageNumber={number} width={plan.width} devicePixelRatio={plan.density} suspense={false}
      canvasRef={canvas => { if (canvas) renderedCanvas.current = canvas; }}
      renderTextLayer={false} renderAnnotationLayer={false} renderForms={false}
      onLoadError={() => failed()} onRenderError={() => failed()}
      loading={<span className="pdf-file-page-loading" role="status">{t("正在加载页面…")}</span>}
      error={<span role="alert">{t(loadError)}</span>} />
      : active ? <span className="pdf-file-page-loading" role="status">{t("正在加载页面…")}</span> : null}
    <span className="pdf-file-page-number" aria-hidden="true">{number}</span>
  </section>;
}

export default function PdfFileContent({ blob, onError }: { blob: Blob; onError?: (error: Error) => void }) {
  useLocale();
  const container = useRef<HTMLDivElement>(null), pages = useRef<HTMLDivElement>(null), errorCallback = useRef(onError);
  errorCallback.current = onError;
  const [source, setSource] = useState<{ data: Uint8Array } | null>(null), [library, setLibrary] = useState<PdfLibrary | null>(null);
  const [options, setOptions] = useState<DocumentProps["options"]>(), [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [failure, setFailure] = useState(""), [shown, setShown] = useState(pdfPreviewPageBatch);
  const [width, setWidth] = useState(320), [active, setActive] = useState([0]);
  const report = useRef((message = loadError) => {
    setFailure(message);
    errorCallback.current?.(new Error(message));
  });
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setFailure(""); setSource(null); setPdf(null); setShown(pdfPreviewPageBatch); setActive([0]);
    void readPdfPreviewBlob(blob, controller.signal).then(async file => ({ file, library: await loadLibrary() }))
      .then(value => {
        controller.signal.throwIfAborted();
        if (!current) return;
        const base = new URL(import.meta.env.BASE_URL, window.location.href);
        const safeOptions: NonNullable<DocumentProps["options"]> & { isEvalSupported: false } = {
          cMapUrl: new URL("assets/pdfjs/cmaps/", base).href, cMapPacked: true,
          standardFontDataUrl: new URL("assets/pdfjs/standard_fonts/", base).href,
          wasmUrl: new URL("assets/pdfjs/wasm/", base).href,
          isEvalSupported: false, useWasm: false, enableXfa: false, useSystemFonts: true,
          maxImageSize: 16 * 1024 * 1024, canvasMaxAreaInBytes: 16 * 1024 * 1024,
          disableAutoFetch: true, disableStream: true, disableRange: true };
        // PDF.js 6 removed its eval path; the explicit false also protects older compatible engines.
        setOptions(safeOptions);
        setLibrary(value.library); setSource(value.file);
      }).catch(error => {
        if (current && !controller.signal.aborted) report.current(error instanceof Error && /[\u3400-\u9fff]/.test(error.message) ? error.message : loadError);
      });
    return () => { current = false; controller.abort(); };
  }, [blob]);
  const count = Math.min(pdf?.numPages ?? 0, shown, maxPdfPreviewPages);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const scroll = scrollingParent(element);
    let frame = 0;
    const measure = () => {
      frame = 0;
      const measuredWidth = Math.floor(element.getBoundingClientRect().width);
      if (measuredWidth > 0) setWidth(previous => previous === measuredWidth ? previous : measuredWidth);
      const viewport = scroll?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      const nodes = Array.from(pages.current?.children ?? []);
      const next = nearbyPdfPages(nodes.map(node => node.getBoundingClientRect()), viewport);
      if (next.length) setActive(previous => previous.join(",") === next.join(",") ? previous : next);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(measure); };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(element); if (pages.current) observer?.observe(pages.current);
    (scroll ?? window).addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule); schedule();
    return () => {
      window.cancelAnimationFrame(frame); observer?.disconnect();
      (scroll ?? window).removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule);
    };
  }, [count, pdf]);
  const Document = library?.Document;
  return <div ref={container} className="pdf-file-content ph-no-capture ph-mask">
    {failure ? <p role="alert" className="text-file-state">{t(failure)}</p>
      : source && Document ? <Document file={source} options={options} suspense={false}
        onLoadSuccess={value => setPdf(value)} onLoadError={() => report.current()} onSourceError={() => report.current()}
        onPassword={() => report.current("加密 PDF 暂不支持预览，请下载后查看。")}
        loading={<p className="text-file-state" role="status">{t("正在读取 PDF…")}</p>}
        error={<p className="text-file-state" role="alert">{t(loadError)}</p>}>
        {pdf && <>
          <p className="pdf-file-summary">{t("共{{count}}页", { count: pdf.numPages })}</p>
          <div ref={pages} className="pdf-file-pages">{Array.from({ length: count }, (_, index) =>
            <PdfPage key={index} library={library} pdf={pdf} number={index + 1} width={width} active={active.includes(index)} failed={report.current} />)}</div>
          {count < Math.min(pdf.numPages, maxPdfPreviewPages) && <button type="button" className="pdf-file-more"
            onClick={() => setShown(value => Math.min(value + pdfPreviewPageBatch, maxPdfPreviewPages))}>{t("显示更多页面")}</button>}
          {pdf.numPages > maxPdfPreviewPages && <p className="pdf-file-limit">{t("最多预览{{count}}页，其余可下载原文件查看。", { count: maxPdfPreviewPages })}</p>}
        </>}
      </Document> : <p className="text-file-state" role="status">{t("正在读取 PDF…")}</p>}
  </div>;
}
