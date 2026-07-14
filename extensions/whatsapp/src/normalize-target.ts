// Whatsapp helper module supports normalize target behavior.
import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import { normalizeStringEntries, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { classifyWhatsAppJid, type WhatsAppJid } from "./whatsapp-jid.js";

const NON_WHATSAPP_PROVIDER_PREFIX_RE = /^[a-z][a-z0-9-]*:/i;

function stripWhatsAppTargetPrefixes(value: string): string {
  let candidate = value.trim();
  for (;;) {
    const before = candidate;
    candidate = candidate.replace(/^whatsapp:/i, "").trim();
    if (candidate === before) {
      return candidate;
    }
  }
}

function classifyWhatsAppTargetJid(value: string): WhatsAppJid {
  const candidate = stripWhatsAppTargetPrefixes(value);
  if (/^group:/i.test(candidate)) {
    const classified = classifyWhatsAppJid(candidate.replace(/^group:/i, "").trim());
    return classified.kind === "group" ? classified : { kind: "unsupported" };
  }
  return classifyWhatsAppJid(candidate);
}

export function isWhatsAppGroupJid(value: string): boolean {
  return classifyWhatsAppTargetJid(value).kind === "group";
}

export function isWhatsAppNewsletterJid(value: string): boolean {
  return classifyWhatsAppTargetJid(value).kind === "newsletter";
}

export function isWhatsAppUserTarget(value: string): boolean {
  const classified = classifyWhatsAppTargetJid(value);
  return classified.kind === "pn" || classified.kind === "lid";
}

export function normalizeWhatsAppDirectPhone(value: string): string | null {
  const candidate = stripWhatsAppTargetPrefixes(value);
  const classified = classifyWhatsAppJid(candidate);
  if (classified.kind === "pn") {
    const normalized = normalizeE164(classified.user);
    return normalized.length > 1 ? normalized : null;
  }
  if (candidate.includes("@") || NON_WHATSAPP_PROVIDER_PREFIX_RE.test(candidate)) {
    return null;
  }
  const normalized = normalizeE164(candidate);
  return normalized.length > 1 ? normalized : null;
}

export function normalizeWhatsAppTarget(value: string): string | null {
  const candidate = stripWhatsAppTargetPrefixes(value);
  if (!candidate) {
    return null;
  }
  const classified = classifyWhatsAppTargetJid(candidate);
  if (classified.kind === "unsupported") {
    return normalizeWhatsAppDirectPhone(candidate);
  }
  if (classified.kind !== "pn") {
    return classified.jid;
  }
  // Hostedness affects routing, so preserve hosted PN JIDs. Standard and
  // legacy c.us targets retain the public E.164 normalization contract.
  return classified.server === "hosted"
    ? classified.jid
    : normalizeWhatsAppDirectPhone(classified.jid);
}

export function normalizeWhatsAppMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizeWhatsAppTarget(trimmed) ?? undefined;
}

export function normalizeWhatsAppAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return uniqueStrings(
    normalizeStringEntries(allowFrom)
      .map(normalizeWhatsAppAllowFromEntry)
      .filter((entry): entry is string => Boolean(entry)),
  );
}

export function normalizeWhatsAppAllowFromEntry(entry: string): string | null {
  if (entry === "*") {
    return entry;
  }
  const normalized = normalizeWhatsAppDirectPhone(entry);
  if (!normalized) {
    return null;
  }
  return normalized.slice(1);
}

export function looksLikeWhatsAppTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  return (
    /^whatsapp:/i.test(trimmed) ||
    isWhatsAppGroupJid(trimmed) ||
    isWhatsAppNewsletterJid(trimmed) ||
    isWhatsAppUserTarget(trimmed) ||
    normalizeWhatsAppTarget(trimmed) !== null
  );
}
