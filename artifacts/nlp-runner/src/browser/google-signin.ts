/**
 * Google sign-in detection helpers.
 *
 * Google blocks sign-in from headless/automated Chrome ("this browser or app
 * may not be secure"), but a visible headful Chrome window is accepted. Chrome
 * cannot flip from headless to headful mid-flight, so the browser mode has to
 * be decided at launch time. These helpers let the CLI force a headful launch
 * whenever the task is a sign-in/sign-up with Google — either because the
 * natural-language query says so, or because the starting URL is a Google
 * sign-in page.
 */

/** True when the task/query text describes a sign-in or sign-up with Google. */
export function mentionsGoogleSignIn(text: string): boolean {
  const t = text.toLowerCase();
  if (!/google/.test(t)) return false;
  return /(sign\s*[- ]?in|log\s*[- ]?in|log\s*[- ]?on|sign\s*[- ]?up|signin|signup|login|register|oauth|authenticat|authoriz|continue\s+with)/.test(
    t,
  );
}

/** True when the URL points at a Google sign-in / OAuth page. */
export function isGoogleSignInUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === "accounts.google.com" || host === "accounts.google.cn") {
      return true;
    }
    if (host === "myaccount.google.com" || host === "myaccount.google.cn") {
      return true;
    }
    if (
      host.endsWith("google.com") ||
      host.endsWith("google.cn")
    ) {
      return /^\/(signin|o\/oauth2|accounts\/|service\/auth|v3\/signin)/i.test(
        u.pathname,
      );
    }
    return /accounts\.google\.(com|cn)/i.test(host + u.pathname);
  } catch {
    // Malformed URLs are handled textually.
    return /accounts\.google\.(com|cn)|google\.(com|cn)\/(signin|o\/oauth2)/i.test(
      url,
    );
  }
}

/**
 * Combined detection used at launch time. A Google sign-in is "involved" when
 * either the query mentions it or the starting URL is a Google sign-in page.
 */
export function detectGoogleSignIn(opts: {
  query?: string;
  url?: string;
}): boolean {
  if (opts.query && mentionsGoogleSignIn(opts.query)) return true;
  if (opts.url && isGoogleSignInUrl(opts.url)) return true;
  return false;
}
