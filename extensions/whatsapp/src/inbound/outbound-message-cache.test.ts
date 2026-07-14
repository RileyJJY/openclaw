// Whatsapp tests cover native outbound message metadata recording.
import type { proto, WAMessage } from "baileys";
import { describe, expect, it, vi } from "vitest";
import { lookupInboundMessageMetaForTarget } from "../quoted-message.js";
import { createWhatsAppOutboundMessageRecorder } from "./outbound-message-cache.js";

describe("WhatsApp outbound message recorder", () => {
  it("retains the prepared PN identity when a send is routed through a LID", () => {
    const rememberBaileysMessage = vi.fn();
    const recorder = createWhatsAppOutboundMessageRecorder({
      accountId: "mapped-send",
      rememberBaileysMessage,
    });
    const message = { conversation: "sent through LID" } satisfies proto.IMessage;

    recorder.remember("277038292303944@lid", { key: { id: "sent-1" }, message } as WAMessage, {
      remoteE164: "+15551230000",
      remoteJids: ["15551230000@s.whatsapp.net", "277038292303944@lid"],
    });

    expect(
      lookupInboundMessageMetaForTarget("mapped-send", "15551230000@s.whatsapp.net", "sent-1"),
    ).toEqual({
      remoteJid: "277038292303944@lid",
      participant: undefined,
      participantE164: undefined,
      body: "sent through LID",
      fromMe: true,
    });
    expect(rememberBaileysMessage).toHaveBeenCalledWith("277038292303944@lid", "sent-1", message);
  });
});
