// Forces HTML artifacts to render in light mode regardless of what the model emits.
// Injected into the iframe srcDoc so dashboards can never come out dark.
//
// Strategy:
//  - Pin color-scheme to light (affects form controls + UA default surfaces).
//  - Force a white page background + dark text as the base.
//  - Neutralize dark *gray-family* surface utilities (Tailwind 700–950 + black).
//    The attribute-substring selectors also match `dark:bg-gray-900` style classes,
//    so OS-dark `dark:` variants are flattened too. Colored accents (blue/green/etc.)
//    are intentionally left untouched.

const FORCE_LIGHT_SNIPPET = `<meta name="color-scheme" content="light">
<style id="faborch-force-light">
  :root, html { color-scheme: light !important; }
  html, body { background-color: #ffffff !important; color: #1f2937 !important; }
  .dark { color-scheme: light !important; }
  [class*="bg-gray-7"],[class*="bg-gray-8"],[class*="bg-gray-9"],
  [class*="bg-slate-7"],[class*="bg-slate-8"],[class*="bg-slate-9"],
  [class*="bg-zinc-7"],[class*="bg-zinc-8"],[class*="bg-zinc-9"],
  [class*="bg-neutral-7"],[class*="bg-neutral-8"],[class*="bg-neutral-9"],
  [class*="bg-stone-7"],[class*="bg-stone-8"],[class*="bg-stone-9"],
  [class*="bg-black"] { background-color: #ffffff !important; }
</style>`;

/**
 * Inject light-mode enforcement into an HTML artifact string.
 * Handles full documents (inserts before </head> or after <body>) and
 * partial/streaming fragments (prepends).
 */
export function enforceLightHtml(html: string): string {
  if (!html) return html;
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${FORCE_LIGHT_SNIPPET}</head>`);
  }
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body[^>]*>/i, (m) => `${m}${FORCE_LIGHT_SNIPPET}`);
  }
  return `${FORCE_LIGHT_SNIPPET}${html}`;
}
