import type { CardElement } from "chat";
import { describe, expect, it } from "vitest";

import { cardToPlainText } from "../../src/lib/card-to-text.js";

function card(overrides: Partial<CardElement> = {}): CardElement {
  return { type: "card", children: [], ...overrides };
}

describe("cardToPlainText", () => {
  it("renders title and subtitle without markdown markers", () => {
    // TikTok has no markdown, so `*Title*` would display the asterisks.
    const text = cardToPlainText(card({ title: "Order status", subtitle: "#1234" }));
    expect(text).toBe("Order status\n#1234");
    expect(text).not.toContain("*");
  });

  it("keeps buttons visible", () => {
    // The shared fallback helper drops `actions` entirely; on a platform that
    // cannot draw buttons that leaves the user with no options at all.
    const text = cardToPlainText(
      card({
        title: "Pick one",
        children: [
          {
            type: "actions",
            children: [
              { type: "button", id: "yes", label: "Yes please" },
              { type: "button", id: "no", label: "No thanks" },
            ],
          },
        ],
      }),
    );

    expect(text).toContain("Yes please");
    expect(text).toContain("No thanks");
  });

  it("omits disabled buttons rather than offering a dead choice", () => {
    const text = cardToPlainText(
      card({
        children: [
          {
            type: "actions",
            children: [
              { type: "button", id: "ok", label: "Available" },
              { type: "button", id: "no", label: "Unavailable", disabled: true },
            ],
          },
        ],
      }),
    );

    expect(text).toContain("Available");
    expect(text).not.toContain("Unavailable");
  });

  it("includes the URL of a link button", () => {
    const text = cardToPlainText(
      card({
        children: [
          {
            type: "actions",
            children: [
              {
                type: "link-button",
                label: "Track",
                url: "https://example.com/t/1",
              },
            ],
          },
        ],
      }),
    );

    expect(text).toContain("Track (https://example.com/t/1)");
  });

  it("lists select options under their label", () => {
    const text = cardToPlainText(
      card({
        children: [
          {
            type: "actions",
            children: [
              {
                type: "select",
                id: "size",
                label: "Size",
                options: [
                  { type: "option", label: "Small", value: "s" },
                  { type: "option", label: "Large", value: "l" },
                ],
              },
            ],
          },
        ],
      }),
    );

    expect(text).toContain("Size:");
    expect(text).toContain("Small");
    expect(text).toContain("Large");
  });

  it("renders text, links, fields, and dividers", () => {
    const text = cardToPlainText(
      card({
        children: [
          { type: "text", content: "Shipped Tuesday" },
          { type: "link", label: "Receipt", url: "https://example.com/r" },
          {
            type: "fields",
            children: [{ type: "field", label: "Total", value: "$42" }],
          },
          { type: "divider" },
        ],
      }),
    );

    expect(text).toContain("Shipped Tuesday");
    expect(text).toContain("Receipt (https://example.com/r)");
    expect(text).toContain("Total: $42");
    expect(text).toContain("---");
  });

  it("flattens nested sections", () => {
    const text = cardToPlainText(
      card({
        children: [
          {
            type: "section",
            children: [{ type: "text", content: "Nested line" }],
          },
        ],
      }),
    );

    expect(text).toContain("Nested line");
  });

  it("names an image instead of rendering nothing", () => {
    expect(
      cardToPlainText(
        card({ children: [{ type: "image", url: "https://x/y.png", alt: "Receipt" }] }),
      ),
    ).toContain("[image: Receipt]");
  });

  it("survives a card with no children", () => {
    // Hand-built cards can omit it, and throwing would fail the send.
    const bare = { type: "card", title: "Bare" } as CardElement;
    expect(() => cardToPlainText(bare)).not.toThrow();
    expect(cardToPlainText(bare)).toBe("Bare");
  });

  it("returns an empty string for a wholly empty card", () => {
    expect(cardToPlainText(card())).toBe("");
  });

  it("drops empty sections instead of leaving blank lines", () => {
    const text = cardToPlainText(
      card({
        title: "Title",
        children: [
          { type: "section", children: [] },
          { type: "text", content: "Body" },
        ],
      }),
    );

    expect(text).toBe("Title\nBody");
  });
});

describe("cardToPlainText — elements the review found untested", () => {
  it("prefixes each option with a bullet so a list reads as a list", () => {
    // The whole module exists to make options readable as choices. Asserting
    // with `toContain("Yes please")` holds with or without the bullet, so the
    // exact string is what pins it.
    const text = cardToPlainText(
      card({
        children: [
          {
            type: "actions",
            children: [{ type: "button", label: "Yes please", value: "yes" }],
          },
        ],
      } as never),
    );

    expect(text).toContain("• Yes please");
  });

  it("renders a radio select the same way as a plain select", () => {
    // Both share one arm; only `select` was exercised, so the shared path
    // could stop handling `radio_select` unnoticed.
    const text = cardToPlainText(
      card({
        children: [
          {
            type: "actions",
            children: [
              {
                type: "radio_select",
                label: "Size",
                options: [
                  { label: "Small", value: "s" },
                  { label: "Large", value: "l" },
                ],
              },
            ],
          },
        ],
      } as never),
    );

    expect(text).toContain("Size:");
    expect(text).toContain("• Small");
    expect(text).toContain("• Large");
  });

  it("renders a table rather than dropping it", () => {
    const text = cardToPlainText(
      card({
        children: [
          {
            type: "table",
            headers: ["Item", "Price"],
            rows: [["Coffee", "$3"]],
          },
        ],
      } as never),
    );

    expect(text).toContain("Item");
    expect(text).toContain("Coffee");
    expect(text).toContain("$3");
  });

  it("names a chart instead of leaving a silent gap", () => {
    // TikTok cannot render one, so the reader needs to know something visual
    // was meant to be there.
    const text = cardToPlainText(card({ children: [{ type: "chart" }] } as never));

    expect(text).toContain("[chart]");
  });

  it("omits a disabled button rather than offering an untakeable choice", () => {
    const text = cardToPlainText(
      card({
        children: [
          {
            type: "actions",
            children: [
              { type: "button", label: "Available", value: "a" },
              { type: "button", label: "Sold out", value: "b", disabled: true },
            ],
          },
        ],
      } as never),
    );

    expect(text).toContain("• Available");
    expect(text).not.toContain("Sold out");
  });
});
