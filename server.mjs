import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { view, update, changed, log } from './room-domain.mjs';
import { catalog } from './catalog.mjs';

const root = new URL('./', import.meta.url);
await mkdir(new URL('data/', root), { recursive: true });
const db = new DatabaseSync(fileURLToPath(new URL('data/rooms.sqlite', root)));
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, state TEXT NOT NULL)');
const queues = new Map();
const hash = value => createHash('sha256').update(value).digest('hex');
function load(id) {
  const row = db.prepare('SELECT state FROM rooms WHERE id=?').get(id);
  if (!row) throw new Error('Room not found. Start a new room.');
  return JSON.parse(row.state);
}
function save(room) { db.prepare('INSERT OR REPLACE INTO rooms VALUES (?,?)').run(room.id, JSON.stringify(room)); }
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 12000) throw new Error('Request too large.'); }
  try { return JSON.parse(text || '{}'); } catch { throw new Error('Invalid request.'); }
}
function json(res, code, data) {
  res.writeHead(code, {'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(data));
}
const assets = {'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css'],'/font.woff2':['font.woff2','font/woff2']};
http.createServer(async(req,res)=>{
  try {
    const path=new URL(req.url,'http://localhost').pathname;
    if(req.method==='GET' && path==='/mobile.css') {res.writeHead(200,{'Content-Type':'text/css','Cache-Control':'no-cache'});return res.end(await readFile(new URL('mobile.css',root)));}
    if(req.method==='GET' && assets[path]) {const [file,type]=assets[path];res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-cache'});return res.end(await readFile(new URL(file,root)));}
    if(path==='/api/rooms' && req.method==='POST') {
      const op=await body(req), key=randomUUID(), member={id:randomUUID(),name:String(op.name||'You').trim().slice(0,24)||'You',hash:hash(key)};
      const room={id:randomUUID(),owner:member.id,leaderId:member.id,version:0,basketVersion:0,members:[member],catalog,table:[],basket:[],approvals:[],activity:[],checkout:null};
      save(room);return json(res,201,{key,room:view(room,member)});
    }
    const match=path.match(/^\/api\/rooms\/([a-f0-9-]{36})(\/join)?$/);
    if(!match) return json(res,404,{error:'Not found'});
    const id=match[1], previous=queues.get(id)||Promise.resolve();
    const run=previous.catch(()=>{}).then(async()=>{
      const room=load(id);
      if(match[2] && req.method==='POST') {
        const op=await body(req);
        if(room.members.length>=6) throw new Error('This room already has six shoppers.');
        const key=randomUUID(),member={id:randomUUID(),name:String(op.name||'Friend').trim().slice(0,24)||'Friend',hash:hash(key)};
        room.members.push(member);changed(room);room.version++;log(room,member,'joined the room');save(room);
        return json(res,201,{key,room:view(room,member)});
      }
      const key=req.headers.authorization?.replace(/^Bearer /,'')||'', member=room.members.find(m=>m.hash===hash(key));
      if(!member) throw Object.assign(new Error('Join the room to continue.'),{status:401});
      if(req.method==='POST') {await update(room,member,await body(req));room.version++;save(room);}
      else if(req.method!=='GET') throw new Error('Unsupported method.');
      json(res,200,view(room,member));
    });
    queues.set(id,run);
    try {await run;} finally {if(queues.get(id)===run) queues.delete(id);}
  } catch(error) {if(!res.headersSent) json(res,error.status||400,{error:error.message});}
}).listen(Number(process.env.PORT||4193),process.env.HOST || '0.0.0.0',()=>console.log('Local: http://localhost:'+(process.env.PORT||4193)));
