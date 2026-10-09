// SPDX-License-Identifier: Apache-2.0
/**
 * Checks an evidence pack's digest in the browser: SHA-256 (Web Crypto) over the library's own
 * canonical JSON, so the result is the same as `preflight evidence --verify`.
 */
import { canonicalJson } from "../../../src/core/evidence.js";

export interface DigestCheck {
  /** The digest the pack carries. */
  recorded?: string;
  /** The digest of the pack's content, computed here. */
  computed: string;
  matches: boolean;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Recomputes the digest of a parsed evidence pack (every field but `digest`). */
export async function checkDigest(pack: object): Promise<DigestCheck> {
  const { digest, ...rest } = pack as Record<string, unknown>;
  const d = typeof digest === "object" && digest !== null ? (digest as { algorithm?: unknown; value?: unknown }) : {};
  const recorded = d.algorithm === "sha256" && typeof d.value === "string" ? d.value : undefined;
  const computed = await sha256Hex(canonicalJson(rest));
  return { ...(recorded ? { recorded } : {}), computed, matches: recorded === computed };
}
