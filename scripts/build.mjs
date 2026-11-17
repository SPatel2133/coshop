import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const files = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript', 'style.css': 'text/css', 'mobile.css': 'text/css', 'font.woff2': 'font/woff2' };
const assets = {};
for (const [file, type] of Object.entries(files)) assets[file === 'index.html' ? '/' : '/' + file] = { data: (await readFile(new URL(file, root))).toString('base64'), type };
const modules = ['shopify.mjs', 'catalog.mjs', 'room-domain.mjs', 'worker.mjs'];
let output = '';
for (const file of modules) {
  let source = await readFile(new URL(file, root), 'utf8');
  source = source.replace(/^import .*;\r?\n/gm, '');
  if (file !== 'worker.mjs') source = source.replace(/export /g, '');
  output += source + '\n';
}
output = 'const bundledAssets = ' + JSON.stringify(assets) + ';\n' + output;
await mkdir(new URL('dist/server/', root), { recursive: true });
await writeFile(new URL('dist/server/index.js', root), output);
await mkdir(new URL('dist/.openai/', root), { recursive: true });
await cp(new URL('.openai/hosting.json', root), new URL('dist/.openai/hosting.json', root));
await cp(new URL('drizzle/', root), new URL('dist/.openai/drizzle/', root), { recursive: true });
console.log('Built Worker with shared room logic, embedded assets, and D1 migrations.');
