import { cardToFallbackText, extractCard } from "@chat-adapter/shared";
import type { AdapterPostableMessage, FormattedContent } from "chat";
import { markdownToPlainText, toPlainText } from "chat";

/**
 * Converts between Chat SDK content and TikTok's wire format.
 *
 * TikTok direct messages carry plain text and nothing else — no markdown, no
 * entities, no attachments on a text message. Everything richer has to
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
      // `cardToFallbackText` iterates `children` unguarded. A card assembled
      // by hand rather than through the JSX helpers can omit it, and a
      // TypeError here would fail the send rather than degrade it.
      return cardToFallbackText(
        Array.isArray(card.children) ? card : { ...card, children: [] },
      );
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
