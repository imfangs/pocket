import { createElement } from "react";
import { createRoot } from "react-dom/client";
import Pdf from "../../src/PdfFileContent";
import Svg from "../../src/SvgFileContent";
import { sanitizeSvgPreview } from "../../src/svgFilePreview";
import { setLanguagePreference } from "../../src/i18n";

const root = createRoot(document.getElementById("root")!);
(window as any).previewHarness = {
  sanitize: (source: string) => sanitizeSvgPreview(source, window), locale: setLanguagePreference,
  showPdf: (bytes: number[]) => root.render(createElement(Pdf, { blob: new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), onError: error => { (window as any).previewError = error.message; } })),
  showSvg: (source: string) => root.render(createElement(Svg, { blob: new Blob([source], { type: "image/svg+xml" }), onError: error => { (window as any).previewError = error.message; } })),
  close: () => root.render(null),
  extractPdf: async (bytes: number[]) => {
    const library = await import("react-pdf");
    const task = library.pdfjs.getDocument({ data: new Uint8Array(bytes), cMapUrl: new URL("/assets/pdfjs/cmaps/", location.href).href, cMapPacked: true, useWasm: false });
    try {
      const document = await task.promise, text: string[] = [];
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number), content = await page.getTextContent();
        if (!(window as any).instrumentedPdfRendering) {
          (window as any).instrumentedPdfRendering = true; (window as any).pendingPdfRenders = 0; (window as any).cancelledPdfRenders = 0;
          const prototype = Object.getPrototypeOf(page), render = prototype.render;
          prototype.render = function(...args: unknown[]) {
            const task = render.apply(this, args), cancel = task.cancel.bind(task);
            let paused = false;
            task.onContinue = (next: () => void) => {
              if ((window as any).holdPdfRendering) { paused = true; (window as any).pendingPdfRenders++; }
              else next();
            };
            task.cancel = (...cancelArgs: unknown[]) => { (window as any).cancelledPdfRenders++; return cancel(...cancelArgs); };
            const settled = () => { if (paused) (window as any).pendingPdfRenders--; };
            void task.promise.then(settled, settled);
            return task;
          };
        }
        text.push(content.items.map(item => "str" in item ? item.str : "").join(" "));
      }
      return text;
    } finally { await task.destroy(); }
  },
};
