import { defaultClientConfig, normalizeClientConfig } from "../shared/client-config.mjs";
export type ClientConfig = { schemaVersion: 1; defaultMachine: string; machines: { id: string; label: string }[]; publicOrigin: string | null };
declare global { var POCKET_CLIENT_CONFIG: ClientConfig | undefined; }
export const clientConfig: ClientConfig = normalizeClientConfig(globalThis.POCKET_CLIENT_CONFIG ?? defaultClientConfig);
export const defaultMachineId = clientConfig.defaultMachine;
