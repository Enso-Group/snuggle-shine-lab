// Real-article retrieval for the posting engine. When a campaign/slot prompt
// references a blog URL, the post MUST be grounded in ONE actual article:
// discover the article list (RSS → sitemap → homepage links), pick one that
// was never posted to this group, fetch its page and extract the text. The
// HARD RULE lives in the caller: no specific article URL + content = NO post.
//
// Discovery order is deliberate:
//  1. RSS (/rss.xml, /feed, /feed.xml, /atom.xml) — titles+descriptions ride
//     along, newest first.
//  2. sitemap.xml — URLs only, article-looking paths filtered.
//  3. Homepage <a href> extraction — last resort for blogs with neither.
// Extraction: direct fetch first (this blog prerenders <article> statically);
// Tavily Extract as the fallback for JS-only pages.
import type { Supa } from "./types";

const FETCH_TIMEOUT_MS = 8_000;
const MIN_ARTICLE_CHARS = 300;

export type BlogArticle = {
  url: string;
  title: string | null;
  description: string | null;
  published_at: string | null;
};

export type FetchedArticle = {
  url: string;
  title: string | null;
  text: string;
};

async function fetchText(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; article-source-fetch)" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** Parse RSS/Atom items — pure, unit-tested. */
export function parseRssItems(xml: string): BlogArticle[] {
  const out: BlogArticle[] = [];
  const items = xml.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/g) ?? [];
  for (const item of items) {
    const tag = (name: string): string | null => {
      const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
      return m ? decodeEntities(m[1]) : null;
    };
    // Atom links live in <link href="..."/>.
    const atomLink = item.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? null;
    const url = tag("link") || atomLink;
    if (!url || !/^https?:\/\//.test(url)) continue;
    out.push({
      url,
      title: tag("title"),
      description: tag("description") ?? tag("summary"),
      published_at: tag("pubDate") ?? tag("published") ?? tag("updated"),
    });
  }
  return out;
}

/** Parse sitemap <loc> entries into article candidates — pure, unit-tested. */
export function parseSitemapArticles(xml: string, blogRoot: string): BlogArticle[] {
  const locs = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map((m) => decodeEntities(m[1]));
  const root = blogRoot.replace(/\/+$/, "");
  return locs
    .filter((u) => u.startsWith("http"))
    .filter((u) => {
      const path = u.replace(root, "");
      // Article-looking: nested path (e.g. /blog/<slug>), not the handful of
      // top-level site pages a sitemap always carries.
      return /\/(blog|post|article|news)\/.+/i.test(path) || /\.html?$/i.test(path);
    })
    .map((u) => ({ url: u, title: null, description: null, published_at: null }));
}

/** Extract same-host article-looking links from a homepage — pure, unit-tested. */
export function parseHomepageLinks(html: string, blogRoot: string): BlogArticle[] {
  let host: string;
  try {
    host = new URL(blogRoot).host;
  } catch {
    return [];
  }
  const out: BlogArticle[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a[^>]+href="([^"#]+)"/g)) {
    let abs: URL;
    try {
      abs = new URL(m[1], blogRoot);
    } catch {
      continue;
    }
    if (abs.host !== host) continue;
    const path = abs.pathname;
    if (!(/\/(blog|post|article|news)\/.+/i.test(path) || /\.html?$/i.test(path))) continue;
    const url = abs.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: null, description: null, published_at: null });
  }
  return out;
}

/** Strip an article page's HTML down to readable text — pure, unit-tested. */
export function extractArticleText(html: string): { title: string | null; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? null;
  const articleTag = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  const mainTag = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  const scope = articleTag ?? mainTag ?? html;
  const text = decodeEntities(
    scope
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
  return { title: title ? decodeEntities(title).trim() : null, text };
}

/**
 * Discover the blog's articles, newest first. Tries RSS endpoints, then the
 * sitemap, then homepage link extraction. Throws with a per-source trace when
 * nothing works — the caller surfaces it verbatim (hard no-post rule).
 */
export async function discoverBlogArticles(blogRoot: string): Promise<BlogArticle[]> {
  const root = blogRoot.replace(/\/+$/, "");
  const tried: string[] = [];
  for (const path of ["/rss.xml", "/feed", "/feed.xml", "/atom.xml"]) {
    const xml = await fetchText(`${root}${path}`);
    if (xml && /<(rss|feed)[\s>]/i.test(xml)) {
      const items = parseRssItems(xml);
      if (items.length) return items;
      tried.push(`${path}: feed parsed but 0 items`);
    } else tried.push(`${path}: ${xml ? "not a feed" : "unreachable"}`);
  }
  const sitemap = await fetchText(`${root}/sitemap.xml`);
  if (sitemap) {
    const items = parseSitemapArticles(sitemap, root);
    if (items.length) return items;
    tried.push("sitemap.xml: 0 article-looking URLs");
  } else tried.push("sitemap.xml: unreachable");
  const home = await fetchText(root);
  if (home) {
    const items = parseHomepageLinks(home, root);
    if (items.length) return items;
    tried.push("homepage: 0 article-looking links (JS-rendered list?)");
  } else tried.push("homepage: unreachable");
  throw new Error(`no articles discovered at ${root} — ${tried.join("; ")}`);
}

/**
 * Fetch one article's readable text. Direct fetch+parse first; Tavily
 * Extract as the JS-rendered fallback. Throws when neither yields real text.
 */
export async function fetchArticleContent(url: string): Promise<FetchedArticle> {
  const html = await fetchText(url, 10_000);
  if (html) {
    const { title, text } = extractArticleText(html);
    if (text.length >= MIN_ARTICLE_CHARS) return { url, title, text };
  }
  // JS-rendered page (or blocked fetch) — Tavily Extract renders and parses.
  const apiKey = process.env.TAVILY_API_KEY;
  if (apiKey) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch("https://api.tavily.com/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ urls: [url] }),
        signal: ctrl.signal,
      });
      if (res.ok) {
        const data = (await res.json()) as {
          results?: Array<{ url?: string; raw_content?: string }>;
        };
        const text = String(data.results?.[0]?.raw_content ?? "").trim();
        if (text.length >= MIN_ARTICLE_CHARS) return { url, title: null, text };
      }
    } catch {
      /* fall through to the throw below */
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `could not extract readable text from ${url} (direct fetch ${html ? "too thin" : "failed"}${process.env.TAVILY_API_KEY ? ", Tavily Extract failed too" : ", TAVILY_API_KEY not set for the JS-rendered fallback"})`,
  );
}

/** First http(s) URL inside a prompt — the article-mode trigger. Pure. */
export function extractSourceUrl(prompt: string | null | undefined): string | null {
  const m = String(prompt ?? "").match(/https?:\/\/[^\s"'<>)]+/);
  return m ? m[0].replace(/[.,;]+$/, "") : null;
}

/** Loose URL sameness for rotation — ignores encoding/trailing-slash noise. */
function urlKey(u: string): string {
  try {
    const parsed = new URL(u);
    return `${parsed.host}${decodeURIComponent(parsed.pathname)}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

/**
 * Pick the newest article NOT yet posted to this group (rotation), fetch its
 * content, and return it. Throws — with a reason a human can act on — when
 * discovery fails, every article was already used, or extraction fails.
 */
export async function pickFreshArticle(
  supabase: Supa,
  groupChatId: string,
  blogRoot: string,
): Promise<FetchedArticle & { discovered: number }> {
  const articles = await discoverBlogArticles(blogRoot);

  // Everything this group already posted or PICKED — URLs in bodies plus the
  // explicit engagement.article.url bookkeeping, across ALL statuses:
  // a cancelled/failed row may still represent a send that happened
  // unrecorded (live 2026-07-28, the Bluewaters double-send), so an article
  // once picked is burned for rotation purposes.
  const { data: sentRows } = await supabase
    .from("planned_posts")
    .select("body, engagement")
    .eq("group_chat_id", groupChatId)
    .order("created_at", { ascending: false })
    .limit(200);
  const used = new Set<string>();
  for (const row of sentRows ?? []) {
    for (const m of String(row.body ?? "").matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
      used.add(urlKey(m[0]));
    }
    const engagementUrl = (row.engagement as { article?: { url?: string } } | null)?.article?.url;
    if (engagementUrl) used.add(urlKey(engagementUrl));
  }

  const fresh = articles.find((a) => !used.has(urlKey(a.url)));
  if (!fresh) {
    throw new Error(
      `all ${articles.length} discovered article(s) were already posted to this group — publish new articles or clear old posts`,
    );
  }
  const fetched = await fetchArticleContent(fresh.url);
  return {
    ...fetched,
    title: fetched.title ?? fresh.title,
    discovered: articles.length,
  };
}
