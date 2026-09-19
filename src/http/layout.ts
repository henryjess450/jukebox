/** Shared page shell. Mobile-first; the stylesheet is served from /static. */
import { html, type SafeHtml } from './html.js';

export interface PageOptions {
  title: string;
  body: SafeHtml;
  /** Extra markup for <head> — inline script tags, mostly. */
  head?: SafeHtml;
  bodyClass?: string;
}

export function page({ title, body, head, bodyClass }: PageOptions): string {
  return `<!doctype html>
${html`<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark light" />
    <title>${title}</title>
    <link rel="stylesheet" href="/static/app.css" />
    ${head ?? ''}
  </head>
  <body class="${bodyClass ?? ''}">
    ${body}
  </body>
</html>`}`;
}

/** A dismissible banner. `tone` drives the colour only. */
export function notice(tone: 'ok' | 'error' | 'info', message: string): SafeHtml {
  return html`<p class="notice notice--${tone}" role="status">${message}</p>`;
}
