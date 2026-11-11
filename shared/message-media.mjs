const videoTypes = new Map([
  ['mp4', 'video/mp4'],
  ['m4v', 'video/mp4'],
  ['mov', 'video/quicktime'],
  ['webm', 'video/webm'],
]);
const imageTypes = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
]);
const audioTypes = new Map([
  ['wav', 'audio/wav'], ['mp3', 'audio/mpeg'], ['m4a', 'audio/mp4'],
  ['aac', 'audio/aac'], ['ogg', 'audio/ogg'], ['oga', 'audio/ogg'], ['flac', 'audio/flac'],
]);

// Presentation classification only. A registered image reader must separately
// check the file's bounded size and signature before serving an image MIME.
export function messageImageType(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const extension = /\.([a-z0-9]+)$/i.exec(value)?.[1].toLowerCase();
  return imageTypes.get(extension) ?? null;
}

export function isMessageImage(value) {
  return messageImageType(value) !== null;
}

// Filename classification only: this does not authorize a source, decode a URL,
// or verify container bytes. Callers must retain their capability checks.
export function messageVideoType(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const extension = /\.([a-z0-9]+)$/i.exec(value)?.[1].toLowerCase();
  return videoTypes.get(extension) ?? null;
}

export function isMessageVideo(value) {
  return messageVideoType(value) !== null;
}

// Filename classification does not authorize a source or verify its container.
export function messageAudioType(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const extension = /\.([a-z0-9]+)$/i.exec(value)?.[1].toLowerCase();
  return audioTypes.get(extension) ?? null;
}

export function isMessageAudio(value) {
  return messageAudioType(value) !== null;
}
