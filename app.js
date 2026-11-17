const $ = id => document.getElementById(id);
const make = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const button = (text, action, className) => {
  const node = make('button', text, className);
  node.type = 'button'; node.onclick = action; return node;
};
let room, busy = false, category = 'All', search = '', toastTimer;
let roomId = new URLSearchParams(location.search).get('room');
const guestView = new URLSearchParams(location.search).has('guest');
const membershipStorage = guestView ? sessionStorage : localStorage;
let key = roomId && membershipStorage.getItem('shopping-room:' + roomId);
let following = false, shownVariant = null, remoteProduct = false, closingFromLeader = false;
const followKey = () => 'shopping-follow:' + roomId;
following = membershipStorage.getItem(followKey()) === 'true';
let connectionHealthy = navigator.onLine, lastBrowseReceived = 0;
const syncMeasurements = [];
let activeRefresh = null;
let browseRequest = Promise.resolve();
function setFollowing(value) {
  following = value;
  membershipStorage.setItem(followKey(), String(value));
}
function setConnection(healthy) {
  connectionHealthy = healthy;
  $('connection').textContent = healthy ? 'Connected' : 'Reconnecting…';
  $('connection').classList.toggle('disconnected', !healthy);
  $('reconnect-notice').hidden = healthy;
}
let pendingBrowse, publishingBrowse = false;
async function publishBrowse(variantId) {
  pendingBrowse = variantId;
  if (publishingBrowse) return;
  publishingBrowse = true;
  while (pendingBrowse !== undefined) {
    const value = pendingBrowse;
    pendingBrowse = undefined;
    try {
      browseRequest = request('/api/rooms/' + roomId, { action: 'browse', variantId: value });
      const next = await browseRequest;
      if (next.version >= room.version) { room = next; render(); }
    } catch (error) { if (pendingBrowse === undefined) pendingBrowse = value; setConnection(false); break; }
  }
  publishingBrowse = false;
}
const money = (cents, currency = 'CAD') => new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(cents / 100);
function toast(text) {
  $('toast').textContent = text; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5500);
}
async function request(path, data, authenticate = true) {
  const response = await fetch(path, { method: data ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(authenticate && key ? { Authorization: 'Bearer ' + key } : {}) }, body: data && JSON.stringify(data), signal: AbortSignal.timeout(25000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Something went wrong. Try again.');
  return result;
}
function identify(variantId) {
  for (const product of room.catalog) {
    const variant = product.variants.find(v => v.id === variantId);
    if (variant) return { product, variant };
  }
}
const name = id => room.members.find(m => m.id === id)?.name || 'Friend';
function image(product) {
  const img = make('img'); img.src = product.image || ''; img.alt = product.name; img.loading = 'lazy';
  img.onerror = () => { img.removeAttribute('src'); img.alt = product.name + ' — image unavailable'; };
  return img;
}
async function refresh(force = false) {
  if (!roomId || !key || busy || activeRefresh) return;
  activeRefresh = request('/api/rooms/' + roomId);
  const started = Date.now();
  try {
    const next = await activeRefresh;
    setConnection(true);
    const leader = next.members.find(member => member.id === next.leaderId);
    if (following && leader?.browsedAt && leader.browsedAt !== lastBrowseReceived) {
      const clockOffset = next.serverTime - (started + Date.now()) / 2;
      const delay = Math.max(0, Math.round(Date.now() + clockOffset - leader.browsedAt));
      if (lastBrowseReceived) {
        syncMeasurements.push(delay);
        if (syncMeasurements.length > 40) syncMeasurements.shift();
        $('sync-metric').textContent = 'Last sync ≈ ' + delay + ' ms';
      }
      lastBrowseReceived = leader.browsedAt;
    }
    if (!room || next.version >= room.version && (force || next.version !== room.version)) { room = next; render(); }
  } finally { activeRefresh = null; }
  if (pendingBrowse !== undefined && !publishingBrowse) publishBrowse(pendingBrowse);
}
async function action(type, data = {}) {
  if (busy) return;
  busy = true;
  try {
    if (!connectionHealthy || !navigator.onLine) throw new Error('Reconnecting. Your saved basket will return when the connection recovers.');
    while (publishingBrowse) await browseRequest.catch(() => {});
    if (!connectionHealthy) throw new Error('Reconnect before changing the shared basket.');
    const next = await request('/api/rooms/' + roomId, { action: type, version: room.version, ...data });
    room = next; render();
    if (type === 'share') toast('On the table. Your friend can see your pick.');
    if (type === 'add') toast('Added to your shared basket.');
    if (type === 'approve') toast('Your approval is saved for this basket.');
    if (type === 'connect') { $('store-dialog').close(); $('token').value = ''; toast('Shopify collection connected.'); }
    if (type === 'checkout' && !room.checkout) toast('Prices changed. Review the updated basket and approve again.');
  } catch (error) {
    toast(error.message);
    if (type === 'connect') $('store-error').textContent = error.message;
  } finally { busy = false; await refresh().catch(() => {}); }
}
function renderProducts() {
  $('products').replaceChildren();
  const matches = room.catalog.filter(p => (category === 'All' || p.category === category) && (p.name + ' ' + p.description).toLowerCase().includes(search));
  if (!matches.length) $('products').append(make('p', 'No finds here. Try another search.', 'empty'));
  for (const product of matches) {
    const card = make('article', undefined, 'product-card');
    const photo = button('', () => openProduct(product), 'image-button');
    photo.setAttribute('aria-label', 'View ' + product.name); photo.append(image(product), make('span', 'Take a closer look ↗', 'view'));
    const meta = make('div', undefined, 'product-meta');
    meta.append(make('h3', product.name), make('span', money(product.variants[0].cents, product.variants[0].currency)));
    card.append(photo, meta, make('p', product.category, 'category'), button('Show my friend ↗', () => openProduct(product), 'share-small'));
    $('products').append(card);
  }
}
function openProduct(product, variantId, fromFriend = false) {
  if (!fromFriend) setFollowing(false);
  remoteProduct = fromFriend;
  const content = make('div', undefined, 'detail-layout'), info = make('div');
  info.append(make('p', product.category, 'eyebrow'), make('h2', product.name), make('p', product.description));
  const price = make('p', '', 'price'), select = make('select'); select.id = 'variant-choice';
  select.setAttribute('aria-label', 'Choose an option');
  for (const variant of product.variants) {
    const option = make('option', variant.title + (variant.available ? '' : ' · Sold out'));
    option.value = variant.id; option.disabled = !variant.available; select.append(option);
  }
  const available = product.variants.find(v => v.available);
  if (available) select.value = available.id;
  if (variantId) select.value = variantId;
  const updatePrice = () => { const v = product.variants.find(v => v.id === select.value); price.textContent = money(v.cents, v.currency); };
  select.onchange = () => {
    updatePrice();
    setFollowing(false);
    remoteProduct = false;
    shownVariant = select.value;
    publishBrowse(select.value);
  };
  updatePrice();
  shownVariant = select.value;
  if (!fromFriend) publishBrowse(select.value);
  const share = button('Show my friend ↗', async () => { await action('share', { variantId: select.value }); }, 'primary full');
  const add = button('Add to shared basket', () => action('add', { variantId: select.value }), 'secondary full');
  share.disabled = add.disabled = !available;
  info.append(price, make('label', 'Choose your option'), select, share, add, make('p', room.mode === 'sample' ? 'Sample product · Photography is illustrative.' : 'Price and availability retrieved from Shopify.', 'fine'));
  if (fromFriend) info.prepend(make('p', 'Following ' + name(room.leaderId || room.members.find(m => m.id !== room.me)?.id), 'following-label'));
  content.append(image(product), info); $('product-detail').replaceChildren(content);
  if (!$('product-dialog').open) $('product-dialog').showModal();
}
function render() {
  $('landing').hidden = true; $('room').hidden = false;
  $('collection-label').textContent = room.storeName + (room.mode === 'sample' ? ' / Sample collection' : ' / Shopify');
  $('store-button').disabled = room.me !== room.owner;
  const friend = room.members.find(member => member.id !== room.me);
  const leader = room.members.find(member => member.id === room.leaderId) || friend;
  $('follow').disabled = !friend || leader?.id === room.me;
  $('follow').textContent = following ? 'Browse independently' : 'Follow ' + (leader?.name || 'your friend');
  $('lead').disabled = room.leaderId === room.me;
  $('browse-status').textContent = following ? 'Following ' + leader.name : room.leaderId === room.me ? 'You’re leading' : 'Browse together';
  const friendProduct = friend?.browsing && identify(friend.browsing);
  $('friend-view').textContent = friendProduct ? friend.name + ' is viewing ' + friendProduct.product.name + ' · ' + friendProduct.variant.title : friend ? friend.name + ' is exploring the collection' : 'Invite a friend to browse the same products together.';
  if (following && leader?.id === room.me) setFollowing(false);
  if (following && leader) {
    const selection = leader.browsing && identify(leader.browsing);
    if (selection && (!remoteProduct || shownVariant !== leader.browsing || !$('product-dialog').open)) openProduct(selection.product, leader.browsing, true);
    if (!selection && remoteProduct && $('product-dialog').open) { closingFromLeader = true; $('product-dialog').close(); }
  }
  $('members').replaceChildren(...room.members.map(m => {
    const avatar = make('span', m.name.slice(0, 2).toUpperCase(), 'avatar'); avatar.title = m.name + (m.id === room.me ? ' (you)' : ''); return avatar;
  }));
  if (room.members.length === 1) $('members').append(make('span', 'A seat for your friend', 'fine'));
  $('invite').textContent = room.members.length >= 6 ? 'Room link ↗' : 'Invite friends ↗';
  $('filters').replaceChildren(...['All', ...new Set(room.catalog.map(p => p.category))].map(value => button(value, () => { category = value; render(); }, value === category ? 'active' : '')));
  renderProducts();
  $('catalog-note').textContent = room.mode === 'sample' ? 'Sample collection. Illustrative Unsplash photography. Connect a Shopify store before adding picks for live products and checkout.' : 'Showing the first 12 published products, up to 100 variants each.';
  $('pick-count').textContent = room.table.length;
  $('mobile-pick-count').textContent = room.table.length;
  $('picks').replaceChildren();
  if (!room.table.length) {
    const empty = make('div', undefined, 'empty'); empty.append(make('pre', '┌───────┐  ┌───────┐\n│   +   │··│   +   │\n└───────┘  └───────┘'), make('p', 'A second opinion starts here.'), make('p', 'Open a product and show your friend.'));
    $('picks').append(empty);
  }
  for (const pick of room.table) {
    const { product, variant } = identify(pick.variantId), card = make('article', undefined, 'pick'), main = make('div', undefined, 'pick-main'), text = make('div');
    text.append(make('h3', product.name), make('small', variant.title + ' · ' + money(variant.cents, variant.currency)), make('small', 'Shared by ' + name(pick.memberId)));
    main.append(image(product), text);
    const controls = make('div', undefined, 'pick-actions');
    controls.append(button((pick.likes.includes(room.me) ? '♥ ' : '♡ ') + pick.likes.length, () => action('react', { pickId: pick.id }), 'like' + (pick.likes.includes(room.me) ? ' selected' : '')), button('Add to basket +', () => action('add', { variantId: pick.variantId })));
    if (pick.memberId === room.me) controls.append(button('Remove', () => action('unshare', { pickId: pick.id }), 'remove'));
    card.append(main, controls); $('picks').append(card);
  }
  $('basket').replaceChildren();
  if (!room.basket.length) $('basket').append(make('p', 'Nothing in the basket yet.', 'panel-intro'));
  let subtotal = 0, count = 0;
  for (const line of room.basket) {
    const { product, variant } = identify(line.variantId); subtotal += variant.cents * line.quantity; count += line.quantity;
    const row = make('div', undefined, 'basket-line'), info = make('div'), quantity = make('div', undefined, 'quantity');
    info.append(make('h3', product.name), make('p', variant.title + ' · ' + name(line.memberId)));
    const minus = button('−', () => action('quantity', { lineId: line.id, quantity: line.quantity - 1 })); minus.setAttribute('aria-label', 'Decrease ' + product.name);
    const plus = button('+', () => action('quantity', { lineId: line.id, quantity: line.quantity + 1 })); plus.setAttribute('aria-label', 'Increase ' + product.name); plus.disabled = line.quantity >= 10;
    quantity.append(minus, make('span', line.quantity), plus); info.append(quantity);
    row.append(image(product), info, make('span', money(variant.cents * line.quantity, variant.currency), 'line-price')); $('basket').append(row);
  }
  $('basket-count').textContent = count + (count === 1 ? ' item' : ' items');
  $('mobile-basket-count').textContent = count;
  $('total').textContent = money(subtotal, room.catalog[0]?.variants[0]?.currency);
  $('approval-status').replaceChildren(...room.members.map(member => {
    const approved = room.approvals.includes(member.id), row = make('div', undefined, 'approval' + (approved ? ' yes' : ''));
    row.append(make('span', approved ? '✓' : '', 'dot'), make('span', member.name + (approved ? ' is happy with this basket' : ' hasn’t approved yet'))); return row;
  }));
  $('approve').disabled = !room.basket.length || room.approvals.includes(room.me);
  $('approve').textContent = room.approvals.includes(room.me) ? '✓ You’re happy with this basket' : 'Looks good to me';
  $('checkout').disabled = room.members.length < 2 || room.approvals.length !== room.members.length || !room.basket.length;
  $('checkout').textContent = room.mode === 'sample' ? 'Finish sample checkout ↗' : 'Create Shopify cart ↗';
  $('checkout-note').textContent = 'Everyone approves. Changing the basket resets approvals.';
  $('checkout-result').replaceChildren();
  if (room.checkout) {
    const box = make('div', undefined, 'success');
    if (room.checkout.mode === 'sample') box.append(make('strong', 'Your picks, together.'), make('p', 'Sample checkout complete · ' + room.checkout.reference), make('p', 'No order or payment was created. Connect a development store in a new room to try Shopify checkout.'));
    else {
      const link = make('a', 'Open Shopify checkout ↗'); link.href = room.checkout.url; link.target = '_blank'; link.rel = 'noopener';
      box.append(make('strong', 'Your Shopify cart is ready.'), make('p', 'Review delivery, taxes, and payment securely in Shopify.'), link);
    }
    $('checkout-result').append(box);
  }
  $('activity').replaceChildren(...room.activity.map(event => make('p', event.name + ' ' + event.text)));
}
async function enter(path, name) {
  const result = await request(path, { name }, false);
  room = result.room; key = result.key; roomId = room.id;
  membershipStorage.setItem('shopping-room:' + roomId, key);
  history.replaceState(null, '', '?room=' + roomId + (guestView ? '&guest=1' : ''));
  render();
}
$('create-form').onsubmit = async event => {
  event.preventDefault(); const submit = event.submitter; submit.disabled = true;
  try { await enter('/api/rooms', $('host-name').value); } catch (error) { toast(error.message); } finally { submit.disabled = false; }
};
$('join-form').onsubmit = async event => {
  event.preventDefault(); event.submitter.disabled = true;
  try { await enter('/api/rooms/' + roomId + '/join', $('guest-name').value); $('join-dialog').close(); } catch (error) { toast(error.message); } finally { event.submitter.disabled = false; }
};
$('search').oninput = () => { search = $('search').value.trim().toLowerCase(); renderProducts(); };
$('follow').onclick = () => { setFollowing(!following); lastBrowseReceived = 0; render(); };
$('lead').onclick = async () => { setFollowing(false); await action('lead'); };
$('product-dialog').addEventListener('close', () => {
  if (closingFromLeader) { closingFromLeader = false; remoteProduct = false; shownVariant = null; return; }
  if (remoteProduct) { setFollowing(false); remoteProduct = false; render(); }
  else publishBrowse(null);
  shownVariant = null;
});
for (const view of ['browse', 'table', 'basket']) {
  $(view + '-tab').onclick = () => {
    $('room').dataset.mobileView = view;
    for (const tab of ['browse', 'table', 'basket']) $(tab + '-tab').setAttribute('aria-pressed', String(tab === view));
    window.scrollTo({ top: 0, behavior: reducedMotion ? 'instant' : 'smooth' });
  };
}
$('approve').onclick = () => action('approve'); $('checkout').onclick = () => action('checkout');
$('invite').onclick = () => { $('invite-url').value = location.origin + '/?room=' + roomId; $('guest-preview').href = location.origin + '/?room=' + roomId + '&guest=1'; $('invite-dialog').showModal(); };
$('copy-invite').onclick = async () => { try { await navigator.clipboard.writeText(location.href); toast('Invite copied.'); } catch { $('invite-url').select(); toast('Copy the selected link.'); } };
$('store-button').onclick = () => { if (!room) return toast('Start a room first, then connect your store.'); $('store-dialog').showModal(); };
$('store-form').onsubmit = async event => { event.preventDefault(); event.submitter.disabled = true; $('store-error').textContent = 'Loading collection…'; await action('connect', { domain: $('domain').value, token: $('token').value }); event.submitter.disabled = false; };
for (const close of document.querySelectorAll('[data-close]')) close.onclick = () => $(close.dataset.close).close();
if (roomId) {
  if (key) refresh(true).catch(error => { toast(error.message); setConnection(false); });
  else $('join-dialog').showModal();
}
setInterval(() => { if (!document.hidden) refresh().catch(() => setConnection(false)); }, 1200);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true).catch(() => setConnection(false)); });
window.addEventListener('offline', () => setConnection(false));
window.addEventListener('online', () => refresh(true).catch(() => setConnection(false)));
// A monochrome interference pattern, rendered in characters rather than an image.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let frame = 0;
function drawAscii() {
  const chars = ' .:+*#'; let output = '';
  for (let y = 0; y < 44; y++) {
    for (let x = 0; x < 68; x++) {
      const dx = (x - 34) / 25, dy = (y - 22) / 19;
      const radius = Math.hypot(dx, dy), wave = Math.sin(dx * 5 + frame) * Math.cos(dy * 6 - frame * .5);
      output += radius < 1.1 ? chars[Math.min(5, Math.floor(Math.abs(wave) * (1.1 - radius) * 7))] : ' ';
    }
    output += '\n';
  }
  $('ascii').textContent = output; frame += .05;
}
drawAscii();
if (!reducedMotion) setInterval(() => { if (!document.hidden && !$('landing').hidden) drawAscii(); }, 150);
