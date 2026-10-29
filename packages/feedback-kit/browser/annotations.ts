import { FEEDBACK_LIMITS, type FeedbackAnnotation, type FeedbackImage } from "../contracts.ts";
import { encodeFeedbackCanvas, FeedbackCaptureError, loadCaptureImage, type FeedbackCapture } from "./capture.ts";

export function annotationRectangle(annotation: FeedbackAnnotation, width: number, height: number) {
  if (![width, height].every(n => Number.isFinite(n) && n > 0 && n <= FEEDBACK_LIMITS.imageSide))
    throw new FeedbackCaptureError("截图尺寸无效，请重新选择。", "image_dimensions");
  const values = [annotation.x, annotation.y, annotation.width, annotation.height];
  if (!values.every(Number.isFinite) || annotation.x < 0 || annotation.y < 0 || annotation.width <= 0 || annotation.height <= 0 ||
      annotation.x + annotation.width > 1.000001 || annotation.y + annotation.height > 1.000001)
    throw new FeedbackCaptureError("标注位置已失效，请重新框选。", "annotation_bounds");
  return { x: annotation.x * width, y: annotation.y * height,
    width: annotation.width * width, height: annotation.height * height };
}

export async function renderFeedbackAnnotations(capture: FeedbackCapture, annotations: readonly FeedbackAnnotation[], signal?: AbortSignal): Promise<FeedbackCapture> {
  if (annotations.length > FEEDBACK_LIMITS.annotations) throw new FeedbackCaptureError("每次最多标注8处。", "annotation_limit");
  const image = await loadCaptureImage(capture.blob, signal);
  if (image.naturalWidth !== capture.width || image.naturalHeight !== capture.height)
    throw new FeedbackCaptureError("截图已变化，请重新标注。", "annotation_source");
  const canvas = document.createElement("canvas"); canvas.width = capture.width; canvas.height = capture.height;
  const context = canvas.getContext("2d");
  if (!context) throw new FeedbackCaptureError("当前浏览器无法生成标注图。");
  context.drawImage(image, 0, 0);
  const unit = Math.max(1, Math.min(3, capture.width / 390));
  annotations.forEach((annotation, index) => {
    const rect = annotationRectangle(annotation, canvas.width, canvas.height);
    const stroke = 2 * unit, badge = 22 * unit;
    context.lineWidth = stroke; context.strokeStyle = "#ed4264";
    context.strokeRect(rect.x + stroke / 2, rect.y + stroke / 2, Math.max(0, rect.width - stroke), Math.max(0, rect.height - stroke));
    const x = Math.min(Math.max(0, rect.x), canvas.width - badge), y = Math.min(Math.max(0, rect.y - badge), canvas.height - badge);
    context.fillStyle = "#ed4264"; context.fillRect(x, y, badge, badge);
    context.fillStyle = "#ffffff"; context.font = `600 ${14 * unit}px -apple-system, BlinkMacSystemFont, sans-serif`;
    context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(String(index + 1), x + badge / 2, y + badge / 2);
    const note = annotation.note?.trim().split(/\r?\n/)[0].slice(0, 28);
    if (note) {
      context.font = `${11 * unit}px -apple-system, BlinkMacSystemFont, sans-serif`;
      const available = Math.max(0, canvas.width - x - badge - 4 * unit);
      const textWidth = Math.min(available, context.measureText(note).width + 10 * unit);
      if (textWidth > 30 * unit) {
        context.fillStyle = "rgba(25,29,35,.94)"; context.fillRect(x + badge, y, textWidth, badge);
        context.save(); context.beginPath(); context.rect(x + badge, y, textWidth, badge); context.clip();
        context.fillStyle = "#ffffff"; context.textAlign = "left";
        context.fillText(note, x + badge + 5 * unit, y + badge / 2); context.restore();
      }
    }
  });
  return encodeFeedbackCanvas(canvas, signal);
}

export async function toFeedbackImage(capture: FeedbackCapture, kind: FeedbackImage["kind"]): Promise<FeedbackImage> {
  if (!["original", "annotated"].includes(kind) || !["image/png", "image/jpeg"].includes(capture.mime) ||
      capture.blob.type !== capture.mime || !capture.blob.size || capture.blob.size > FEEDBACK_LIMITS.imageBytes ||
      ![capture.width, capture.height].every(n => Number.isInteger(n) && n > 0 && n <= FEEDBACK_LIMITS.imageSide) ||
      capture.width * capture.height > FEEDBACK_LIMITS.imagePixels)
    throw new FeedbackCaptureError("截图格式或大小无效。", "image_format");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(capture.blob);
  });
  return { kind, mime: capture.mime, width: capture.width, height: capture.height, base64: data.slice(data.indexOf(",") + 1) };
}
