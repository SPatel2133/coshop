import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleApi } from '../worker.mjs';

test('hosted API rejects concurrent writes and preserves the latest followed variant', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE rooms(id TEXT PRIMARY KEY, state TEXT NOT NULL); CREATE TABLE quotas(id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)');
  const env = { DB: { prepare(sql) { return { bind(...args) { return {
    async first() { return sqlite.prepare(sql).get(...args) || null; },
    async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: result.changes } }; }
  }; } }; } } };
  async function call(path, data, key) {
    const result = await handleApi(new Request('https://example.test' + path, {
      method: data ? 'POST' : 'GET', headers: key ? { Authorization: 'Bearer ' + key } : {}, body: data && JSON.stringify(data)
    }), env);
    return { status: result.status, data: await result.json() };
  }
  try {
    const host = (await call('/api/rooms', { name: 'Host' })).data;
    const path = '/api/rooms/' + host.room.id;
    const friend = (await call(path + '/join', { name: 'Friend' })).data;
    assert.equal((await call(path)).status, 401);
    let state = friend.room;
    const variantId = state.catalog[0].variants[1].id;
    state = (await call(path, { action: 'lead', version: state.version }, host.key)).data;
    await call(path, { action: 'browse', variantId }, host.key);
    state = (await call(path, null, friend.key)).data;
    assert.equal(state.members.find(m => m.id === host.room.me).browsing, variantId);
    assert.equal(typeof state.members[0].browsedAt, 'number');
    const edits = await Promise.all([host.key, friend.key].map(key => call(path, { action: 'add', variantId, version: state.version }, key)));
    assert.deepEqual(edits.map(r => r.status).sort(), [200, 409]);
    state = (await call(path, null, host.key)).data;
    assert.equal(state.basket[0].quantity, 1);
    assert.equal(state.members[0].hash, undefined);
    assert.equal(state.store, undefined);
    const before = state.version;
    await call(path, { action: 'browse', variantId: 'nonexistent' }, host.key);
    assert.equal((await call(path, null, host.key)).data.version, before);
    const group = (await call('/api/rooms', { name: 'Group host' })).data;
    const groupPath = '/api/rooms/' + group.room.id;
    let lastGuest;
    for (let index = 0; index < 5; index++) lastGuest = await call(groupPath + '/join', { name: 'Friend ' + index });
    assert.equal(lastGuest.data.room.members.length, 6);
    assert.equal((await call(groupPath + '/join', { name: 'Seventh' })).status, 400);
    for (let index = 0; index < 10; index++) await call('/api/rooms', { name: 'Quota test' });
    assert.equal((await call('/api/rooms', { name: 'Limited' })).status, 429);
  } finally { sqlite.close(); }
});
