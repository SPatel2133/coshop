export class MessageHistory {
  constructor() {
    this.entries = new Map();
    this.hasEarlier = false;
    this.loaded = false;
    this.draft = "";
    this.edit = 0;
    this.stale = true;
    this.top = null;
  }
  ordered() {
    return [...this.entries.values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
  }
  add(entry) {
    if (this.entries.has(entry.id)) return false;
    this.entries.set(entry.id, entry);
    return true;
  }
  page(page, earlier) {
    const overlap =
      this.loaded &&
      page.entries.some(
        (entry) =>
          this.entries.has(entry.id) &&
          entry.sequence <= (this.resumeThrough ?? Infinity),
      );
    if (!earlier && !overlap && page.entries.length) {
      const oldest = page.entries[0].sequence;
      for (const [id, entry] of this.entries)
        if (entry.sequence < oldest) this.entries.delete(id);
    }
    if (
      earlier ||
      !overlap ||
      this.ordered()[0]?.sequence >= page.entries[0]?.sequence
    )
      this.hasEarlier = page.hasEarlier;
    for (const entry of page.entries) this.add(entry);
    this.loaded = true;
    if (!earlier) this.resumeThrough = undefined;
  }
}
