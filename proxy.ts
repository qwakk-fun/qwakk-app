import { NextResponse, type NextRequest } from "next/server";
import {
  TokenBucketLimiter,
  clientIpFromHeaders,
  rateLimitEnabled,
  rateLimitRuleFor,
  rateLimitedResponse,
  trustedProxyHops,
} from "./lib/qwakk-rate-limit";

/**
 * Runs before every page and API route (vinext supports the Next.js 16 root
 * `proxy.ts`). It rate limits the API per client IP and sets security headers.
 */

const limiter = new TokenBucketLimiter({ maxKeys: 50_000 });

/** Headers for every response. */
const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), browsing-topics=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  // Ignored by browsers over plain http, so local runs are unaffected.
  "Strict-Transport-Security": "max-age=15552000",
};

/** API responses are JSON only: nothing may run, load or frame them. */
const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/**
 * Page CSP. Scripts must come from this origin or carry the per-request nonce
 * (vinext reads it from the request CSP header and stamps every inline
 * bootstrap script). The QoreX extension injects its provider as
 * `<script src="chrome-extension://.../dist/inpage.js">` (moz-extension in
 * Firefox), so the extension schemes are allowed for scripts. Styles allow
 * inline because React style attributes and the self-hosted font CSS are
 * inline. Every image, font and API call is same-origin.
 */
function pageCsp(nonce: string) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' chrome-extension: moz-extension:`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function createNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function withHeaders<T extends Response>(response: T, extra: Record<string, string>): T {
  for (const [name, value] of Object.entries({ ...BASE_HEADERS, ...extra })) response.headers.set(name, value);
  return response;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/api/")) {
    const rule = rateLimitEnabled() ? rateLimitRuleFor(pathname) : null;
    if (rule) {
      const client = clientIpFromHeaders(request.headers, trustedProxyHops());
      const decision = limiter.take(`${rule.name}|${client}`, rule.budget);
      if (!decision.allowed) return withHeaders(rateLimitedResponse(decision), { "Content-Security-Policy": API_CSP });
    }
    return withHeaders(NextResponse.next(), { "Content-Security-Policy": API_CSP });
  }

  // The Vite dev server injects its own inline HMR scripts without a nonce.
  if (process.env.NODE_ENV === "development") return withHeaders(NextResponse.next(), {});

  const csp = pageCsp(createNonce());
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", csp);
  return withHeaders(NextResponse.next({ request: { headers: requestHeaders } }), { "Content-Security-Policy": csp });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
