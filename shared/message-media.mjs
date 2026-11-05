const videoTypes = new Map([
  ['mp4', 'video/mp4'],
  ['m4v', 'video/mp4'],
  ['mov', 'video/quicktime'],
  ['webm', 'video/webm'],
]);

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

// Presentation classification only; audio uses existing registered file cards.
// This does not add playback endpoints or authorize image-style references.
export function isMessageAudio(value) {
  return typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value) &&
    /\.(?:wav|mp3|m4a|aac|ogg|oga|flac)$/i.test(value);
}
