import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefCallback } from "react";
import ImageViewer from "./ImageViewer";
import { diagramDataPrefix } from "./mermaidPolicy";
import { createImagePreviewRegistry, imagePreviewGallery, isImagePreviewForScope, type ImagePreviewItem } from "./imagePreviewGallery";

export type { ImagePreviewItem } from "./imagePreviewGallery";

type OpenImage = (src: string, alt: string, opener: HTMLElement, gallery?: readonly ImagePreviewItem[]) => void;
const ImagePreviewContext = createContext<OpenImage>(() => { throw new Error("Image preview requires its conversation provider"); });
const DiagramPreviewContext = createContext<OpenImage>(() => { throw new Error("Diagram preview requires its conversation provider"); });
const ImagePreviewGroupContext = createContext<ReturnType<typeof createImagePreviewRegistry> | null>(null);

// A group owns exactly one message. Attachments outside a message can reuse
// this boundary without adding a layout wrapper or joining adjacent cards.
export function ImagePreviewGroup({ children, fallback = false }: { children: ReactNode; fallback?: boolean }) {
  const parent = useContext(ImagePreviewGroupContext);
  const own = useRef<ReturnType<typeof createImagePreviewRegistry> | null>(null);
  if (!own.current && !(fallback && parent)) own.current = createImagePreviewRegistry();
  return <ImagePreviewGroupContext.Provider value={fallback && parent ? parent : own.current}>{children}</ImagePreviewGroupContext.Provider>;
}

export function useImagePreviewRegistration(src: string, alt: string): RefCallback<HTMLElement> {
  const group = useContext(ImagePreviewGroupContext);
  // React 19 invokes this returned cleanup on replacement, unmount and the
  // StrictMode ref replay, so stale callbacks cannot remove a new registration.
  return useCallback(element => element && group ? group.register(element, { src, alt }) : undefined, [group, src, alt]);
}

// One host survives message reconciliation and a queued image moving into the
// transcript. A different conversation cannot inherit the open private image.
export default function ImagePreviewProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const [image, setImage] = useState<{ scope: string; src: string; alt: string; opener: HTMLElement; diagram?: boolean; gallery?: readonly ImagePreviewItem[] } | null>(null);
  useEffect(() => { setImage(null); }, [scope]);
  useEffect(() => () => { window.dispatchEvent(new Event("pocket-diagram-scope-change")); }, [scope]);
  const open = useCallback<OpenImage>((src, alt, opener, candidates) => {
    if (!isImagePreviewForScope(src, scope)) return;
    const gallery = candidates && imagePreviewGallery(scope, candidates, { src, alt });
    setImage({ scope, src, alt, opener, gallery: gallery && gallery.length > 1 ? gallery : undefined });
  }, [scope]);
  const openDiagram = useCallback<OpenImage>((src, alt, opener) => {
    if (src.startsWith(diagramDataPrefix)) setImage({ scope, src, alt, opener, diagram: true });
  }, [scope]);
  return <ImagePreviewContext.Provider value={open}><DiagramPreviewContext.Provider value={openDiagram}>
    {children}
    {image?.scope === scope && <ImageViewer key={image.src} src={image.src} alt={image.alt} opener={image.opener} diagram={image.diagram} gallery={image.gallery} onClose={() => setImage(null)} />}
  </DiagramPreviewContext.Provider></ImagePreviewContext.Provider>;
}

export function useImagePreview() {
  const open = useContext(ImagePreviewContext), group = useContext(ImagePreviewGroupContext);
  return useCallback((src: string, alt: string, opener: HTMLElement) => {
    // Server rendering never inspects a document or creates a gallery from
    // unmounted markup. Only mounted image components supply a client manifest.
    open(src, alt, opener, typeof document !== "undefined" ? group?.snapshot(opener) : undefined);
  }, [open, group]);
}
export function useDiagramPreview() { return useContext(DiagramPreviewContext); }
