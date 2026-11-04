import profile from '../fixtures/client-profile.json' with { type: 'json' };
import { buildWorkerSource } from '../../bin/prepare-pages.mjs';
export const worker=(await import('data:text/javascript;base64,'+Buffer.from(buildWorkerSource(profile)).toString('base64'))).default;
