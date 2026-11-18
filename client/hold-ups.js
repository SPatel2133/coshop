// Local seen state is per viewer, keyed by variant, and never sent to the server.
export class FindsState {
  constructor(seen = [], save = () => {}) {
    this.cards = new Map();
    this.seen = new Set(seen);
    this.save = save;
  }
  merge(find) {
    const old = this.cards.get(find.variantId);
    if (old && old.latestShare.sequence >= find.latestShare.sequence)
      return false;
    this.cards.set(find.variantId, find);
    return true;
  }
  snapshot(finds) {
    const present = new Set(finds.map((f) => f.variantId));
    for (const id of this.cards.keys())
      if (!present.has(id)) this.cards.delete(id);
    for (const find of finds) this.merge(find);
  }
  ordered() {
    return [...this.cards.values()].sort((a, b) => b.sequence - a.sequence);
  }
  unseen() {
    return this.ordered().filter((f) => !this.seen.has(f.variantId)).length;
  }
  markSeen(id, visible) {
    if (!visible || !this.cards.has(id) || this.seen.has(id)) return false;
    this.seen.add(id);
    this.save([...this.seen]);
    return true;
  }
}
