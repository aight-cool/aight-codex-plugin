/**
 * Subset of aight-channel-plugin/utils.ts — only the helpers the Codex
 * wrapper actually uses (MIME map, filename sanitizer, rate limiter,
 * inbox cleaner). Hook-port / claim-file machinery is not needed: there's
 * exactly one Codex subprocess per wrapper instance, so we don't need
 * cross-instance coordination.
 */

import { readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
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

/**
 * Reap stale (>24h) attachments and, if still over `maxSize`, evict the
 * oldest by mtime until under cap. Ported from aight-channel-plugin to
 * keep behavior consistent across both wrappers.
 */
export function cleanInbox(inboxDir: string, maxSize: number): void {
  try {
    const files = readdirSync(inboxDir);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const kept: Array<{ path: string; mtime: number; size: number }> = [];
    let totalSize = 0;

    for (const f of files) {
      const p = join(inboxDir, f);
      try {
        const st = statSync(p);
        if (st.mtimeMs < cutoff) {
          unlinkSync(p);
          continue;
        }
        kept.push({ path: p, mtime: st.mtimeMs, size: st.size });
        totalSize += st.size;
      } catch (err) {
        console.error(`[aight-codex] Failed to stat/clean inbox file ${f}: ${err}`);
      }
    }

    if (totalSize > maxSize) {
      kept.sort((a, b) => a.mtime - b.mtime);
      for (const info of kept) {
        if (totalSize <= maxSize) break;
        try {
          unlinkSync(info.path);
          totalSize -= info.size;
          console.error(`[aight-codex] Evicted inbox file (size cap): ${info.path}`);
        } catch (err) {
          console.error(`[aight-codex] Failed to evict inbox file: ${err}`);
        }
      }
    }
  } catch {
    // inbox doesn't exist yet
  }
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
