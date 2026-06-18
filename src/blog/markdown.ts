// Minimal, safe Markdown -> HTML renderer.
// Security model: every source character is HTML-escaped FIRST, then a small set of
// block/inline patterns re-introduce a whitelist of safe tags. Raw HTML in the source
// is therefore never emitted as markup, and link/image URLs are protocol-checked.

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^(\/|#|\.\/|\.\.\/)/.test(trimmed)) return trimmed;
  // Anything else (javascript:, data:, etc.) is rejected.
  return "#";
}

// Inline rendering runs on already-escaped text.
function renderInline(escaped: string): string {
  let out = escaped;
  // images: ![alt](url)
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => `<img src="${escapeHtml(safeUrl(url))}" alt="${alt}">`);
  // links: [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => `<a href="${escapeHtml(safeUrl(url))}" rel="noreferrer noopener">${text}</a>`);
  // inline code: `code`
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
  // bold: **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, text: string) => `<strong>${text}</strong>`);
  // italic: *text* (avoid matching ** already consumed)
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_m, pre: string, text: string) => `${pre}<em>${text}</em>`);
  return out;
}

export function renderMarkdown(markdown: string): string {
  const escaped = escapeHtml(markdown.replace(/\r\n?/g, "\n"));
  const lines = escaped.split("\n");
  const html: string[] = [];
  let i = 0;

  const flushParagraph = (buffer: string[]): void => {
    if (buffer.length === 0) return;
    html.push(`<p>${renderInline(buffer.join(" ").trim())}</p>`);
    buffer.length = 0;
  };

  let paragraph: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block ```
    if (/^```/.test(line.trim())) {
      flushParagraph(paragraph);
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing fence
      html.push(`<pre><code>${code.join("\n")}</code></pre>`);
      continue;
    }

    // heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // horizontal rule
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph(paragraph);
      html.push("<hr>");
      i += 1;
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      flushParagraph(paragraph);
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      html.push(`<blockquote>${renderInline(quote.join(" ").trim())}</blockquote>`);
      continue;
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph(paragraph);
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*[-*]\s+/, "").trim())}</li>`);
        i += 1;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      flushParagraph(paragraph);
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*\d+\.\s+/, "").trim())}</li>`);
        i += 1;
      }
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // blank line ends a paragraph
    if (line.trim() === "") {
      flushParagraph(paragraph);
      i += 1;
      continue;
    }

    // accumulate paragraph text
    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph(paragraph);
  return html.join("\n");
}

export { escapeHtml as escapeBlogHtml };
