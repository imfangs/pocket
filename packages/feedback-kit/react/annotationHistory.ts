import type { History, ImageAnnotation } from "@annotorious/react";

// Annotorious 3.9.5 merges mutations made within its first 250 ms. Its empty
// undo stack otherwise has no last change set to merge into. A real empty
// baseline uses the public initialHistory interface without timing sleeps or
// patching the library; the feedback panel owns its visible undo operation.
export function initialAnnotationHistory(): History<ImageAnnotation> {
  return { changes: [{ created: [], updated: [], deleted: [] }], pointer: 0 };
}
