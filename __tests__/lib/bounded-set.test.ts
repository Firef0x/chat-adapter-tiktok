import { describe, expect, it } from "vitest";

import { BoundedSet } from "../../src/lib/bounded-set.js";

describe("BoundedSet", () => {
  it("reports whether a value was newly added", () => {
    // The adapter uses this return value to recognize a webhook redelivery,
    // so "already present" and "just recorded" must not read the same.
    const set = new BoundedSet(4);

    expect(set.add("a")).toBe(true);
    expect(set.add("a")).toBe(false);
    expect(set.size).toBe(1);
  });

  it("evicts the oldest entry once it is over its limit, and only then", () => {
    const set = new BoundedSet(3);
    for (const value of ["a", "b", "c"]) {
      set.add(value);
    }

    // Exactly at the limit: nothing has been forgotten yet.
    expect(set.size).toBe(3);
    expect(set.has("a")).toBe(true);

    set.add("d");

    expect(set.size).toBe(3);
    expect(set.has("a")).toBe(false);
    expect(set.has("d")).toBe(true);
  });

  it("forgets a value on request", () => {
    // The adapter records a message as seen before dispatching it and has to
    // withdraw that if dispatch fails, or TikTok's redelivery is deduplicated
    // away and the message is lost.
    const set = new BoundedSet(4);
    set.add("a");

    expect(set.delete("a")).toBe(true);
    expect(set.has("a")).toBe(false);
    expect(set.delete("a")).toBe(false);
    expect(set.size).toBe(0);
  });

  it("defaults to a window long enough to cover TikTok's retries", () => {
    // The default is what every adapter actually runs with, and a small one
    // would let a redelivery arrive after its ID had already been evicted.
    const set = new BoundedSet();
    for (let i = 0; i < 1000; i += 1) {
      set.add(`m_${i}`);
    }

    expect(set.size).toBe(1000);
    expect(set.has("m_0")).toBe(true);

    set.add("m_1000");

    expect(set.size).toBe(1000);
    expect(set.has("m_0")).toBe(false);
  });
});
