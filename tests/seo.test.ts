import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBlogIndexHead, buildBlogPostHead, buildHomepageSeoTags, buildRobotsTxt, buildSitemapXml, injectHeadHtml } from "../src/http/seo.js";

test("buildSitemapXml emits a valid urlset with loc/lastmod/priority", () => {
  const xml = buildSitemapXml([
    { loc: "https://example.test/", priority: "1.0", changefreq: "weekly" },
    { loc: "https://example.test/blog/hello", lastmod: "2026-06-27T00:00:00.000Z", priority: "0.6" }
  ]);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(xml, /<loc>https:\/\/example\.test\/blog\/hello<\/loc>/);
  assert.match(xml, /<lastmod>2026-06-27T00:00:00\.000Z<\/lastmod>/);
});

test("buildSitemapXml escapes ampersands in URLs", () => {
  const xml = buildSitemapXml([{ loc: "https://example.test/x?a=1&b=2" }]);
  assert.match(xml, /a=1&amp;b=2/);
  assert.doesNotMatch(xml, /a=1&b=2/);
});

test("buildRobotsTxt lists disallows and points to the sitemap", () => {
  const txt = buildRobotsTxt("https://example.test/sitemap.xml", ["/admin", "/outcome"]);
  assert.match(txt, /User-agent: \*/);
  assert.match(txt, /Disallow: \/admin/);
  assert.match(txt, /Disallow: \/outcome/);
  assert.match(txt, /Sitemap: https:\/\/example\.test\/sitemap\.xml/);
});

test("buildBlogPostHead emits canonical, OG article, Twitter card, and BlogPosting JSON-LD", () => {
  const head = buildBlogPostHead({
    title: "Hello World",
    description: "A first post",
    url: "https://example.test/blog/hello-world",
    imageUrl: "https://cdn.test/cover.png",
    publishedAt: "2026-06-27T10:00:00.000Z",
    modifiedAt: "2026-06-27T11:00:00.000Z",
    siteName: "My Blog"
  });
  assert.match(head, /<link rel="canonical" href="https:\/\/example\.test\/blog\/hello-world">/);
  assert.match(head, /<meta property="og:type" content="article">/);
  assert.match(head, /<meta property="og:title" content="Hello World">/);
  assert.match(head, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(head, /<meta property="article:published_time" content="2026-06-27T10:00:00\.000Z">/);
  const ld = head.match(/<script type="application\/ld\+json">(.+?)<\/script>/);
  assert.ok(ld, "expected a JSON-LD script");
  const data = JSON.parse(ld![1]);
  assert.equal(data["@type"], "BlogPosting");
  assert.equal(data.headline, "Hello World");
  assert.equal(data.datePublished, "2026-06-27T10:00:00.000Z");
});

test("buildBlogPostHead uses summary card when there is no image", () => {
  const head = buildBlogPostHead({ title: "No Image", url: "https://example.test/blog/x" });
  assert.match(head, /<meta name="twitter:card" content="summary">/);
  assert.doesNotMatch(head, /og:image/);
});

test("JSON-LD escapes a closing script tag so it cannot break out", () => {
  const head = buildBlogPostHead({ title: "x</script><script>alert(1)</script>", url: "https://example.test/blog/x" });
  assert.doesNotMatch(head, /<\/script><script>alert/);
  assert.match(head, /\\u003c\/script>/);
});

test("buildBlogIndexHead emits website OG but stays script-free (no JSON-LD on the index)", () => {
  const head = buildBlogIndexHead({ title: "My Blog", url: "https://example.test/blog/" });
  assert.match(head, /<meta property="og:type" content="website">/);
  assert.doesNotMatch(head, /<script/);
});

test("buildHomepageSeoTags injects only what the author omitted", () => {
  const bare = "<html><head><title>Home</title></head><body>hi</body></html>";
  const tags = buildHomepageSeoTags(bare, { title: "Acme", description: "We build things", url: "https://acme.test/" });
  assert.match(tags, /<link rel="canonical" href="https:\/\/acme\.test\/">/);
  assert.match(tags, /<meta property="og:title" content="Acme">/);
  assert.match(tags, /"@type":"WebSite"/);

  const authored = `<html><head><link rel="canonical" href="https://acme.test/"><meta property="og:title" content="Mine"><script type="application/ld+json">{}</script></head><body></body></html>`;
  assert.equal(buildHomepageSeoTags(authored, { title: "Acme", url: "https://acme.test/" }), "", "author tags must win — inject nothing");
});

test("injectHeadHtml inserts before </head>, or prepends when there is no head", () => {
  assert.match(injectHeadHtml("<head></head>", "<meta x>"), /<meta x>\n<\/head>/);
  assert.match(injectHeadHtml("<body>x</body>", "<meta x>"), /^<meta x>\n<body>/);
  assert.equal(injectHeadHtml("<head></head>", ""), "<head></head>");
});
