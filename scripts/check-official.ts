import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';

const checkout = process.argv[2] || process.env.CORTICO_CHECKOUT;
if (!checkout) throw new Error('Set CORTICO_CHECKOUT to a dependency-installed official Cortico checkout, or pass its path. Local check is not the complete release gate.');
const core = resolve(checkout), target = resolve('.');
const runner = join(core, 'node_modules/tsx/dist/cli.mjs');
if (!existsSync(runner)) throw new Error('Install dependencies in the Cortico checkout before running the official release gate.');
for (const script of ['extension-describe.ts', 'extension-check.ts']) {
  const result = spawnSync(process.execPath, [runner, join(core, 'scripts', script), target], { cwd: core, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
