/**
 * URL validation helpers for security-sensitive inputs.
 *
 * Rules:
 * - httpUrlOnly: allow only http/https schemes
 * - graphicUrl:  httpUrlOnly OR safe data: image URIs (no svg, no text/html)
 * - srtUrl:      srt:// scheme only
 */

/**
 * Throws if the URL is not a safe http/https URL.
 */
export function httpUrlOnly(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Disallowed URL scheme "${parsed.protocol}" — only http/https allowed`);
  }
  if (!parsed.hostname) {
    throw new Error('URL must have a hostname');
  }
}

const ALLOWED_DATA_MIME = /^data:(text\/html|image\/(png|jpeg|gif|webp))[;,]/i;
const BLOCKED_SCHEMES = /^(file|javascript|ftp|gopher|chrome|about|data:application):/i;

/**
 * Throws if the value is not a safe graphic URL.
 * Accepts: http/https URLs, data:text/html (inline HTML overlays rendered by Strom's headless browser),
 *          or data:image/(png|jpeg|gif|webp) base64 URIs.
 * Rejects: file://, javascript:, data:application/*, etc.
 */
export function graphicUrl(url: string): void {
  if (BLOCKED_SCHEMES.test(url)) {
    throw new Error(`Disallowed URL scheme in graphic URL`);
  }
  if (url.startsWith('data:')) {
    if (!ALLOWED_DATA_MIME.test(url)) {
      throw new Error('Only data:text/html or data:image/(png|jpeg|gif|webp) URIs are allowed for graphics');
    }
    return;
  }
  // Otherwise must be a safe http/https URL
  httpUrlOnly(url);
}

// Strict allowlist: srt://<host>:<port>[?params] or srt://:<port>[?params] (bind all interfaces)
// Host: alphanumeric, dots, hyphens, or IPv6 bracketed address
// Port: 1–5 digits
// Query: alphanumeric and safe URL chars only — no control characters, no quotes, no backslash
const SRT_URL_RE = /^srt:\/\/(([A-Za-z0-9.\-]|\[[0-9a-fA-F:]+\])*:\d{1,5})(\?[A-Za-z0-9._\-=&%+]+)?$/;

/**
 * Throws if the value is not a valid SRT URL.
 */
export function srtUrl(url: string): void {
  if (url.length > 512) {
    throw new Error('SRT URL too long');
  }
  // Reject control characters before regex (covers CR, LF, tab, NUL, etc.)
  if (/[\x00-\x1f\x7f]/.test(url)) {
    throw new Error('Control characters not allowed in SRT URL');
  }
  if (!SRT_URL_RE.test(url)) {
    throw new Error('Invalid SRT URL format — expected srt://host:port or srt://:port with safe query params');
  }
}
