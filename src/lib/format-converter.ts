import { extractCard } from "@chat-adapter/shared";
import type { AdapterPostableMessage, FormattedContent } from "chat";
import { markdownToPlainText, toPlainText } from "chat";

import { cardToPlainText } from "./card-to-text.js";

/**
 * Converts between Chat SDK content and TikTok's wire format.
 *
 * This is the fallback path. A card that fits TikTok's Q&A button card is sent
 * as a native template instead (see `template.ts`); everything else arrives
 * here, where a TikTok message carries plain text and nothing else — no
 * markdown, no entities, no attachments. Content richer than that has to
 * degrade to something a person can still read, rather than being dropped.
 */
export class TikTokFormatConverter {
  /**
   * Wrap inbound TikTok text as formatted content.
   *
   * The text is treated as literal, not parsed as markdown: a user who types
   * `*hello*` or `# 1` means those characters, and parsing would silently
   * turn them into emphasis or a heading.
   */
  toAst(text: string): FormattedContent {
    if (!text) {
      return { type: "root", children: [] };
    }

    return {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: text }] }],
    };
  }

  /** Flatten formatted content down to what TikTok can carry. */
  fromAst(ast: FormattedContent): string {
    return toPlainText(ast);
  }

  /**
   * Render any postable message to plain text.
   *
   * Cards become their text fallback, so buttons and fields stay visible as
   * words instead of vanishing on a platform that cannot draw them.
   */
  renderPostable(message: AdapterPostableMessage): string {
    const card = extractCard(message);
    if (card) {
      return cardToPlainText(card);
    }

    if (typeof message === "string") {
      return message;
    }

    if ("raw" in message && typeof message.raw === "string") {
      return message.raw;
    }

    if ("markdown" in message && typeof message.markdown === "string") {
      return markdownToPlainText(message.markdown);
    }

    if ("ast" in message && message.ast) {
      return toPlainText(message.ast);
    }

    return "";
  }
}
