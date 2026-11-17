export function normalizeDomain(value) {
  const domain = value
    .trim()
    .replace(/^https:\/\//, "")
    .replace(/\/$/, "")
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain))
    throw new Error("Enter a valid your-store.myshopify.com domain.");
  return domain;
}
export function validatePublicToken(value) {
  const token = value.trim();
  if (/^(shpat_|shpca_|shppa_|shpss_)/i.test(token))
    throw new Error(
      "Use a public Storefront token, never an Admin or private API token.",
    );
  if (!/^[a-zA-Z0-9_-]{16,256}$/.test(token))
    throw new Error("Enter your public Storefront API token.");
  return token;
}
export class ShopifyClient {
  constructor(
    domain,
    token,
    {
      apiVersion,
      country,
      fetcher = (...args) => globalThis.fetch(...args),
    } = {},
  ) {
    this.domain = normalizeDomain(domain);
    this.token = validatePublicToken(token);
    if (!/^\d{4}-(01|04|07|10)$/.test(apiVersion || ""))
      throw new Error(
        "Configure SHOPIFY_API_VERSION before connecting Shopify.",
      );
    this.apiVersion = apiVersion;
    this.country = country || "CA";
    if (!/^[A-Z]{2}$/.test(this.country))
      throw new Error("Configure a valid Shopify buyer country.");
    this.fetcher = fetcher;
  }
  async request(query, variables = {}) {
    const response = await this.fetcher(
      `https://${this.domain}/api/${this.apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": this.token,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok)
      throw new Error(
        `Shopify returned ${response.status}. Check your public token and storefront permissions.`,
      );
    const result = await response.json();
    if (result.errors?.length)
      throw new Error(result.errors.map((e) => e.message).join(" "));
    if (!result.data) throw new Error("Shopify returned no data.");
    return result.data;
  }
  async products() {
    return (await this.catalog()).products;
  }
  async catalog() {
    const data = await this.request(
      `query CoshopProducts($country: CountryCode!) @inContext(country: $country) {
        shop { name primaryDomain { host } }
        products(first:24) { nodes { id title description productType featuredImage { url altText }
          variants(first:24) { pageInfo { hasNextPage } nodes { ${variantFields} } }
        } }
      }`,
      { country: this.country },
    );
    const products = data.products.nodes
      .filter((p) => p.variants.nodes.length)
      .map((p, i) => ({
        id: p.id,
        name: p.title,
        description: p.description.slice(0, 240),
        image: p.featuredImage?.url || null,
        imageAlt: p.featuredImage?.altText || p.title,
        color: ["#c5fa6e", "#c1b6f4", "#e9e3d1"][i % 3],
        category: p.productType?.slice(0, 60).trim() || "Shopify",
        demo: false,
        variants: p.variants.nodes.map(variantDetails),
        moreVariants: p.variants.pageInfo.hasNextPage,
      }));
    return {
      products,
      name: data.shop?.name || this.domain,
      checkoutHost: data.shop?.primaryDomain?.host ?? this.domain,
    };
  }
  async variants(ids) {
    const data = await this.request(
      `query CoshopVariants($ids: [ID!]!, $country: CountryCode!) @inContext(country: $country) {
        nodes(ids: $ids) { ... on ProductVariant { ${variantFields} } }
      }`,
      { ids, country: this.country },
    );
    return new Map(
      data.nodes
        .filter((node) => node?.id)
        .map((node) => [node.id, variantDetails(node)]),
    );
  }
  async checkout(lines, attributes) {
    if (!lines.length) throw new Error("Your bag is empty.");
    if (
      lines.some(
        (l) => !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(l.variantId),
      )
    )
      throw new Error("Bag contains a demo or invalid product.");
    const data = await this.request(
      `mutation CoshopCheckout($input: CartInput!) {
        cartCreate(input: $input) {
          cart { id checkoutUrl lines(first:250) { nodes { quantity merchandise { ... on ProductVariant { id } } } }
            cost { subtotalAmount { amount currencyCode } }
          }
          userErrors { field message }
          warnings { code message target }
        }
      }`,
      {
        input: {
          buyerIdentity: { countryCode: this.country },
          ...(attributes?.length ? { attributes } : {}),
          lines: lines.map((l) => ({
            merchandiseId: l.variantId,
            quantity: l.quantity,
            ...(l.pickedBy
              ? { attributes: [{ key: "picked_by", value: l.pickedBy.name }] }
              : {}),
          })),
        },
      },
    );
    const payload = data.cartCreate;
    const issues = [...(payload.userErrors ?? []), ...(payload.warnings ?? [])];
    if (issues.length)
      throw new ShopifyCartError(
        issues.map((issue) => issue.message).join(" "),
      );
    if (!payload.cart?.checkoutUrl)
      throw new Error("Shopify could not create a checkout.");
    const requested = new Map(lines.map((l) => [l.variantId, l.quantity]));
    const actual = new Map(
      payload.cart.lines.nodes.map((l) => [l.merchandise.id, l.quantity]),
    );
    if (
      payload.cart.lines.nodes.length !== actual.size ||
      requested.size !== actual.size ||
      [...requested].some(([id, q]) => actual.get(id) !== q)
    )
      throw new ShopifyCartError(
        "Availability changed. Shopify could not include every requested item; review your bag before retrying.",
      );
    const url = new URL(payload.cart.checkoutUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      throw new Error("Invalid Shopify checkout URL.");
    return payload.cart;
  }
}

const variantFields =
  "id title availableForSale image { url } price { amount currencyCode }";
export class ShopifyCartError extends Error {}
export function moneyDetails(value) {
  const amount = String(value?.amount ?? "");
  if (
    !/^\d+(?:\.\d{1,2}0*)?$/.test(amount) ||
    !/^[A-Z]{3}$/.test(value?.currencyCode ?? "")
  )
    throw new Error("Shopify returned an unsupported price.");
  const [units, fraction = ""] = amount.split(".");
  const cents =
    Number(units) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents > 10000000000)
    throw new Error("Shopify returned a price outside the supported range.");
  return { cents, currency: value.currencyCode };
}
function variantDetails(variant) {
  const money = moneyDetails(variant.price);
  return {
    id: variant.id,
    title: variant.title,
    available: variant.availableForSale,
    image: variant.image?.url || null,
    price: money.cents / 100,
    ...money,
  };
}
