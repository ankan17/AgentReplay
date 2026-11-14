import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted, undefined dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .filter((k) => v[k] !== undefined)
          .map((k) => [k, v[k]]),
      );
    }
    return v;
  });
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function hashValue(value: unknown): string {
  return sha256(canonicalJson(value ?? null));
}
