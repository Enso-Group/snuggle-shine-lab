// ---------------------------------------------------------------------------
// Human-readable URLs for WhatsApp messages.
//
// Hebrew article slugs arrive percent-encoded from RSS/sitemaps
// (%D7%94%D7%A9…) and render in chat as many lines of gibberish. prettyUrl()
// decodes them back to Hebrew so the link reads naturally; the async
// shortener for still-long links lives in url-display.server.ts.
// ---------------------------------------------------------------------------

/**
 * Decoded, chat-friendly form of a URL. Reserved characters (?#&=/) stay
 * encoded so the URL keeps working; whitespace and quote-like characters are
 * re-encoded so WhatsApp's linkifier doesn't cut the link short. A malformed
 * escape sequence returns the input untouched.
 */
export function prettyUrl(url: string): string {
  const raw = String(url ?? "").trim();
  if (!/%[0-9a-f]{2}/i.test(raw)) return raw;
  try {
    return decodeURI(raw).replace(/[\s"'<>`]/g, (c) => encodeURIComponent(c));
  } catch {
    return raw;
  }
}
