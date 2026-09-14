import { describe, expect, it } from "vitest";

import { TikTokFormatConverter } from "../../src/lib/format-converter.js";

const converter = new TikTokFormatConverter();

describe("TikTokFormatConverter", () => {
  it("round-trips plain text", () => {
    expect(converter.fromAst(converter.toAst("hello world"))).toBe("hello world");
  });

  it("keeps markdown punctuation literal on inbound text", () => {
    // TikTok text is not markdown; parsing it would invent emphasis the user
    // never wrote.
    const text = "*not emphasis* and # not a heading";
    expect(converter.fromAst(converter.toAst(text))).toBe(text);
  });

  it("handles empty text without producing a stray node", () => {
    expect(converter.toAst("").children).toHaveLength(0);
    expect(converter.fromAst(converter.toAst(""))).toBe("");
  });

  it("passes a raw string through untouched", () => {
    expect(converter.renderPostable("plain")).toBe("plain");
    expect(converter.renderPostable({ raw: "as-is **kept**" })).toBe("as-is **kept**");
  });

  it("strips markdown formatting for outbound text", () => {
    expect(converter.renderPostable({ markdown: "**bold** and _italic_" })).toBe(
      "bold and italic",
    );
  });

  it("flattens an AST postable", () => {
    expect(converter.renderPostable({ ast: converter.toAst("from ast") })).toBe(
      "from ast",
    );
  });

  it("degrades a card to readable text instead of dropping it", () => {
    const card = {
      type: "card" as const,
      title: "Order status",
      children: [
        { type: "text" as const, content: "Shipped on Tuesday" },
        { type: "button" as const, id: "track", label: "Track order" },
      ],
    };

    const rendered = converter.renderPostable({ card } as never);

    expect(rendered).toContain("Order status");
    expect(rendered).toContain("Shipped on Tuesday");
  });

  it("does not crash on a card missing its children", () => {
    // A hand-built card can omit `children`; failing the send over that would
    // be worse than rendering just the title.
    const card = { type: "card" as const, title: "Bare card" };
    expect(() => converter.renderPostable({ card } as never)).not.toThrow();
    expect(converter.renderPostable({ card } as never)).toContain("Bare card");
  });
});
