import { renderGfmTable } from "@chat-adapter/shared";
import type { CardChild, CardElement } from "chat";

/** Prefix for each interactive option, so choices read as a list. */
const OPTION_BULLET = "• ";

/**
 * Flatten a card to plain text.
 *
 * Reached only when a card cannot be sent as a native Q&A button card, so the
 * buttons genuinely have to survive as words here.
 *
 * `cardToFallbackText` from `@chat-adapter/shared` is deliberately not used,
 * for two reasons:
 *
 * 1. It wraps the title in `*asterisks*`. Platforms that render mrkdwn show
 *    that as bold; TikTok shows the asterisks themselves.
 * 2. It renders `actions` as `null`, dropping every button — which turns
 *    "Pick one:" into a question with no visible options, the failure mode the
 *    design calls out as unacceptable.
 */
export function cardToPlainText(card: CardElement): string {
  const parts: string[] = [];

  if (card.title) {
    parts.push(card.title);
  }
  if (card.subtitle) {
    parts.push(card.subtitle);
  }

  for (const child of card.children ?? []) {
    const text = childToPlainText(child);
    if (text) {
      parts.push(text);
    }
  }

  return parts.join("\n");
}

function childToPlainText(child: CardChild): string | null {
  switch (child.type) {
    case "text":
      return child.content || null;

    case "link":
      return `${child.label} (${child.url})`;

    case "fields":
      return joinNonEmpty(child.children.map((field) => `${field.label}: ${field.value}`));

    case "section":
      return joinNonEmpty(child.children.map(childToPlainText));

    case "actions":
      return joinNonEmpty(child.children.map(actionToPlainText));

    case "table":
      return renderGfmTable(child).join("\n");

    case "divider":
      return "---";

    case "image":
      // Named so the reader knows something visual was meant to be here.
      return child.alt ? `[image: ${child.alt}]` : "[image]";

    case "chart":
      return "[chart]";

    default:
      return null;
  }
}

type ActionChild = Extract<CardChild, { type: "actions" }>["children"][number];

/**
 * Render one interactive element as a readable option.
 *
 * Disabled buttons are omitted: offering a choice the user cannot take is
 * worse than not listing it, since TikTok cannot show the disabled state.
 */
function actionToPlainText(action: ActionChild): string | null {
  switch (action.type) {
    case "button":
      return action.disabled ? null : `${OPTION_BULLET}${action.label}`;

    case "link-button":
      return `${OPTION_BULLET}${action.label} (${action.url})`;

    case "select":
    case "radio_select": {
      const options = action.options.map((option) => `${OPTION_BULLET}${option.label}`);
      return joinNonEmpty([`${action.label}:`, ...options]);
    }

    default:
      return null;
  }
}

function joinNonEmpty(values: Array<string | null>): string | null {
  const kept = values.filter((value): value is string => Boolean(value));
  return kept.length > 0 ? kept.join("\n") : null;
}
