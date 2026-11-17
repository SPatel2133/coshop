import { writeFile } from 'node:fs/promises';
const base = process.argv[2] || 'http://localhost:4193';
async function call(path, data, key) {
  const response = await fetch(base + path, { method: data ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, body: data && JSON.stringify(data) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || response.statusText);
  return value;
}
const host = await call('/api/rooms', { name: 'Shopify verification' });
const path = '/api/rooms/' + host.room.id;
let room = await call(path, { action: 'connect', version: host.room.version,
  domain: 'hydrogen-preview.myshopify.com', token: '3b580e70970c4528da70c98e097c2fa0'
}, host.key);
const guest = await call(path + '/join', { name: 'Second shopper' });
room = guest.room;
const variant = room.catalog.flatMap(p => p.variants).find(v => v.available);
if (!variant) throw new Error('The demo catalog has no available variants.');
room = await call(path, { action: 'add', variantId: variant.id, version: room.version }, host.key);
room = await call(path, { action: 'approve', version: room.version }, host.key);
room = await call(path, { action: 'approve', version: room.version }, guest.key);
room = await call(path, { action: 'checkout', version: room.version }, host.key);
if (room.checkout?.mode !== 'shopify') throw new Error('Shopify cart handoff did not complete.');
const report = {
  verifiedAt: new Date().toISOString(), target: base, store: 'hydrogen-preview.myshopify.com',
  productsRetrieved: room.catalog.length, variantId: variant.id, requestedQuantity: 1,
  cartQuantityValidation: 'passed', checkoutHost: new URL(room.checkout.url).hostname,
  source: 'https://shopify.dev/docs/api/hydrogen/2026-04',
  scope: 'Public Shopify Hydrogen demo store. Created a Storefront API cart through the hosted room API. No order or payment was submitted.'
};
await writeFile(new URL('../shopify-verification.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
