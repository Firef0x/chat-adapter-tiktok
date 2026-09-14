import type { CardChild, CardElement } from "chat";

import type { TikTokTemplatePayload } from "../types.js";
import { cardToPlainText } from "./card-to-text.js";

/**
 * Documented limits for `QA_BUTTON_CARD` templates.
 *
 * A card that exceeds any of them cannot be sent as a template at all —
 * TikTok offers no truncation behaviour, and silently cutting a button label
 * would change what the user is agreeing to.
 */
export const TEMPLATE_LIMITS = {
  minButtons: 1,
  maxButtons: 3,
  maxTitleLength: 40,
  maxButtonTitleLength: 20,
  maxButtonIdLength: 40,
} as const;

type ActionChild = Extract<CardChild, { type: "actions" }>["children"][number];

/**
 * Convert a card into a TikTok Q&A button card, or `null` if it does not fit.
 *
 * Returning `null` is the common case and not a failure: the caller falls back
 * to plain text, which can represent anything. A template is attempted only
 * when it would be strictly better — real tappable buttons instead of a
 * bulleted list — and only when nothing would be lost in the conversion.
 *
 * Note that a button's `value` and `callbackUrl` are not carried through. On
 * tap, TikTok sends the button's label as an ordinary text message and returns
 * the `id` set here as `reply_source_payload.reply_source_unique_id`; this
 * release does not route taps as actions, so only the `id` survives.
 */
export function cardToTemplate(card: CardElement): TikTokTemplatePayload | null {
  const actions = collectActions(card.children ?? []);

  // A card with no buttons is just text, and one carrying link buttons or
  // selects holds URLs and option lists a template cannot express. Falling
  // back to text keeps that information visible.
  if (actions.length === 0 || actions.some((action) => action.type !== "button")) {
    return null;
  }

  const buttons = actions
    .filter((action) => action.type === "button")
    .filter((button) => !button.disabled);

  if (
    buttons.length < TEMPLATE_LIMITS.minButtons ||
    buttons.length > TEMPLATE_LIMITS.maxButtons
  ) {
    return null;
  }

  // A hand-built card can omit `label` or `id` even though the types require
  // them, and reading `.length` off undefined would throw mid-send.
  const unusable = buttons.some(
    (button) =>
      typeof button.label !== "string" ||
      typeof button.id !== "string" ||
      button.label.length === 0 ||
      button.id.length === 0 ||
      button.label.length > TEMPLATE_LIMITS.maxButtonTitleLength ||
      button.id.length > TEMPLATE_LIMITS.maxButtonIdLength,
  );
  if (unusable) {
    return null;
  }

  const title = buildTitle(card);
  if (!title) {
    return null;
  }

  return {
    type: "QA_BUTTON_CARD",
    title,
    buttons: buttons.map((button) => ({
      type: "REPLY" as const,
      title: button.label,
      id: button.id,
    })),
  };
}

/**
 * Build the card's question from everything that is not a button.
 *
 * A template carries a single 40-character title and no body, so any card
 * whose prose does not fit there would lose text on conversion. That card
 * goes to the plain-text path instead.
 */
function buildTitle(card: CardElement): string | null {
  const remaining = stripActions(card.children ?? []);

  // Only prose can become a title. An image, divider, table, or chart would
  // otherwise be flattened into a placeholder like "[image]" and spliced into
  // the question — so those cards go to the text path, which can show them.
  if (!remaining.every(isProse)) {
    return null;
  }

  const withoutActions: CardElement = { ...card, children: remaining };

  // Newlines have no meaning in a one-line title.
  const title = cardToPlainText(withoutActions).replace(/\s+/g, " ").trim();

  if (!title || title.length > TEMPLATE_LIMITS.maxTitleLength) {
    return null;
  }
  return title;
}

/** Whether an element carries only text that a title could absorb. */
function isProse(child: CardChild): boolean {
  if (child.type === "text") {
    return true;
  }
  if (child.type === "section") {
    return child.children.every(isProse);
  }
  return false;
}

/** Gather every action, including those nested inside sections. */
function collectActions(children: CardChild[]): ActionChild[] {
  const actions: ActionChild[] = [];

  for (const child of children) {
    if (child.type === "actions") {
      actions.push(...child.children);
    } else if (child.type === "section") {
      actions.push(...collectActions(child.children));
    }
  }

  return actions;
}

/** The card with every action removed, sections included. */
function stripActions(children: CardChild[]): CardChild[] {
  const kept: CardChild[] = [];

  for (const child of children) {
    if (child.type === "actions") {
      continue;
    }
    if (child.type === "section") {
      kept.push({ ...child, children: stripActions(child.children) });
    } else {
      kept.push(child);
    }
  }

  return kept;
}
