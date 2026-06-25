// Zero-dependency allowlist HTML sanitizer for admin/AI-authored blog posts.
//
// Strategy: drop dangerous element blocks (script/style/iframe/...) WITH their
// content, then walk every remaining tag and keep only allowlisted tags and
// attributes. Unknown tags are unwrapped (tag dropped, inner text kept). URL
// attributes are protocol-checked; event handlers (on*) and javascript:/data:html
// are never emitted. This is defense-in-depth on top of the admin-only gate.

const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "blockquote", "pre", "code", "kbd", "samp",
  "strong", "b", "em", "i", "u", "s", "small", "mark", "sub", "sup", "abbr", "time",
  "a", "img", "figure", "figcaption", "picture", "source",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "div", "span", "section", "article", "header", "footer", "aside", "nav", "main", "address"
]);

const VOID_TAGS = new Set(["br", "hr", "img", "col", "source", "wbr"]);

// Elements removed together with their content.
const DANGEROUS_TAGS = ["script", "style", "iframe", "object", "embed", "template", "svg", "math", "noscript", "form", "link", "meta", "base", "title", "head"];

const GLOBAL_ATTRS = new Set(["class", "id", "title", "dir", "lang", "role", "style"]);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel", "name"]),
  img: new Set(["src", "alt", "width", "height", "loading"]),
  source: new Set(["srcset", "type", "media", "sizes"]),
  td: new Set(["colspan", "rowspan", "headers"]),
  th: new Set(["colspan", "rowspan", "headers", "scope"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  time: new Set(["datetime"]),
  abbr: new Set(["title"])
};

const URL_ATTRS = new Set(["href", "src"]);

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function safeUrl(raw: string, allowDataImage: boolean): string | null {
  const value = raw.trim();
  if (/^(https?:|mailto:|tel:)/i.test(value)) return value;
  if (/^(\/|#|\.\/|\.\.\/)/.test(value)) return value;
  if (allowDataImage && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null; // any other explicit scheme is rejected
  return value; // scheme-less relative path
}

function sanitizeSrcset(raw: string): string {
  return raw
    .split(",")
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const url = safeUrl(parts[0] ?? "", true);
      if (!url) return null;
      return [url, ...parts.slice(1)].join(" ");
    })
    .filter((value): value is string => value !== null)
    .join(", ");
}

function sanitizeStyle(raw: string): string {
  // Reject the whole declaration block if it contains a sink:
  //  - backslash → CSS hex/char escapes (e.g. `\75 rl(` decodes to `url(`) would let
  //    every check below be evaded; escapeAttr does NOT escape `\`, so the browser's CSS
  //    tokenizer sees the decoded form. Drop any escaped value rather than try to decode.
  //    (HTML-entity escapes like `&#117;` are already neutralized: escapeAttr re-encodes `&`.)
  //  - url(...) / @import  → CSS-based data exfiltration to an attacker host
  //  - position:fixed|absolute|sticky → full-page overlay / clickjacking
  //  - expression()/behavior/binding/javascript: → script execution (legacy IE / FF)
  // Blog posts authored over MCP are served with 'unsafe-inline', so inline CSS is
  // a real trust boundary even though on* handlers and dangerous tags are stripped.
  if (raw.includes("\\")) return "";
  if (/(javascript:|expression\s*\(|url\s*\(|@import|behavior\s*:|-moz-binding|position\s*:\s*(fixed|absolute|sticky))/i.test(raw)) return "";
  return raw;
}

export function sanitizeBlogCss(raw: string): string {
  if (raw.includes("\\")) return "";
  if (/(javascript:|expression\s*\(|url\s*\(|@import|behavior\s*:|-moz-binding|position\s*:\s*(fixed|absolute|sticky))/i.test(raw)) return "";
  return raw;
}

function parseAttributes(tag: string, attrString: string): string {
  const out: string[] = [];
  const attrRe = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  const tagAttrs = TAG_ATTRS[tag];
  while ((match = attrRe.exec(attrString)) !== null) {
    const name = match[1].toLowerCase();
    const rawValue = match[3] ?? match[4] ?? match[5] ?? "";
    if (name.startsWith("on")) continue; // event handlers
    const allowed = GLOBAL_ATTRS.has(name) || name.startsWith("aria-") || name.startsWith("data-") || (tagAttrs?.has(name) ?? false);
    if (!allowed) continue;

    if (name === "style") {
      const style = sanitizeStyle(rawValue);
      if (style) out.push(`style="${escapeAttr(style)}"`);
      continue;
    }
    if (name === "srcset") {
      const srcset = sanitizeSrcset(rawValue);
      if (srcset) out.push(`srcset="${escapeAttr(srcset)}"`);
      continue;
    }
    if (URL_ATTRS.has(name)) {
      const url = safeUrl(rawValue, tag === "img" || tag === "source");
      if (url === null) continue;
      out.push(`${name}="${escapeAttr(url)}"`);
      continue;
    }
    if (name === "target") {
      out.push(`target="${escapeAttr(rawValue)}" rel="noreferrer noopener"`);
      continue;
    }
    out.push(rawValue ? `${name}="${escapeAttr(rawValue)}"` : name);
  }
  return out.join(" ");
}

export function sanitizeBlogHtml(input: string): string {
  let html = input.replace(/<!--[\s\S]*?-->/g, "");

  // Remove dangerous elements together with their content (handles unclosed too).
  for (const tag of DANGEROUS_TAGS) {
    html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "");
    html = html.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), "");
    html = html.replace(new RegExp(`<\\/${tag}\\s*>`, "gi"), "");
  }

  // Walk every remaining tag; keep allowlisted ones with filtered attributes.
  return html.replace(/<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g, (_full, closing: string, rawName: string, attrString: string, selfClose: string) => {
    const name = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return ""; // unwrap unknown tag, keep inner text
    if (closing) return `</${name}>`;
    const attrs = parseAttributes(name, attrString);
    const open = attrs ? `<${name} ${attrs}` : `<${name}`;
    if (VOID_TAGS.has(name) || selfClose) return `${open}>`;
    return `${open}>`;
  });
}
