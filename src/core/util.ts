import { XMLParser } from "fast-xml-parser";

/** Case-insensitive key for Salesforce API names. */
export function key(name: string): string {
  return name.toLowerCase();
}

export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

export function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function bool(value: unknown): boolean {
  return text(value)?.toLowerCase() === "true";
}

export function uniq<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

export function uniqBy<T>(items: Iterable<T>, keyFn: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const k = keyFn(item);
    if (!seen.has(k)) seen.set(k, item);
  }
  return [...seen.values()];
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 1-based line number of a character offset. */
export function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  ignoreDeclaration: true,
  parseTagValue: false,
  trimValues: true,
});

/** Parse a metadata XML document and return the root element's content. */
export function parseMetadataXml(xml: string): { root: string; body: Record<string, unknown> } {
  const doc = xmlParser.parse(xml) as Record<string, unknown>;
  const root = Object.keys(doc).find((k) => !k.startsWith("?"));
  if (!root) throw new Error("Empty XML document");
  const body = doc[root];
  return { root, body: (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown> };
}

export type XmlNode = Record<string, unknown>;

export function nodes(value: unknown): XmlNode[] {
  return asArray(value as XmlNode | XmlNode[]).filter((v): v is XmlNode => typeof v === "object" && v !== null);
}
