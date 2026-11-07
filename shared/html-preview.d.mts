export const htmlPreviewPolicy: string;
/** Parsed relative img[src] candidates; the server owns file authorization. */
export function referencedHtmlImages(html: string): string[];
/** Static, isolated HTML. Only validated raster data URIs are embedded. */
export function renderHtmlPreview(html: string, images?: Record<string, string>): string;
/** Authored scripts and controls for the separate opaque HTTP runtime. */
export function renderInteractiveHtmlPreview(html: string, images?: Record<string, string>): string;
