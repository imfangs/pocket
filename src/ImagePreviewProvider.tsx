import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import ImageViewer from "./ImageViewer";

type OpenImage = (src: string, alt: string, opener: HTMLElement) => void;
const ImagePreviewContext = createContext<OpenImage>(() => { throw new Error("Image preview requires its conversation provider"); });
const imageUrl = /^\/api\/tasks\/([a-f0-9-]{36})\/(?:images\/[a-f0-9]{64}|attachments\/[a-f0-9-]{36})$/i;

// One host survives message reconciliation and a queued image moving into the
// transcript. A different conversation cannot inherit the open private image.
export default function ImagePreviewProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const [image, setImage] = useState<{ scope: string; src: string; alt: string; opener: HTMLElement } | null>(null);
  useEffect(() => { setImage(null); }, [scope]);
  const open = useCallback<OpenImage>((src, alt, opener) => {
    const match = imageUrl.exec(src);
    if (match?.[1].toLowerCase() === scope.toLowerCase()) setImage({ scope, src, alt, opener });
  }, [scope]);
  return <ImagePreviewContext.Provider value={open}>
    {children}
    {image?.scope === scope && <ImageViewer key={image.src} src={image.src} alt={image.alt} opener={image.opener} onClose={() => setImage(null)} />}
  </ImagePreviewContext.Provider>;
}

export function useImagePreview() { return useContext(ImagePreviewContext); }
