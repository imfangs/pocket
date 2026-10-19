import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import ImageViewer from "./ImageViewer";
import { diagramDataPrefix } from "./mermaidPolicy";

type OpenImage = (src: string, alt: string, opener: HTMLElement) => void;
const ImagePreviewContext = createContext<OpenImage>(() => { throw new Error("Image preview requires its conversation provider"); });
const DiagramPreviewContext = createContext<OpenImage>(() => { throw new Error("Diagram preview requires its conversation provider"); });
const imageUrl = /^\/api\/tasks\/([a-f0-9-]{36})\/(?:images\/[a-f0-9]{64}|attachments\/[a-f0-9-]{36})$/i;

// One host survives message reconciliation and a queued image moving into the
// transcript. A different conversation cannot inherit the open private image.
export default function ImagePreviewProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const [image, setImage] = useState<{ scope: string; src: string; alt: string; opener: HTMLElement; diagram?: boolean } | null>(null);
  useEffect(() => { setImage(null); }, [scope]);
  useEffect(() => () => { window.dispatchEvent(new Event("pocket-diagram-scope-change")); }, [scope]);
  const open = useCallback<OpenImage>((src, alt, opener) => {
    const match = imageUrl.exec(src);
    if (match?.[1].toLowerCase() === scope.toLowerCase()) setImage({ scope, src, alt, opener });
  }, [scope]);
  const openDiagram = useCallback<OpenImage>((src, alt, opener) => {
    if (src.startsWith(diagramDataPrefix)) setImage({ scope, src, alt, opener, diagram: true });
  }, [scope]);
  return <ImagePreviewContext.Provider value={open}><DiagramPreviewContext.Provider value={openDiagram}>
    {children}
    {image?.scope === scope && <ImageViewer key={image.src} src={image.src} alt={image.alt} opener={image.opener} diagram={image.diagram} onClose={() => setImage(null)} />}
  </DiagramPreviewContext.Provider></ImagePreviewContext.Provider>;
}

export function useImagePreview() { return useContext(ImagePreviewContext); }
export function useDiagramPreview() { return useContext(DiagramPreviewContext); }
