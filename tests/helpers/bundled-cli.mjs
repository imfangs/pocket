import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const config = JSON.parse(readFileSync(new URL('../../config/desktop-bridge.json', import.meta.url), 'utf8'));
const bin = fileURLToPath(new URL('../../bin', import.meta.url));
export const bundledCli = execFileSync(config.python, ['-B', '-c',
  'import sys;sys.path.insert(0,sys.argv[1]);from bundled_cli import bundled_cli;print(bundled_cli(sys.argv[2])["entrypoint"])',
  bin, config.appPath], { encoding: 'utf8' }).trim();
