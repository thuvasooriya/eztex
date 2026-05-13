# eztex Pages Redirect

This directory is a minimal Cloudflare Pages project that redirects `eztex.pages.dev` to the unified Worker at `https://eztex.thuva.workers.dev`.

## Files

- `_redirects` is the primary redirect configuration used by Cloudflare Pages.
- `index.html` is only a fallback if `_redirects` is not applied, such as when opening the files locally.

## Redirect Rules

```text
/ https://eztex.thuva.workers.dev/ 302
/* https://eztex.thuva.workers.dev/:splat 302
```

Examples:

- `https://eztex.pages.dev/` -> `https://eztex.thuva.workers.dev/`
- `https://eztex.pages.dev/c/room-id` -> `https://eztex.thuva.workers.dev/c/room-id`
- `https://eztex.pages.dev/formats/xelatex.fmt` -> `https://eztex.thuva.workers.dev/formats/xelatex.fmt`

## Deploy With Drag And Drop

1. Open the Cloudflare dashboard.
2. Go to Workers & Pages.
3. Create a Pages project or open the existing `eztex` Pages project.
4. Use Direct Upload / Upload assets.
5. Upload the contents of this directory, not the directory wrapper itself.

The uploaded root should contain `_redirects` and `index.html`.

## Deploy With Git

Set the Pages project build settings to use this directory as the deploy output.

- Build command: leave empty or use a no-op command.
- Build output directory: `pages-redirect`

## Status Code

The current rules use `302` so the redirect is easy to change while testing. After the Worker URL is final, you can switch both rules to `301` for a permanent redirect.

## Caveats

- Cloudflare Pages `_redirects` cannot match on query parameters, but normal path redirects work with splats.
- URL fragments such as `#token` are never sent to Cloudflare. Browsers generally preserve fragments across redirects when the `Location` header has no fragment, but the server-side `_redirects` file cannot inspect or rewrite them.
- The fallback `index.html` explicitly preserves path, query string, and hash if it is served.
