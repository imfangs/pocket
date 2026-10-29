export type MessageVideoType = 'video/mp4' | 'video/quicktime' | 'video/webm';
export function messageVideoType(value: unknown): MessageVideoType | null;
export function isMessageVideo(value: unknown): boolean;
