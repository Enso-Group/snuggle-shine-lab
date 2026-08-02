import { prettyUrl } from "./url-display";

// Decoded Hebrew URLs are usually short enough to read as one line in chat;
// beyond this we trade the readable slug for a compact short link.
const SHORT_ENOUGH_CHARS = 80;

/** Keyless TinyURL. Null on any failure — callers always keep the long URL. */
export async function shortenUrl(url: string, timeoutMs = 4000): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`,
      { signal: ctrl.signal },
    );
    if (!res.ok) return null;
    const short = (await res.text()).trim();
    return /^https?:\/\/tinyurl\.com\/[\w-]+$/.test(short) ? short : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The link a human should SEE in a message: decoded so Hebrew reads
 * naturally, shortened when even the decoded form is a wall of text. Never
 * throws — worst case returns the decoded (or original) URL.
 */
export async function formatUrlForMessage(url: string): Promise<string> {
  const decoded = prettyUrl(url);
  if (decoded.length <= SHORT_ENOUGH_CHARS) return decoded;
  return (await shortenUrl(url)) ?? decoded;
}
