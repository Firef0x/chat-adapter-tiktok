/**
 * A set that forgets its oldest entries once it gets too big.
 *
 * Used for the two things the adapter must remember across webhook
 * deliveries — which messages it has already seen, and which it sent itself.
 * Both only matter for a short window (TikTok retries within minutes), so an
 * unbounded set would be a slow memory leak in a long-lived process.
 */
export class BoundedSet {
  private readonly items = new Set<string>();

  constructor(private readonly maxSize = 1000) {}

  /**
   * Record a value.
   *
   * @returns `true` if it was newly added, `false` if already present.
   */
  add(value: string): boolean {
    if (this.items.has(value)) {
      return false;
    }

    this.items.add(value);

    if (this.items.size > this.maxSize) {
      // Set iteration is insertion-ordered, so the first key is the oldest.
      const oldest = this.items.values().next();
      if (!oldest.done) {
        this.items.delete(oldest.value);
      }
    }

    return true;
  }

  has(value: string): boolean {
    return this.items.has(value);
  }

  /**
   * Forget a value.
   *
   * Lets a caller withdraw a record it made speculatively — the adapter marks
   * a message seen before dispatching it, and must take that back if dispatch
   * fails, or TikTok's redelivery would be deduplicated away.
   *
   * @returns `true` if it was present.
   */
  delete(value: string): boolean {
    return this.items.delete(value);
  }

  get size(): number {
    return this.items.size;
  }
}
