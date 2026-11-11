export type MessageVideoType = 'video/mp4' | 'video/quicktime' | 'video/webm';
export type MessageImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
export type MessageAudioType = 'audio/wav' | 'audio/mpeg' | 'audio/mp4' | 'audio/aac' | 'audio/ogg' | 'audio/flac';
export function messageImageType(value: unknown): MessageImageType | null;
export function isMessageImage(value: unknown): boolean;
export function messageVideoType(value: unknown): MessageVideoType | null;
export function isMessageVideo(value: unknown): boolean;
export function isMessageAudio(value: unknown): boolean;
export function messageAudioType(value: unknown): MessageAudioType | null;
