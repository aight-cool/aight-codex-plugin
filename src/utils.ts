/**
 * Subset of aight-channel-plugin/utils.ts — only the helpers the Codex
 * wrapper actually uses (MIME map, filename sanitizer, rate limiter).
 * Hook-port / claim-file machinery is not needed: there's exactly one
 * Codex subprocess per wrapper instance, so we don't need cross-instance
 * coordination.
 */

import { LIMITS } from "./protocol";

export const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
};

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export interface RateLimiter {
  allow(now?: number): boolean;
}

export function createRateLimiter(
  maxPerMinute = LIMITS.MAX_MESSAGES_PER_MINUTE,
): RateLimiter {
  let timestamps: number[] = [];
  return {
    allow(now?: number): boolean {
      const t = now ?? Date.now();
      const windowStart = t - 60_000;
      timestamps = timestamps.filter((ts) => ts > windowStart);
      if (timestamps.length >= maxPerMinute) return false;
      timestamps.push(t);
      return true;
    },
  };
}
