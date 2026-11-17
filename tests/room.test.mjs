import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
const port = 14293;
let server;
async function start() {
  server = spawn(process.execPath, ['server.mjs'], { cwd: new URL('../', import.meta.url), env: { ...process.env, PORT: String(port) } });
  await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(new Error('Server exited ' + code))); });
}
async function stop() { await new Promise(resolve => { server.once('exit', resolve); server.kill(); }); }
async function call(path, data, key) {
  const response = await fetch('http://localhost:' + port + path, { method: data ? 'POST' : 'GET', headers: key ? { Authorization: 'Bearer ' + key } : {}, body: data && JSON.stringify(data) });
  return { status: response.status, data: await response.json() };
}
test('two shoppers can share, recover, reject concurrent edits, approve and finish checkout', async () => {
  await start();
  try {
    const host = (await call('/api/rooms', { name: 'Satyam' })).data;
    const path = '/api/rooms/' + host.room.id;
    const guest = (await call(path + '/join', { name: 'Alex' })).data;
    assert.equal((await call(path)).status, 401);
    let room = guest.room;
    const variantId = room.catalog[0].variants[0].id;
    room = (await call(path, { action: 'lead', version: room.version }, host.key)).data;
    assert.equal(room.leaderId, host.room.me);
    room = (await call(path, { action: 'browse', variantId }, host.key)).data;
    const follower = (await call(path, null, guest.key)).data;
    assert.equal(follower.members.find(m => m.id === host.room.me).browsing, variantId);
    assert.equal(room.basketVersion, guest.room.basketVersion);
    room = (await call(path, { action: 'browse', variantId: null }, host.key)).data;
    assert.equal(room.members.find(m => m.id === host.room.me).browsing, null);
    room = (await call(path, { action: 'share', variantId, version: room.version }, host.key)).data;
    assert.equal(room.table.length, 1);
    assert.equal(room.members[0].hash, undefined);
    assert.equal(room.store, undefined);
    const edits = await Promise.all([host.key, guest.key].map(key => call(path, { action: 'add', variantId, version: room.version }, key)));
    assert.deepEqual(edits.map(r => r.status).sort(), [200, 409]);
    room = (await call(path, null, host.key)).data;
    assert.equal(room.basket[0].quantity, 1);
    room = (await call(path, { action: 'approve', version: room.version }, host.key)).data;
    room = (await call(path, { action: 'approve', version: room.version }, guest.key)).data;
    assert.equal(room.approvals.length, 2);
    room = (await call(path, { action: 'quantity', lineId: room.basket[0].id, quantity: 2, version: room.version }, host.key)).data;
    assert.equal(room.approvals.length, 0);
    assert.equal((await call(path, { action: 'checkout', version: room.version }, host.key)).status, 400);
    await stop(); await start();
    room = (await call(path, null, guest.key)).data;
    assert.equal(room.basket[0].quantity, 2);
    room = (await call(path, { action: 'approve', version: room.version }, host.key)).data;
    room = (await call(path, { action: 'approve', version: room.version }, guest.key)).data;
    room = (await call(path, { action: 'checkout', version: room.version }, host.key)).data;
    assert.equal(room.checkout.mode, 'sample');
    assert.match(room.checkout.reference, /^DEMO-/);
  } finally { await stop(); }
});
