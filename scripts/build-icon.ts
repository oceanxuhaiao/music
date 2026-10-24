import { readFile, writeFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';
const source = await readFile(new URL('../assets/icon.svg', import.meta.url), 'utf8');
const png = new Resvg(source, { fitTo: { mode: 'width', value: 256 } }).render().asPng();
if (png.length > 512 * 1024) throw new Error('Market icon exceeds 512 KB');
await writeFile(new URL('../assets/icon.png', import.meta.url), png);
console.log(`Built 256px market icon (${png.length} bytes)`);
