import { catalog } from './catalog.mjs';
import { view, update, changed, log } from './room-domain.mjs';

const assetHeaders = { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
const conflict = () => Object.assign(new Error('The room changed. Review the latest state and try again.'), { status: 409 });
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  let length = 0, text = '';
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 12000) { await reader.cancel(); throw new Error('Request too large.'); }
    text += decoder.decode(value, { stream: true });
  }
  const data = JSON.parse(text + decoder.decode());
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid request.');
  return data;
}
function response(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
async function limit(db, key, max, windowMs) {
  const bucket = Math.floor(Date.now() / windowMs);
  const result = await db.prepare('INSERT INTO quotas (id, count) VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET count=count+1 RETURNING count').bind(key + ':' + bucket).first();
  if (result.count > max) throw Object.assign(new Error('Demo request limit reached. Please try again later.'), { status: 429 });
}
export async function handleApi(request, env) {
  try {
    const url = new URL(request.url);
    if (request.method === 'POST' && request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return response({ error: 'Use the shopping room page to make changes.' }, 403);
    if (url.pathname === '/api/health') return response({ ok: true, storage: 'D1', serverTime: Date.now() });
    if (!env.DB) throw new Error('Room storage is unavailable.');
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      await limit(env.DB, 'create:' + await digest(request.headers.get('CF-Connecting-IP') || 'demo'), 12, 3600000);
      const op = await readBody(request), key = crypto.randomUUID();
      const member = { id: crypto.randomUUID(), name: String(op.name || 'You').trim().slice(0, 24) || 'You', hash: await digest(key) };
      const room = { id: crypto.randomUUID(), owner: member.id, leaderId: member.id, version: 0, basketVersion: 0, members: [member], catalog, table: [], basket: [], approvals: [], activity: [], checkout: null, expiresAt: Date.now() + 7 * 86400000 };
      await env.DB.prepare('INSERT INTO rooms (id,state) VALUES (?,?)').bind(room.id, JSON.stringify(room)).run();
      return response({ key, room: view(room, member) }, 201);
    }
    const match = url.pathname.match(/^\/api\/rooms\/([a-f0-9-]{36})(\/join)?$/);
    if (!match) return response({ error: 'Not found' }, 404);
    const row = await env.DB.prepare('SELECT state FROM rooms WHERE id=?').bind(match[1]).first();
    if (!row) return response({ error: 'Room not found. Start a new room.' }, 404);
    const room = JSON.parse(row.state);
    if (room.expiresAt < Date.now()) return response({ error: 'This demo room expired. Start another room.' }, 410);
    if (match[2] && request.method === 'POST') {
      const op = await readBody(request);
      if (room.members.length >= 6) throw new Error('This room already has six shoppers.');
      const key = crypto.randomUUID(), member = { id: crypto.randomUUID(), name: String(op.name || 'Friend').trim().slice(0, 24) || 'Friend', hash: await digest(key) };
      room.members.push(member); changed(room); room.version++; log(room, member, 'joined the room');
      const saved = await env.DB.prepare('UPDATE rooms SET state=? WHERE id=? AND state=?').bind(JSON.stringify(room), room.id, row.state).run();
      if (!saved.meta.changes) throw conflict();
      return response({ key, room: view(room, member) }, 201);
    }
    const tokenHash = await digest((request.headers.get('Authorization') || '').replace(/^Bearer /, ''));
    const member = room.members.find(m => m.hash === tokenHash);
    if (!member) return response({ error: 'Join the room to continue.' }, 401);
    if (request.method === 'POST') {
      await limit(env.DB, 'writes:' + member.id, 240, 60000);
      await update(room, member, await readBody(request));
      room.version++;
      // Compare-and-swap applies across Worker isolates, unlike a process-local queue.
      const saved = await env.DB.prepare('UPDATE rooms SET state=? WHERE id=? AND state=?').bind(JSON.stringify(room), room.id, row.state).run();
      if (!saved.meta.changes) throw conflict();
    } else if (request.method !== 'GET') return response({ error: 'Unsupported method' }, 405);
    return response(view(room, member));
  } catch (error) {
    return response({ error: error.message || 'Room request failed.' }, error.status || 400);
  }
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/')) return handleApi(request, env);
    const asset = bundledAssets[path];
    if (!asset || request.method !== 'GET') return new Response('Not found', { status: 404 });
    return new Response(Uint8Array.from(atob(asset.data), c => c.charCodeAt(0)), { headers: { ...assetHeaders, 'Content-Type': asset.type } });
  }
};
