// Whatsapp plugin module records metadata for accepted native sends.
import type { proto, WAMessage } from "baileys";
import { cacheInboundMessageMeta } from "../quoted-message.js";
import { rememberRecentOutboundMessage } from "./dedupe.js";
import { extractText } from "./extract.js";
import type { WhatsAppPreparedOutboundIdentity } from "./send-api.js";

export function createWhatsAppOutboundMessageRecorder(params: {
  accountId: string;
  rememberBaileysMessage: (
    remoteJid: string,
    messageId: string,
    message: proto.IMessage | null | undefined,
  ) => void;
}) {
  const remember = (
    remoteJid: string,
    result: unknown,
    identity?: WhatsAppPreparedOutboundIdentity,
  ) => {
    const messageId =
      typeof result === "object" && result && "key" in result
        ? ((result as { key?: { id?: string } }).key?.id ?? "")
        : "";
    if (!messageId) {
      return;
    }
    rememberRecentOutboundMessage({
      accountId: params.accountId,
      remoteJid,
      messageId,
    });
    const message =
      typeof result === "object" && result && "message" in result
        ? (result as { message?: proto.IMessage }).message
        : undefined;
    params.rememberBaileysMessage(remoteJid, messageId, message);
    // Baileys derives the participant for fromMe quotes from its own userJid.
    // Retain only the facts needed to avoid the cache-miss fromMe=false fallback.
    cacheInboundMessageMeta(params.accountId, remoteJid, messageId, {
      fromMe: true,
      remoteE164: identity?.remoteE164,
      remoteJids: identity?.remoteJids,
      body: extractText(message ?? undefined),
    });
  };

  const trackLateAccepted = (
    jid: string,
    promise: Promise<WAMessage | undefined>,
    identity?: WhatsAppPreparedOutboundIdentity,
  ) => {
    // The local send has failed terminally, but Baileys may still deliver it.
    // Track a late message id only to suppress the resulting self-echo.
    void promise.then(
      (result) => {
        remember(jid, result, identity);
      },
      () => {},
    );
  };

  return { remember, trackLateAccepted } as const;
}
