// SPDX-License-Identifier: Apache-2.0
/**
 * The few `node:path` functions the graph model uses, for the browser. Paths in reports are
 * POSIX-style and project-relative, so plain string handling is enough.
 */

function normalize(p: string): string {
  const absolute = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
    } else out.push(part);
  }
  return (absolute ? "/" : "") + out.join("/");
}

/** Joins the parts, starting again at the last absolute one. */
export function resolve(...parts: string[]): string {
  let joined = "";
  for (const part of parts) {
    if (!part) continue;
    joined = part.startsWith("/") || !joined ? part : `${joined}/${part}`;
  }
  return normalize(joined || ".");
}

export function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export const posix = { basename, resolve };

export default { basename, resolve, posix };
