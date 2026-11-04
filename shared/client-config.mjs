const machineId = /^[a-z][a-z0-9-]{0,31}$/;
export const defaultClientConfig = Object.freeze({ schemaVersion: 1, defaultMachine: 'local',
  machines: Object.freeze([{ id: 'local', label: 'My Mac' }]), publicOrigin: null });

export function normalizeClientConfig(value = defaultClientConfig) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
      Object.keys(value).some(key => !['schemaVersion', 'defaultMachine', 'machines', 'publicOrigin'].includes(key)) ||
      typeof value.defaultMachine !== 'string' || !machineId.test(value.defaultMachine) || !Array.isArray(value.machines) || !value.machines.length || value.machines.length > 32)
    throw new Error('Invalid Pocket client configuration');
  const ids = new Set();
  const machines = value.machines.map(machine => {
    if (!machine || typeof machine !== 'object' || Array.isArray(machine) ||
        Object.keys(machine).some(key => key !== 'id' && key !== 'label') || typeof machine.id !== 'string' || !machineId.test(machine.id) ||
        typeof machine.label !== 'string' || !machine.label.trim() || machine.label.length > 80 ||
        /[\p{Cc}\p{Cf}]/u.test(machine.label) || ids.has(machine.id)) throw new Error('Invalid Pocket machine configuration');
    ids.add(machine.id); return { id: machine.id, label: machine.label.trim() };
  });
  if (!ids.has(value.defaultMachine)) throw new Error('Default Pocket machine is not configured');
  let publicOrigin = null;
  if (value.publicOrigin !== null && value.publicOrigin !== undefined) {
    const url = new URL(value.publicOrigin);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('Pocket public origin must be a bare HTTPS origin');
    publicOrigin = url.origin;
  }
  return { schemaVersion: 1, defaultMachine: value.defaultMachine, machines, publicOrigin };
}

export function serializeClientConfig(value) {
  const json = JSON.stringify(normalizeClientConfig(value)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `globalThis.POCKET_CLIENT_CONFIG = ${json};\n`;
}
