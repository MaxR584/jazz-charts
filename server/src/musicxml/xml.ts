/** Tiny XML string helpers. All text and attribute values go through `esc`. */

export function esc(s: string | number): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export type Attrs = Record<string, string | number | undefined | null>;

function attrs(a?: Attrs): string {
  if (!a) return "";
  return Object.entries(a)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` ${k}="${esc(v as string | number)}"`)
    .join("");
}

/** Element with escaped text content. */
export function el(name: string, text: string | number, a?: Attrs): string {
  return `<${name}${attrs(a)}>${esc(text)}</${name}>`;
}

/** Empty element. */
export function empty(name: string, a?: Attrs): string {
  return `<${name}${attrs(a)}/>`;
}

/** Element wrapping already-built children. */
export function wrap(name: string, children: string[], a?: Attrs): string {
  return `<${name}${attrs(a)}>${children.join("")}</${name}>`;
}
