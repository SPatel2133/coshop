import { writeFile } from 'node:fs/promises';
const base = process.argv[2] || 'http://localhost:4193';
const delays = [];
async function call(path, data, key) {
  const response = await fetch(base + path, { method: data ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, body: data && JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || response.statusText);
  return result;
}
const host = await call('/api/rooms', { name: 'Benchmark host' });
const path = '/api/rooms/' + host.room.id;
const friend = await call(path + '/join', { name: 'Benchmark friend' });
let room = await call(path, { action: 'lead', version: friend.room.version }, host.key);
const options = room.catalog[0].variants;
let lastPublished = -1, latestObserved = -1, lastSentAt = 0, polling = false;
// Two separate HTTP identities. Sample at the same interval as the browser.
const timer = setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    const state = await call(path, null, friend.key);
    const selection = state.members.find(member => member.id === host.room.me)?.browsing;
    if (lastPublished !== latestObserved && selection === options[lastPublished % options.length]?.id) {
      delays.push(Math.round(performance.now() - lastSentAt));
      latestObserved = lastPublished;
    }
  } finally { polling = false; }
}, 1200);
try {
  for (let index = 0; index < 10; index++) {
    // Vary the publishing phase relative to the polling clock.
    await new Promise(resolve => setTimeout(resolve, 1450 + index * 37));
    lastSentAt = performance.now();
    await call(path, { action: 'browse', variantId: options[index % options.length].id }, host.key);
    lastPublished = index;
    const deadline = Date.now() + 5000;
    while (latestObserved !== index && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (latestObserved !== index) throw new Error('A browsing update did not reach the follower.');
  }
} finally { clearInterval(timer); }
const sorted = [...delays].sort((a, b) => a - b);
const report = {
  measuredAt: new Date().toISOString(), target: base, samples: delays.length, pollingIntervalMs: 1200,
  medianMs: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2, p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], minMs: sorted[0], maxMs: sorted.at(-1), samplesMs: delays,
  method: 'One publishing HTTP client and one independently polling HTTP client. Measured from publication start to follower observation on this machine. This is not a browser rendering or load test.'
};
await writeFile(new URL('../benchmark-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
