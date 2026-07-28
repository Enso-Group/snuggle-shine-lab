// Pure-parser coverage for the blog-article retrieval layer: RSS items,
// sitemap filtering, homepage link extraction, article-text stripping and
// the article-mode trigger (URL in a prompt).
import { describe, expect, it } from "vitest";
import {
  extractArticleText,
  extractSourceUrl,
  parseHomepageLinks,
  parseRssItems,
  parseSitemapArticles,
} from "../article-source.server";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>בלוג</title>
  <item>
    <title>תוכניות תשלום בדובאי: המדריך</title>
    <link>https://blog.example.com/blog/%D7%AA%D7%95%D7%9B%D7%A0%D7%99%D7%95%D7%AA-abc.html</link>
    <description>מדריך מלא על תוכניות תשלום</description>
    <pubDate>Thu, 23 Jul 2026 08:03:06 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[מאמר שני]]></title>
    <link>https://blog.example.com/blog/second.html</link>
  </item>
  <item><title>no link — dropped</title></item>
</channel></rss>`;

describe("parseRssItems", () => {
  it("maps items with links, decodes CDATA, drops linkless ones", () => {
    const items = parseRssItems(RSS);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("תוכניות תשלום בדובאי: המדריך");
    expect(items[0].url).toContain("https://blog.example.com/blog/");
    expect(items[0].description).toBe("מדריך מלא על תוכניות תשלום");
    expect(items[0].published_at).toContain("2026");
    expect(items[1].title).toBe("מאמר שני");
  });
  it("returns [] for non-feed input", () => {
    expect(parseRssItems("<html>nope</html>")).toEqual([]);
  });
});

describe("parseSitemapArticles", () => {
  it("keeps only article-looking paths", () => {
    const xml = `<urlset>
      <url><loc>https://blog.example.com/</loc></url>
      <url><loc>https://blog.example.com/authors</loc></url>
      <url><loc>https://blog.example.com/blog/my-post.html</loc></url>
      <url><loc>https://blog.example.com/blog/another-post</loc></url>
    </urlset>`;
    const items = parseSitemapArticles(xml, "https://blog.example.com/");
    expect(items.map((i) => i.url)).toEqual([
      "https://blog.example.com/blog/my-post.html",
      "https://blog.example.com/blog/another-post",
    ]);
  });
});

describe("parseHomepageLinks", () => {
  it("extracts same-host article links, resolves relative, dedups", () => {
    const html = `
      <a href="/blog/one.html">1</a>
      <a href="https://blog.example.com/blog/two">2</a>
      <a href="https://blog.example.com/blog/two">dup</a>
      <a href="https://other.com/blog/three">off-host</a>
      <a href="/about">not an article</a>`;
    const items = parseHomepageLinks(html, "https://blog.example.com");
    expect(items.map((i) => i.url)).toEqual([
      "https://blog.example.com/blog/one.html",
      "https://blog.example.com/blog/two",
    ]);
  });
});

describe("extractArticleText", () => {
  it("prefers <article> scope and strips markup", () => {
    const html = `<html><head><title>המדריך | בלוג</title>
      <script>var junk=1;</script></head>
      <body><nav>תפריט ניווט</nav>
      <article><h1>המדריך</h1><p>פסקה ראשונה עם תוכן אמיתי.</p><p>עוד פסקה.</p></article>
      </body></html>`;
    const { title, text } = extractArticleText(html);
    expect(title).toBe("המדריך | בלוג");
    expect(text).toContain("פסקה ראשונה עם תוכן אמיתי");
    expect(text).not.toContain("תפריט ניווט");
    expect(text).not.toContain("junk");
  });
});

describe("extractSourceUrl", () => {
  it("finds the first URL in a campaign prompt", () => {
    expect(
      extractSourceUrl("כל פוסט חייב לבחור מאמר מ-https://blog.glidaiproperties.com/ ולסכם אותו"),
    ).toBe("https://blog.glidaiproperties.com/");
    expect(extractSourceUrl('סתם פוסט על נדל"ן')).toBeNull();
    expect(extractSourceUrl(null)).toBeNull();
  });
});
