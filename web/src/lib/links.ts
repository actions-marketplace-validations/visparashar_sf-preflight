// SPDX-License-Identifier: Apache-2.0
/**
 * Which links the viewer may fetch a file from. Kept free of browser APIs so it is tested with the
 * library.
 */

/** A host on this computer or a private network: a link must not make the viewer reach into one. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h.includes(":")) {
    // IPv6: loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10), IPv4-mapped.
    return h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:");
  }
  if (h === "localhost" || h.endsWith(".localhost") || !h.includes(".")) return true;
  if (/\.(local|internal|intranet|lan|home|corp|localdomain)$/.test(h)) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Checks a link before anything is fetched: this site's own files (the samples), or https with no
 * user name or password in it and nothing on this computer or a private network.
 */
export function checkLink(raw: string, base: string): { url: URL } | { reason: string } {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return { reason: "This isn't a valid URL." };
  }
  if (url.origin === new URL(base).origin) return { url };
  if (url.protocol !== "https:") return { reason: "Only https:// links can be opened." };
  if (url.username || url.password) return { reason: "Links with a user name or password in them can't be opened." };
  if (isPrivateHost(url.hostname)) {
    return {
      reason: "Links to this computer or a private network can't be opened. Download the file and open it instead.",
    };
  }
  return { url };
}
