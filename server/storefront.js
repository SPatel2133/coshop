import { ShopifyClient } from "../shopify.mjs";

export class Storefront {
  constructor(config, clock = Date.now, client = null) {
    this.clock = clock;
    this.configurationIssue = !config.domain && !config.token && !client
      ? "missing"
      : null;
    if (this.configurationIssue) return;
    try {
      this.client =
        client ?? new ShopifyClient(config.domain, config.token, config);
      this.key = this.client.domain + ":" + this.client.country;
    } catch {
      this.configurationIssue = "invalid";
    }
  }
  async load() {
    if (!this.client || this.failedUntil > this.clock()) return null;
    if (this.saved?.expiresAt > this.clock()) return this.saved;
    this.pending ??= this.refresh();
    return this.pending;
  }
  async refresh() {
    try {
      const catalog = await this.client.catalog();
      if (!catalog.products.length) throw new Error("No published products");
      this.saved = {
        ...catalog,
        country: this.client.country,
        expiresAt: this.clock() + 60000,
      };
      return this.saved;
    } catch {
      this.failedUntil = this.clock() + 10000;
      return null;
    } finally {
      this.pending = null;
    }
  }
}

export class RoomStorefronts {
  constructor(store, provider, sample, clock) {
    Object.assign(this, {
      store,
      provider,
      clock,
      sample: { mode: "sample", products: sample },
    });
    this.cache = new Map();
  }
  get(room) {
    const row = this.store.all(
      "SELECT * FROM room_storefronts WHERE room_id=?",
      room,
    )[0];
    if (!row) return this.sample;
    const cached = this.cache.get(room);
    if (cached?.catalog === row.catalog && cached.bag_checks === row.bag_checks)
      return cached.value;
    const value = {
      ...JSON.parse(row.catalog),
      mode: "shopify",
      key: row.store_key,
      checks: JSON.parse(row.bag_checks),
    };
    this.cache.set(room, { ...row, value });
    return value;
  }
  create(room, catalog) {
    if (catalog)
      this.store.run(
        "INSERT INTO room_storefronts(room_id,store_key,catalog) VALUES(?,?,?)",
        room,
        this.provider.key,
        JSON.stringify(catalog),
      );
  }
  async refresh(room, current, allowed) {
    if (
      current.mode !== "shopify" ||
      current.expiresAt > this.clock() ||
      current.key !== this.provider.key
    )
      return;
    const catalog = await this.provider.load();
    if (catalog && allowed() && catalog.expiresAt > this.get(room).expiresAt)
      this.store.run(
        "UPDATE room_storefronts SET catalog=? WHERE room_id=? AND store_key=?",
        JSON.stringify(catalog),
        room,
        current.key,
      );
  }
  enabled(room) {
    const current = this.get(room);
    return current.mode === "shopify" && current.key === this.provider.key;
  }
  public(room) {
    const current = this.get(room);
    if (current.mode !== "shopify") return { mode: "sample" };
    const { products, name, country, expiresAt } = current;
    return {
      products,
      name,
      country,
      expiresAt,
      mode: "shopify",
      checkoutEnabled: current.key === this.provider.key,
    };
  }
}
