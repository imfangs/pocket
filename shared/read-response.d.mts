export type ReadResponseKind = 'catalog' | 'sync' | 'transcript' | 'history';
export const READ_VERSION_HEADER: 'X-Pocket-Read-Version';
export const CHECKED_AT_HEADER: 'X-Pocket-Checked-At';
export const SOURCE_SYNCED_AT_HEADER: 'X-Pocket-Source-Synced-At';
export const TURN_OBSERVED_AT_HEADER: 'X-Pocket-Turn-Observed-At';
export function readResponseKind(path: string, method?: string): ReadResponseKind | null;
export function isReadVersion(value: unknown): value is string;
export function splitReadResponse(kind: ReadResponseKind, data: unknown): {
  content: unknown;
  observationKeys: string[];
  headers: Record<string, string>;
};
export function hydrateReadResponse<T>(kind: ReadResponseKind, data: T,
  headers: { get(name: string): string | null }): T | null;
