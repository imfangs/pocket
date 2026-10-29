import { useEffect, useRef, useState } from "react";
import { Annotorious, ImageAnnotator, ShapeType, UserSelectAction, useAnnotator,
  type AnnotoriousImageAnnotator, type ImageAnnotation, type RectangleGeometry } from "@annotorious/react";
import "@annotorious/react/annotorious-react.css";
import type { FeedbackAnnotation } from "../contracts.ts";
import { initialAnnotationHistory } from "./annotationHistory.ts";

export function annotationGeometry(annotation: ImageAnnotation, width: number, height: number, note = ""): FeedbackAnnotation | null {
  const selector = annotation.target?.selector;
  if (selector?.type !== ShapeType.RECTANGLE) return null;
  const geometry = selector.geometry as RectangleGeometry;
  if (![geometry.x, geometry.y, geometry.w, geometry.h].every(Number.isFinite) || geometry.w <= 0 || geometry.h <= 0) return null;
  const x = Math.max(0, Math.min(1, geometry.x / width)), y = Math.max(0, Math.min(1, geometry.y / height));
  return { id: annotation.id.replace(/^urn:uuid:/, ""), x, y,
    width: Math.min(geometry.w / width, 1 - x), height: Math.min(geometry.h / height, 1 - y), note };
}
export function imageAnnotations(values: FeedbackAnnotation[], width: number, height: number): Partial<ImageAnnotation>[] {
  return values.map(value => {
    const x = value.x * width, y = value.y * height, w = value.width * width, h = value.height * height;
    return { id: value.id, bodies: [], target: { annotation: value.id, selector: { type: ShapeType.RECTANGLE,
      geometry: { x, y, w, h, bounds: { minX: x, minY: y, maxX: x + w, maxY: y + h } } } } };
  });
}
type Props = {
  url: string; width: number; height: number; annotations: FeedbackAnnotation[]; disabled: boolean;
  drawing: boolean; selected: string | null; onChange: (values: FeedbackAnnotation[]) => void;
  onSelect: (id: string | null) => void; onCreated: () => void;
};
function Binding(props: Props) {
  const anno = useAnnotator<AnnotoriousImageAnnotator>();
  const current = useRef(props); current.current = props;
  const writing = useRef(false);
  useEffect(() => {
    if (!anno) return;
    const changed = (item?: ImageAnnotation, created = false) => {
      if (writing.current || current.current.disabled) return;
      const p = current.current;
      const next = anno.getAnnotations().flatMap(annotation => {
        const existing = p.annotations.find(value => value.id === annotation.id);
        const value = annotationGeometry(annotation, p.width, p.height, existing?.note);
        return value && value.width > .000001 && value.height > .000001 ? [value] : [];
      });
      if (next.length > 8) { if (item) anno.removeAnnotation(item.id); p.onCreated(); return; }
      p.onChange(next);
      if (item) p.onSelect(item.id);
      if (created) p.onCreated();
    };
    const create = (item: ImageAnnotation) => changed(item, true);
    const update = (item: ImageAnnotation) => changed(item);
    const remove = () => changed();
    const select = (items: ImageAnnotation[]) => { if (!writing.current && items[0]) current.current.onSelect(items[0].id); };
    anno.on("createAnnotation", create); anno.on("updateAnnotation", update);
    anno.on("deleteAnnotation", remove); anno.on("selectionChanged", select);
    return () => {
      anno.off("createAnnotation", create); anno.off("updateAnnotation", update);
      anno.off("deleteAnnotation", remove); anno.off("selectionChanged", select);
    };
  }, [anno]);
  useEffect(() => {
    if (!anno) return;
    const existing = anno.getAnnotations().flatMap(item => {
      const value = annotationGeometry(item, props.width, props.height);
      return value ? [{ ...value, note: "" }] : [];
    });
    const incoming = props.annotations.map(item => ({ ...item, note: "" }));
    if (JSON.stringify(existing) !== JSON.stringify(incoming)) {
      writing.current = true;
      anno.setAnnotations(imageAnnotations(props.annotations, props.width, props.height));
      writing.current = false;
    }
    anno.setDrawingEnabled(props.drawing && !props.disabled && props.annotations.length < 8);
    anno.setUserSelectAction(props.drawing && !props.disabled ? UserSelectAction.EDIT : UserSelectAction.NONE);
    if (!props.drawing || props.disabled) anno.cancelSelected();
  }, [anno, props.annotations, props.width, props.height, props.drawing, props.disabled]);
  return null;
}

export default function AnnotationEditor(props: Props) {
  const [initialHistory] = useState(initialAnnotationHistory);
  return <div className={`feedback-kit-picture${props.drawing && !props.disabled ? " is-drawing" : ""}`}>
    <div className="feedback-kit-image-stage">
      <Annotorious>
        <ImageAnnotator tool="rectangle" drawingMode="drag" autoSave disableUndoRedoKeys modalSelect={false}
          initialHistory={initialHistory}
          drawingEnabled={props.drawing && !props.disabled} containerClassName="feedback-kit-annotator"
          style={{ fill: "#3e63dd", fillOpacity: .08, stroke: "#3e63dd", strokeWidth: 2 }}>
          <img src={props.url} alt="反馈截图，可框选需要说明的位置" width={props.width} height={props.height} draggable={false} />
        </ImageAnnotator>
        <Binding {...props} />
      </Annotorious>
      <div className="feedback-kit-number-overlay" aria-hidden="true">
        {props.annotations.map((value, index) => <span key={value.id} data-selected={props.selected === value.id}
          style={{ left: `${value.x * 100}%`, top: `${value.y * 100}%` }}>{index + 1}</span>)}
      </div>
    </div>
  </div>;
}
