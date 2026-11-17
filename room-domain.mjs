import {ShopifyClient} from './shopify.mjs';
const randomUUID = () => crypto.randomUUID();
export function view(room, me) {
  const { members, store, ...state } = room;
  return { ...state, members: members.map(({id,name,browsing,browsedAt}) => ({id,name,browsing:browsing || null,browsedAt:browsedAt || null})), serverTime: Date.now(), me: me.id, mode: store ? 'shopify' : 'sample', storeName: store?.domain || 'Objects & Everyday' };
}
function variant(room, id) {
  for (const product of room.catalog) {
    const option = product.variants.find(v => v.id === id);
    if (option) return { product, option };
  }
  throw new Error('Product not found.');
}
export function changed(room) { room.basketVersion++; room.approvals = []; room.checkout = null; }
export function log(room, member, text) {
  room.activity.unshift({ id: randomUUID(), name: member.name, text });
  room.activity = room.activity.slice(0,20);
}
export async function update(room, member, op) {
  if (op.action !== 'browse' && op.version !== room.version) throw Object.assign(new Error('Your friend updated the room. Review the latest changes and try again.'), {status:409});
  switch (op.action) {
    case 'browse': {
      if (op.variantId !== null) variant(room, op.variantId);
      member.browsing = op.variantId;
      member.browsedAt = Date.now();
      break;
    }
    case 'lead':
      room.leaderId = member.id;
      log(room, member, 'is leading the shopping trip');
      break;
    case 'share': {
      const {product,option} = variant(room, op.variantId);
      if (room.table.length >= 8) throw new Error('Your table holds eight picks. Remove one to make room.');
      if (!room.table.some(p => p.variantId === option.id && p.memberId === member.id)) room.table.push({id:randomUUID(),memberId:member.id,variantId:option.id,likes:[]});
      log(room,member,'shared '+product.name);
      break;
    }
    case 'react': {
      const pick = room.table.find(p=>p.id===op.pickId);
      if (!pick) throw new Error('This pick was removed.');
      pick.likes = pick.likes.includes(member.id) ? pick.likes.filter(id=>id!==member.id) : [...pick.likes,member.id];
      break;
    }
    case 'unshare': room.table = room.table.filter(p=>p.id!==op.pickId || p.memberId!==member.id); break;
    case 'add': {
      const {product,option} = variant(room,op.variantId);
      if (!option.available) throw new Error('This option is sold out.');
      const line = room.basket.find(l=>l.variantId===option.id);
      if (line) line.quantity = Math.min(10,line.quantity+1);
      else room.basket.push({id:randomUUID(),variantId:option.id,memberId:member.id,quantity:1});
      changed(room); log(room,member,'added '+product.name+' to the basket'); break;
    }
    case 'quantity': {
      const line = room.basket.find(l=>l.id===op.lineId);
      if (!line || !Number.isInteger(op.quantity) || op.quantity<0 || op.quantity>10) throw new Error('Quantity must be between zero and ten.');
      if (!op.quantity) room.basket=room.basket.filter(l=>l.id!==line.id);
      else line.quantity=op.quantity;
      changed(room); break;
    }
    case 'approve':
      if (!room.basket.length) throw new Error('Add something first.');
      if (!room.approvals.includes(member.id)) room.approvals.push(member.id);
      log(room,member,'approved the basket'); break;
    case 'connect': {
      if (member.id!==room.owner) throw new Error('Only the host can connect a store.');
      if (room.table.length || room.basket.length) throw new Error('Connect a store in a new, empty room.');
      const client = new ShopifyClient(op.domain,op.token);
      const products = await client.products();
      if (!products.length) throw new Error('Publish products to this storefront first.');
      if (new Set(products.flatMap(p=>p.variants.map(v=>v.currency))).size!==1) throw new Error('Choose a single-currency collection.');
      room.catalog=products.map(p=>({...p,category:'Collection',variants:p.variants.map(v=>({...v,cents:Math.round(v.price*100)}))}));
      room.store={domain:client.domain,token:client.token};
      log(room,member,'connected Shopify'); break;
    }
    case 'checkout': {
      if (room.members.length<2 || room.members.some(m=>!room.approvals.includes(m.id))) throw new Error('Everyone in the room needs to approve the basket.');
      if (room.checkout) break;
      if (room.store) {
        const client = new ShopifyClient(room.store.domain,room.store.token);
        const fresh = (await client.products()).flatMap(p=>p.variants);
        let priceChanged=false;
        for (const line of room.basket) {
          const {option}=variant(room,line.variantId), latest=fresh.find(v=>v.id===line.variantId);
          if (!latest?.available) throw new Error('An item is unavailable. Remove it and approve the basket again.');
          const cents=Math.round(latest.price*100);
          if (cents!==option.cents) {option.cents=cents;priceChanged=true;}
        }
        if (priceChanged) {changed(room);log(room,member,'updated changed prices. Please approve again');break;}
        const cart=await client.checkout(room.basket.map(l=>({variantId:l.variantId,quantity:l.quantity})));
        room.checkout={mode:'shopify',url:cart.checkoutUrl};
      } else room.checkout={mode:'sample',reference:'DEMO-'+randomUUID().slice(0,8).toUpperCase()};
      log(room,member,'finished the checkout handoff'); break;
    }
    default: throw new Error('Unknown action.');
  }
}
