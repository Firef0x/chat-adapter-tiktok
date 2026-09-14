import type { CardElement } from "chat";
import { describe, expect, it } from "vitest";

import { cardToTemplate, TEMPLATE_LIMITS } from "../../src/lib/template.js";

function buttons(count: number, label = "Yes") {
  return Array.from({ length: count }, (_, i) => ({
    type: "button" as const,
    id: `btn_${i}`,
    label: `${label} ${i}`,
  }));
}

function card(
  title: string | undefined,
  actionChildren: ReturnType<typeof buttons>,
  extra: Partial<CardElement> = {},
): CardElement {
  return {
    type: "card",
    title,
    children: [{ type: "actions", children: actionChildren }],
    ...extra,
  };
}

describe("cardToTemplate", () => {
  it("converts a short question with buttons into a Q&A button card", () => {
    const template = cardToTemplate(card("How can we help?", buttons(2)));

    expect(template).toEqual({
      type: "QA_BUTTON_CARD",
      title: "How can we help?",
      buttons: [
        { type: "REPLY", title: "Yes 0", id: "btn_0" },
        { type: "REPLY", title: "Yes 1", id: "btn_1" },
      ],
    });
  });

  it("uses the flat shape the send endpoint expects, not the webhook shape", () => {
    // The webhook nests buttons under `elements`; the send request does not.
    const template = cardToTemplate(card("Pick", buttons(1)));
    expect(template).not.toHaveProperty("elements");
    expect(template?.buttons[0]).toHaveProperty("title");
    expect(template?.buttons[0]).not.toHaveProperty("text");
  });

  it("accepts the documented button-count bounds", () => {
    expect(cardToTemplate(card("Q", buttons(TEMPLATE_LIMITS.minButtons)))).not.toBeNull();
    expect(cardToTemplate(card("Q", buttons(TEMPLATE_LIMITS.maxButtons)))).not.toBeNull();
  });

  it("declines a card with no buttons", () => {
    expect(cardToTemplate(card("Just a question", []))).toBeNull();
  });

  it("declines more buttons than TikTok allows", () => {
    expect(cardToTemplate(card("Q", buttons(TEMPLATE_LIMITS.maxButtons + 1)))).toBeNull();
  });

  it("declines an over-long button label rather than truncating it", () => {
    // Truncating would change what the user believes they are agreeing to.
    const long = [
      {
        type: "button" as const,
        id: "b",
        label: "x".repeat(TEMPLATE_LIMITS.maxButtonTitleLength + 1),
      },
    ];
    expect(cardToTemplate(card("Q", long))).toBeNull();
  });

  it("declines an over-long button id", () => {
    const long = [
      {
        type: "button" as const,
        id: "x".repeat(TEMPLATE_LIMITS.maxButtonIdLength + 1),
        label: "Ok",
      },
    ];
    expect(cardToTemplate(card("Q", long))).toBeNull();
  });

  it("declines a question longer than the title limit", () => {
    expect(
      cardToTemplate(card("x".repeat(TEMPLATE_LIMITS.maxTitleLength + 1), buttons(1))),
    ).toBeNull();
  });

  it("declines a card whose body text would not survive the conversion", () => {
    // A template has a title and no body, so long prose must go to text.
    const withBody = card("Short title", buttons(1), {
      children: [
        { type: "text", content: "y".repeat(80) },
        { type: "actions", children: buttons(1) },
      ],
    });
    expect(cardToTemplate(withBody)).toBeNull();
  });

  it("declines a card with a link button, so the URL is not lost", () => {
    const withLink = card("Q", []) as CardElement;
    withLink.children = [
      {
        type: "actions",
        children: [
          { type: "button", id: "a", label: "Ok" },
          { type: "link-button", label: "Docs", url: "https://example.com" },
        ],
      },
    ];
    expect(cardToTemplate(withLink)).toBeNull();
  });

  it("declines a card with a select, so the options are not lost", () => {
    const withSelect = card("Q", []) as CardElement;
    withSelect.children = [
      {
        type: "actions",
        children: [
          {
            type: "select",
            id: "s",
            label: "Size",
            options: [{ type: "option", label: "S", value: "s" }],
          },
        ],
      },
    ];
    expect(cardToTemplate(withSelect)).toBeNull();
  });

  it("ignores disabled buttons when counting", () => {
    const mixed = card("Q", []) as CardElement;
    mixed.children = [
      {
        type: "actions",
        children: [
          { type: "button", id: "a", label: "Live" },
          { type: "button", id: "b", label: "Dead", disabled: true },
        ],
      },
    ];

    const template = cardToTemplate(mixed);
    expect(template?.buttons).toHaveLength(1);
    expect(template?.buttons[0]?.title).toBe("Live");
  });

  it("declines when every button is disabled", () => {
    const allDisabled = card("Q", []) as CardElement;
    allDisabled.children = [
      {
        type: "actions",
        children: [{ type: "button", id: "a", label: "Dead", disabled: true }],
      },
    ];
    expect(cardToTemplate(allDisabled)).toBeNull();
  });

  it("finds buttons nested inside a section", () => {
    const nested: CardElement = {
      type: "card",
      title: "Nested",
      children: [
        {
          type: "section",
          children: [{ type: "actions", children: buttons(1) }],
        },
      ],
    };
    expect(cardToTemplate(nested)?.buttons).toHaveLength(1);
  });

  it("collapses newlines in the title, since it renders on one line", () => {
    const multi: CardElement = {
      type: "card",
      title: "Line one",
      subtitle: "Line two",
      children: [{ type: "actions", children: buttons(1) }],
    };
    expect(cardToTemplate(multi)?.title).toBe("Line one Line two");
  });

  it("declines a card with buttons but no question text", () => {
    expect(cardToTemplate(card(undefined, buttons(1)))).toBeNull();
  });

  it("declines a card with an image, so no placeholder leaks into the title", () => {
    // Flattening would otherwise splice "[image: Chart]" into the question.
    const withImage: CardElement = {
      type: "card",
      title: "Look",
      children: [
        { type: "image", url: "https://x/y.png", alt: "Chart" },
        { type: "actions", children: buttons(1) },
      ],
    };
    expect(cardToTemplate(withImage)).toBeNull();
  });

  it("declines a card with a divider or table rather than mangling the title", () => {
    for (const child of [
      { type: "divider" as const },
      { type: "table" as const, headers: ["a"], rows: [["1"]] },
    ]) {
      const withBlock: CardElement = {
        type: "card",
        title: "Look",
        children: [child, { type: "actions", children: buttons(1) }],
      };
      expect(cardToTemplate(withBlock)).toBeNull();
    }
  });

  it("declines a button missing its label or id instead of throwing", () => {
    for (const bad of [
      { type: "button" as const, id: "a" } as never,
      { type: "button" as const, label: "Ok" } as never,
    ]) {
      const broken: CardElement = {
        type: "card",
        title: "Q",
        children: [{ type: "actions", children: [bad] }],
      };
      expect(() => cardToTemplate(broken)).not.toThrow();
      expect(cardToTemplate(broken)).toBeNull();
    }
  });

  it("survives a card with no children", () => {
    expect(() => cardToTemplate({ type: "card", title: "Bare" } as CardElement)).not.toThrow();
    expect(cardToTemplate({ type: "card", title: "Bare" } as CardElement)).toBeNull();
  });
});
