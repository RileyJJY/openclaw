// Whatsapp plugin module implements quoted message behavior.
import type { MiscMessageGenerationOptions } from "baileys";
import { jidToE164, type JidToE164Options } from "./text-runtime.js";
import { areSameWhatsAppJid, classifyWhatsAppJid } from "./whatsapp-jid.js";

// ── Inbound message metadata cache ──────────────────────────────────────
// Maps messageId → { participant, participantE164, body, fromMe } so the
// outbound adapter can
// populate the quote key with the sender JID and preview text even though
// the outbound path only receives a bare messageId string.

type QuotedMeta = {
  participant?: string;
  participantE164?: string;
  body?: string;
  fromMe?: boolean;
};
type CacheEntry = QuotedMeta & { ts: number };
type QuotedMetaLookup = QuotedMeta & { remoteJid: string };

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

export function cacheInboundMessageMeta(
  accountId: string,
  remoteJid: string,
  messageId: string,
  meta: QuotedMeta,
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

function areComparableJidsEqual(
  left: string | undefined,
  right: string | undefined,
  options?: JidToE164Options,
): boolean {
  if (areSameWhatsAppJid(left, right)) {
    return true;
  }
  const leftE164 = left ? jidToE164(left, options) : null;
  const rightE164 = right ? jidToE164(right, options) : null;
  return Boolean(leftE164 && rightE164 && leftE164 === rightE164);
}

function matchesQuotedConversationTarget(
  targetJid: string,
  candidate: QuotedMetaLookup,
  options?: JidToE164Options,
): boolean {
  if (areComparableJidsEqual(targetJid, candidate.remoteJid, options)) {
    return true;
  }
  if (isGroupJid(targetJid) || isGroupJid(candidate.remoteJid)) {
    return false;
  }
  return (
    areComparableJidsEqual(targetJid, candidate.participant, options) ||
    areComparableE164sEqual(jidToE164(targetJid, options) ?? undefined, candidate.participantE164)
  );
}

export function lookupInboundMessageMetaForTarget(
  accountId: string,
  targetJid: string,
  messageId: string,
  options?: JidToE164Options,
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
  let matched: QuotedMetaLookup | undefined;
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
      body: entry.body,
      fromMe: entry.fromMe,
    };
    if (!matchesQuotedConversationTarget(canonicalTargetJid, candidate, options)) {
      continue;
    }
    if (matched) {
      return undefined;
    }
    matched = candidate;
  }
  return matched;
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
