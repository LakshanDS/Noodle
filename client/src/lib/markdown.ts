/**
 * Markdown → sanitized HTML for agent/user message bodies.
 *
 * `marked` parses GFM (tables, strikethrough, fenced code); `dompurify` strips
 * anything executable before we hand the string to `v-html` — important because
 * agent text can echo arbitrary file contents (incl. `<script>` tags). Plain
 * text falls through untouched and is rendered by the caller.
 */
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({
  gfm: true,
  breaks: true,
});

// Force every link to open in a new tab without leaking referrer/opener.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/**
 * Render a message body as sanitized HTML. Returns "" for empty input so the
 * caller's `v-if` can drop the bubble entirely.
 */
export function renderMarkdown(src: string): string {
  const text = src?.trim();
  if (!text) return "";
  const raw = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    // Keep GFM niceties; strip everything that can run or navigate away.
    ALLOWED_TAGS: [
      "p", "br", "hr", "strong", "em", "del", "s", "code", "pre", "blockquote",
      "ul", "ol", "li", "a", "h1", "h2", "h3", "h4", "h5", "h6",
      "table", "thead", "tbody", "tr", "th", "td", "img", "span", "div",
    ],
    ALLOWED_ATTR: ["href", "title", "alt", "src", "rowspan", "colspan"],
    ALLOW_DATA_ATTR: false,
  });
}
