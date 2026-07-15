// Whatsapp plugin module owns canonical JID parsing and classification.
import {
  isHostedLidUser,
  isHostedPnUser,
  isJidGroup,
  isJidNewsletter,
  isLidUser,
  isPnUser,
  jidDecode,
  jidEncode,
  jidNormalizedUser,
} from "baileys";
import {
  canonicalizeWhatsAppGroupJid,
  parseWhatsAppDirectJidSyntax,
} from "./whatsapp-jid-syntax.js";

type WhatsAppJidServer = "s.whatsapp.net" | "hosted" | "lid" | "hosted.lid" | "g.us" | "newsletter";

export type WhatsAppDirectJid =
  | {
      kind: "pn";
      server: "s.whatsapp.net" | "hosted";
      user: string;
      jid: string;
    }
  | {
      kind: "lid";
      server: "lid" | "hosted.lid";
      user: string;
      jid: string;
    };

type WhatsAppRoomJid =
  | {
      kind: "group";
      server: "g.us";
      user: string;
      jid: string;
    }
  | {
      kind: "newsletter";
      server: "newsletter";
      user: string;
      jid: string;
    };

export type WhatsAppJid = WhatsAppDirectJid | WhatsAppRoomJid | { kind: "unsupported" };

const UNSUPPORTED_JID = { kind: "unsupported" } as const;
const NEWSLETTER_LOCAL_PART_RE = /^\d+$/;

function isValidLocalPart(server: string, localPart: string): boolean {
  switch (server) {
    case "s.whatsapp.net":
    case "c.us":
    case "hosted":
    case "lid":
    case "hosted.lid":
      return parseWhatsAppDirectJidSyntax(`${localPart}@${server}`) !== null;
    case "g.us":
      return canonicalizeWhatsAppGroupJid(`${localPart}@${server}`) !== null;
    case "newsletter":
      return NEWSLETTER_LOCAL_PART_RE.test(localPart);
    default:
      return false;
  }
}

function classifyCanonicalJid(jid: string): WhatsAppJid {
  const decoded = jidDecode(jid);
  const user = decoded?.user;
  if (!user) {
    return UNSUPPORTED_JID;
  }
  if (isPnUser(jid) === true) {
    return { kind: "pn", server: "s.whatsapp.net", user, jid: jidEncode(user, "s.whatsapp.net") };
  }
  if (isHostedPnUser(jid) === true) {
    return { kind: "pn", server: "hosted", user, jid: jidEncode(user, "hosted") };
  }
  if (isLidUser(jid) === true) {
    return { kind: "lid", server: "lid", user, jid: jidEncode(user, "lid") };
  }
  if (isHostedLidUser(jid) === true) {
    return { kind: "lid", server: "hosted.lid", user, jid: jidEncode(user, "hosted.lid") };
  }
  if (isJidGroup(jid) === true) {
    return { kind: "group", server: "g.us", user, jid: jidEncode(user, "g.us") };
  }
  if (isJidNewsletter(jid) === true) {
    return { kind: "newsletter", server: "newsletter", user, jid: jidEncode(user, "newsletter") };
  }
  return UNSUPPORTED_JID;
}

export function classifyWhatsAppJid(value: string | null | undefined): WhatsAppJid {
  const trimmed = value?.trim();
  if (!trimmed) {
    return UNSUPPORTED_JID;
  }
  const separatorIndex = trimmed.indexOf("@");
  if (separatorIndex <= 0 || separatorIndex !== trimmed.lastIndexOf("@")) {
    return UNSUPPORTED_JID;
  }

  const localPart = trimmed.slice(0, separatorIndex);
  const server = trimmed.slice(separatorIndex + 1).toLowerCase();
  if (!server || !isValidLocalPart(server, localPart)) {
    return UNSUPPORTED_JID;
  }

  const normalizedInput = `${localPart}@${server}`;
  const decoded = jidDecode(normalizedInput);
  if (!decoded || decoded.server !== server) {
    return UNSUPPORTED_JID;
  }

  // Validate the raw grammar before Baileys strips device/agent data so malformed
  // values cannot be laundered into an otherwise valid bare JID.
  return classifyCanonicalJid(jidNormalizedUser(normalizedInput));
}

export function encodeWhatsAppJid(user: string, server: WhatsAppJidServer): string {
  const validUser =
    server === "g.us"
      ? canonicalizeWhatsAppGroupJid(`${user}@g.us`) !== null
      : server === "newsletter"
        ? NEWSLETTER_LOCAL_PART_RE.test(user)
        : /^\d+$/.test(user);
  if (!validUser) {
    throw new Error(`Invalid WhatsApp ${server} JID user`);
  }
  const classified = classifyWhatsAppJid(jidEncode(user, server));
  if (classified.kind === "unsupported") {
    throw new Error(`Invalid WhatsApp ${server} JID user`);
  }
  return classified.jid;
}

export function isWhatsAppDirectJid(value: string | null | undefined): boolean {
  const classified = classifyWhatsAppJid(value);
  return classified.kind === "pn" || classified.kind === "lid";
}

export function areSameWhatsAppJid(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftJid = classifyWhatsAppJid(left);
  const rightJid = classifyWhatsAppJid(right);
  if (leftJid.kind === "unsupported" || rightJid.kind === "unsupported") {
    return false;
  }
  // PN and LID users with the same digits are distinct identities. Only the
  // mapping owner may establish equivalence across those classes.
  return leftJid.kind === rightJid.kind && leftJid.jid === rightJid.jid;
}
