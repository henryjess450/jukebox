/**
 * Minimal server-side templating: a tagged template literal that escapes every
 * interpolation by default. Values wrapped in `raw()` pass through — used only
 * for nested templates we produced ourselves.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

/** Marker for already-safe HTML. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(stringify).join('');
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += stringify(values[i]) + (strings[i + 1] ?? '');
  }
  return new SafeHtml(out);
}

/** Serialize a value for embedding in a <script> block without breaking out. */
export function jsonForScript(value: unknown): SafeHtml {
  return raw(JSON.stringify(value).replace(/</g, '\\u003c'));
}
