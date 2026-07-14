// Whatsapp plugin module implements quoted message behavior.
import type { MiscMessageGenerationOptions } from "baileys";
import { areSameWhatsAppJid, classifyWhatsAppJid } from "./whatsapp-jid.js";

// ── Inbound message metadata cache ──────────────────────────────────────
// Retains canonical JIDs plus identity facts prepared while mapping context is
// already available, so outbound quote lookup stays a pure cache operation.

type QuotedMeta = {
  participant?: string;
  participantE164?: string;
  body?: string;
  fromMe?: boolean;
};
type CacheEntry = QuotedMeta & {
  /** Prepared direct-chat identity; mapping discovery belongs at message ingestion/send time. */
  remoteE164?: string;
  remoteJids?: string[];
  ts: number;
};
type QuotedMetaLookup = QuotedMeta & { remoteJid: string };
type QuotedMetaCandidate = QuotedMetaLookup & {
  remoteE164?: string;
  remoteJids?: string[];
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;
const cache = new Map<string, CacheEntry>();

function makeCacheKey(accountId: string, remoteJid: string, messageId: string): string {
  return `${accountId}:${remoteJid}:${messageId}`;
}

function canonicalizeSupportedJid(jid: string | null | undefined): string | undefined {
  const classified = classifyWhatsAppJid(jid);
  return classified.kind === "unsupported" ? undefined : classified.jid;
}

function canonicalizeComparableE164(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^\+\d+$/.test(trimmed) ? trimmed : undefined;
}

function directPnE164(jid: string | null | undefined): string | undefined {
  const classified = classifyWhatsAppJid(jid);
  return classified.kind === "pn" ? `+${classified.user}` : undefined;
}

function canonicalizeDirectJids(
  values: readonly string[] | null | undefined,
): string[] | undefined {
  const canonical = new Set<string>();
  for (const value of values ?? []) {
    const classified = classifyWhatsAppJid(value);
    if (classified.kind === "pn" || classified.kind === "lid") {
      canonical.add(classified.jid);
    }
  }
  return canonical.size > 0 ? [...canonical] : undefined;
}

export function cacheInboundMessageMeta(
  accountId: string,
  remoteJid: string,
  messageId: string,
  meta: QuotedMeta & { remoteE164?: string; remoteJids?: string[] },
): void {
  const canonicalRemoteJid = canonicalizeSupportedJid(remoteJid);
  if (!accountId || !messageId || !canonicalRemoteJid) {
    return;
  }
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) {
      cache.delete(oldest);
    }
  }
  cache.set(makeCacheKey(accountId, canonicalRemoteJid, messageId), {
    ...meta,
    participant: canonicalizeSupportedJid(meta.participant),
    participantE164: canonicalizeComparableE164(meta.participantE164),
    remoteE164: canonicalizeComparableE164(meta.remoteE164),
    remoteJids: canonicalizeDirectJids(meta.remoteJids),
    ts: Date.now(),
  });
}

export function lookupInboundMessageMeta(
  accountId: string,
  remoteJid: string,
  messageId: string,
): QuotedMeta | undefined {
  const canonicalRemoteJid = canonicalizeSupportedJid(remoteJid);
  if (!canonicalRemoteJid) {
    return undefined;
  }
  const cacheKey = makeCacheKey(accountId, canonicalRemoteJid, messageId);
  const entry = cache.get(cacheKey);
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(cacheKey);
    return undefined;
  }
  return {
    participant: entry.participant,
    participantE164: entry.participantE164,
    body: entry.body,
    fromMe: entry.fromMe,
  };
}

function isGroupJid(jid: string | undefined): boolean {
  return classifyWhatsAppJid(jid).kind === "group";
}

function areComparableE164sEqual(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = left?.trim();
  const normalizedRight = right?.trim();
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  return normalizedLeft === normalizedRight;
}

function matchesQuotedConversationTarget(
  targetJid: string,
  candidate: QuotedMetaCandidate,
): boolean {
  if (areSameWhatsAppJid(targetJid, candidate.remoteJid)) {
    return true;
  }
  if (isGroupJid(targetJid) || isGroupJid(candidate.remoteJid)) {
    return false;
  }
  if (candidate.remoteJids?.some((jid) => areSameWhatsAppJid(targetJid, jid))) {
    return true;
  }
  const targetE164 = directPnE164(targetJid);
  return (
    areSameWhatsAppJid(targetJid, candidate.participant) ||
    areComparableE164sEqual(targetE164, candidate.remoteE164) ||
    areComparableE164sEqual(targetE164, candidate.participantE164)
  );
}

export function lookupInboundMessageMetaForTarget(
  accountId: string,
  targetJid: string,
  messageId: string,
): QuotedMetaLookup | undefined {
  const canonicalTargetJid = canonicalizeSupportedJid(targetJid);
  if (!accountId || !messageId || !canonicalTargetJid) {
    return undefined;
  }
  const exact = lookupInboundMessageMeta(accountId, canonicalTargetJid, messageId);
  if (exact) {
    return {
      remoteJid: canonicalTargetJid,
      participant: exact.participant,
      participantE164: exact.participantE164,
      body: exact.body,
      fromMe: exact.fromMe,
    };
  }
  const prefix = `${accountId}:`;
  const suffix = `:${messageId}`;
  let matched: QuotedMetaCandidate | undefined;
  for (const [cacheKey, entry] of cache.entries()) {
    if (!cacheKey.startsWith(prefix) || !cacheKey.endsWith(suffix)) {
      continue;
    }
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      cache.delete(cacheKey);
      continue;
    }
    const remoteJid = cacheKey.slice(prefix.length, cacheKey.length - suffix.length);
    const candidate = {
      remoteJid,
      participant: entry.participant,
      participantE164: entry.participantE164,
      remoteE164: entry.remoteE164,
      remoteJids: entry.remoteJids,
      body: entry.body,
      fromMe: entry.fromMe,
    };
    if (!matchesQuotedConversationTarget(canonicalTargetJid, candidate)) {
      continue;
    }
    if (matched) {
      return undefined;
    }
    matched = candidate;
  }
  return matched
    ? {
        remoteJid: matched.remoteJid,
        participant: matched.participant,
        participantE164: matched.participantE164,
        body: matched.body,
        fromMe: matched.fromMe,
      }
    : undefined;
}

export function buildQuotedMessageOptions(params: {
  messageId?: string | null;
  remoteJid?: string | null;
  fromMe?: boolean;
  participant?: string;
  /** Original message text — shown in the quote preview bubble. */
  messageText?: string;
}): MiscMessageGenerationOptions | undefined {
  const id = params.messageId?.trim();
  const remoteJid = params.remoteJid?.trim();
  if (!id || !remoteJid) {
    return undefined;
  }
  return {
    quoted: {
      key: {
        remoteJid,
        id,
        fromMe: params.fromMe ?? false,
        participant: params.participant,
      },
      message: { conversation: params.messageText ?? "" },
    },
  } as MiscMessageGenerationOptions;
}
