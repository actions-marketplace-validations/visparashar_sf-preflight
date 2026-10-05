// SPDX-License-Identifier: Apache-2.0
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

const EMAIL_LOCAL = /[A-Za-z0-9._%+-]/;
const EMAIL_DOMAIN = /[A-Za-z0-9.-]/;

/**
 * Replace email addresses (Salesforce usernames look like them) with "<username>". Scans from
 * each "@" instead of using one regular expression, so the time stays linear in the input.
 */
export function redactEmails(text: string): string {
  let out = "";
  let copied = 0;
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    let start = at;
    while (start > copied && EMAIL_LOCAL.test(text[start - 1]!)) start--;
    let end = at + 1;
    while (end < text.length && EMAIL_DOMAIN.test(text[end]!)) end++;
    while (end > at + 1 && text[end - 1] === ".") end--; // a sentence's full stop isn't part of it
    const domain = text.slice(at + 1, end);
    if (start === at || !domain.includes(".") || domain.startsWith(".") || domain.includes("..")) continue;
    out += `${text.slice(copied, start)}<username>`;
    copied = end;
    at = end - 1;
  }
  return out + text.slice(copied);
}
