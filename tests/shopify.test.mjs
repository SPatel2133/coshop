import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShopifyClient } from '../shopify.mjs';

const lines = [{ variantId: 'gid://shopify/ProductVariant/123', quantity: 2 }];
function client(payload, status = 200) {
  return new ShopifyClient('example.myshopify.com', 'public-token-1234567890', {
    fetcher: async () => new Response(JSON.stringify(payload), { status })
  });
}
test('Shopify checkout rejects missing or reduced quantities', async () => {
  const api = client({ data: { cartCreate: { userErrors: [], cart: {
    checkoutUrl: 'https://example.myshopify.com/checkouts/example',
    lines: { nodes: [{ quantity: 1, merchandise: { id: lines[0].variantId } }] }
  } } } });
  await assert.rejects(() => api.checkout(lines), /Availability changed/);
});
test('Shopify API and GraphQL failures are surfaced to the shopper', async () => {
  await assert.rejects(() => client({}, 401).products(), /401/);
  await assert.rejects(() => client({ errors: [{ message: 'Access denied' }] }).products(), /Access denied/);
});
test('private tokens and non-Shopify domains are rejected', () => {
  assert.throws(() => new ShopifyClient('localhost', 'public-token-1234567890'), /domain/);
  assert.throws(() => new ShopifyClient('example.myshopify.com', 'shpat_secret'), /public Storefront/);
});
test('matching Shopify cart returns its secure checkout handoff', async () => {
  const checkoutUrl = 'https://example.myshopify.com/checkouts/example';
  const api = client({ data: { cartCreate: { userErrors: [], cart: {
    checkoutUrl, lines: { nodes: [{ quantity: 2, merchandise: { id: lines[0].variantId } }] }
  } } } });
  assert.equal((await api.checkout(lines)).checkoutUrl, checkoutUrl);
});
