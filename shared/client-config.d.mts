export interface ClientConfig { schemaVersion: 1; defaultMachine: string; machines: { id: string; label: string }[]; publicOrigin: string | null }
export const defaultClientConfig: Readonly<ClientConfig>;
export function normalizeClientConfig(value?: unknown): ClientConfig;
export function serializeClientConfig(value: unknown): string;
