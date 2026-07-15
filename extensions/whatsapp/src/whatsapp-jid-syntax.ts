// Whatsapp plugin module owns dependency-free JID syntax checks.

const GROUP_LOCAL_PART_RE = /^[0-9]+(?:-[0-9]+)*$/;
const DIRECT_LOCAL_PART_RE = /^(\d+)(?::\d+)?$/;

type WhatsAppDirectJidSyntaxServer = "s.whatsapp.net" | "c.us" | "hosted" | "lid" | "hosted.lid";

const DIRECT_JID_SERVERS = new Set<WhatsAppDirectJidSyntaxServer>([
  "s.whatsapp.net",
  "c.us",
  "hosted",
  "lid",
  "hosted.lid",
]);

export function parseWhatsAppDirectJidSyntax(
  value: string | null | undefined,
): { user: string; server: WhatsAppDirectJidSyntaxServer } | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const separatorIndex = trimmed.indexOf("@");
  if (separatorIndex <= 0 || separatorIndex !== trimmed.lastIndexOf("@")) {
    return null;
  }
  const localPart = trimmed.slice(0, separatorIndex);
  const server = trimmed.slice(separatorIndex + 1).toLowerCase();
  if (!DIRECT_JID_SERVERS.has(server as WhatsAppDirectJidSyntaxServer)) {
    return null;
  }
  const match = DIRECT_LOCAL_PART_RE.exec(localPart);
  const user = match?.[1];
  if (!user) {
    return null;
  }
  return {
    user,
    server: server as WhatsAppDirectJidSyntaxServer,
  };
}

export function stripWhatsAppTargetPrefixes(value: string): string {
  let candidate = value.trim();
  for (;;) {
    const before = candidate;
    candidate = candidate.replace(/^whatsapp:/i, "").trim();
    if (candidate === before) {
      return candidate;
    }
  }
}

export function canonicalizeWhatsAppGroupJid(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const separatorIndex = trimmed.indexOf("@");
  if (separatorIndex <= 0 || separatorIndex !== trimmed.lastIndexOf("@")) {
    return null;
  }
  const localPart = trimmed.slice(0, separatorIndex);
  const server = trimmed.slice(separatorIndex + 1).toLowerCase();
  return server === "g.us" && GROUP_LOCAL_PART_RE.test(localPart) ? `${localPart}@g.us` : null;
}
