// A text rendering of the HTML alternative, never the rendered document.
// Mail arrives as HTML often enough that storing only `parsed.text` would lose
// the body of an HTML-only message, and this conversion is structural: it
// removes markup and resolves entities. It reads no words for meaning.
// Unknown named entities stay literal, and the untouched HTML remains in the
// archived raw MIME.
export function emailHtmlText(html: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "")
    .replace(/<br\b[^>]*>|<\/(?:p|div|li|tr|h[1-6])\s*>/giu, "\n")
    .replace(/<[^>]*>/gu, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (entity: string, value: string) => {
      const key = value.toLowerCase();
      if (!key.startsWith("#")) return named[key]!;
      const point = key.startsWith("#x") ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
      return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
    });
}
