export const API_VERSION='2026-10';
export function normalizeDomain(value){
  const domain=value.trim().replace(/^https:\/\//,'').replace(/\/$/,'').toLowerCase();
  if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain))throw new Error('Enter a valid your-store.myshopify.com domain.');
  return domain;
}
export function validatePublicToken(value){
  const token=value.trim();
  if(/^(shpat_|shpca_|shppa_|shpss_)/i.test(token))throw new Error('Use a public Storefront token, never an Admin or private API token.');
  if(!/^[a-zA-Z0-9_-]{16,256}$/.test(token))throw new Error('Enter your public Storefront API token.');
  return token;
}
export class ShopifyClient {
  constructor(domain,token,{fetcher=(...args)=>globalThis.fetch(...args)}={}){this.domain=normalizeDomain(domain);this.token=validatePublicToken(token);this.fetcher=fetcher;}
  async request(query,variables={}){
    const response=await this.fetcher(`https://${this.domain}/api/${API_VERSION}/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Storefront-Access-Token':this.token},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(`Shopify returned ${response.status}. Check your public token and storefront permissions.`);
    const result=await response.json();
    if(result.errors?.length)throw new Error(result.errors.map(e=>e.message).join(' '));
    if(!result.data)throw new Error('Shopify returned no data.');
    return result.data;
  }
  async products(){
    const data=await this.request(`query TabulateProducts { products(first:12) { nodes { id title description featuredImage { url altText } variants(first:100) { pageInfo { hasNextPage } nodes { id title availableForSale price { amount currencyCode } } } } } }`);
    return data.products.nodes.filter(p=>p.variants.nodes.length).map((p,i)=>({
      id:p.id,name:p.title,description:p.description.slice(0,110),image:p.featuredImage?.url||null,imageAlt:p.featuredImage?.altText||p.title,
      color:['#c5fa6e','#c1b6f4','#e9e3d1'][i%3],category:'SHOPIFY COLLECTION',demo:false,
      variants:p.variants.nodes.map(v=>({id:v.id,title:v.title,available:v.availableForSale,price:Number(v.price.amount),currency:v.price.currencyCode})),
      moreVariants:p.variants.pageInfo.hasNextPage
    }));
  }
  async checkout(lines){
    if(!lines.length)throw new Error('Your bag is empty.');
    if(lines.some(l=>!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(l.variantId)))throw new Error('Bag contains a demo or invalid product.');
    const data=await this.request(`mutation TabulateCheckout($input:CartInput!) { cartCreate(input:$input) { cart { id checkoutUrl totalQuantity lines(first:250) { nodes { quantity merchandise { ... on ProductVariant { id } } } } cost { subtotalAmount { amount currencyCode } } } userErrors { field message } } }`,{input:{lines:lines.map(l=>({merchandiseId:l.variantId,quantity:l.quantity}))}});
    const payload=data.cartCreate;
    if(payload.userErrors?.length)throw new Error(payload.userErrors.map(e=>e.message).join(' '));
    if(!payload.cart?.checkoutUrl)throw new Error('Shopify could not create a checkout.');
    const requested=new Map(lines.map(l=>[l.variantId,l.quantity]));
    const actual=new Map(payload.cart.lines.nodes.map(l=>[l.merchandise.id,l.quantity]));
    if(requested.size!==actual.size||[...requested].some(([id,q])=>actual.get(id)!==q))throw new Error('Availability changed. Shopify could not include every requested item; review your bag before retrying.');
    const url=new URL(payload.cart.checkoutUrl);
    if(url.protocol!=='https:')throw new Error('Invalid Shopify checkout URL.');
    return payload.cart;
  }
}
