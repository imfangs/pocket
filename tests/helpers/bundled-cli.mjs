import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBridgeConfig } from '../../server/bridge-config.mjs';

const config = readBridgeConfig();
const bin = fileURLToPath(new URL('../../bin', import.meta.url));
export const bundledCli = execFileSync(config.python, ['-B', '-c',
  'import sys;sys.path.insert(0,sys.argv[1]);from bundled_cli import bundled_cli;print(bundled_cli(sys.argv[2])["entrypoint"])',
  bin, config.appPath], { encoding: 'utf8' }).trim();
