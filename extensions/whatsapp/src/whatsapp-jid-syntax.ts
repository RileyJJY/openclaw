// Whatsapp plugin module owns dependency-free JID syntax checks.

const GROUP_LOCAL_PART_RE = /^[0-9]+(?:-[0-9]+)*$/;

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
