/**
 * The static HTML pages the OAuth endpoints on `{MCP}` serve themselves
 * (spec §6.3.4, §6.3.5). Everything else a person sees is on `{WEB}`.
 *
 * Fixed text only: nothing from the request is interpolated, so there is
 * nothing to escape and nothing to leak. No script, no external resource, no
 * link that carries a request id.
 */

function page(title: string, heading: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 32rem; margin: 15vh auto 0; padding: 0 16px; }
  h1 { font-size: 1.375rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 0.75rem; opacity: 0.85; }
</style>
</head>
<body>
<main>
<h1>${heading}</h1>
${body}
</main>
</body>
</html>
`;
}

/**
 * `continue` without the `__Host-assay_oar` cookie of this request: another
 * browser, a cleared cookie, or a second sign-in started in this browser.
 */
export const CONTINUE_WRONG_BROWSER_PAGE = page(
  'Finish signing in - Assay',
  'Finish this in the browser window where you started it',
  `<p>This sign-in was started in another browser window, or this browser no longer has its record of it.</p>
<p>Go back to the browser window where you started signing in, or start again from the app.</p>`,
);

/** `continue` for a request that is gone: expired (10 minutes), used, or unknown. */
export const CONTINUE_EXPIRED_PAGE = page(
  'Sign-in expired - Assay',
  'This sign-in request has expired',
  `<p>Sign-in requests last 10 minutes and can be used once.</p>
<p>Start again from the app.</p>`,
);

/** `continue` for a request nobody approved or denied. */
export const CONTINUE_UNDECIDED_PAGE = page(
  'Sign-in not finished - Assay',
  'This sign-in was not approved',
  `<p>The request was closed before anyone approved or declined it.</p>
<p>Start again from the app.</p>`,
);

/** The 429 page of `/oauth/authorize`. */
export const RATE_LIMITED_PAGE = page(
  'Too many requests - Assay',
  'Too many sign-in attempts',
  `<p>This network has started too many sign-ins in the last minute.</p>
<p>Wait a minute, then start again from the app.</p>`,
);

/** The server cannot take sign-ins now (its store or configuration is unavailable). */
export const UNAVAILABLE_PAGE = page(
  'Try again - Assay',
  'Sign-in is unavailable right now',
  `<p>Something on our side stopped this sign-in. Nothing was approved.</p>
<p>Wait a moment, then start again from the app.</p>`,
);
