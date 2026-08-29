import { memo } from "react";
import type { Message, NativeStructurePreviewResult, NativeStructureRef } from "@fusion/core";
import { NativeStructurePreview } from "./NativeStructurePreview";

export interface MailboxNativeStructureEmbedsProps {
  message: Pick<Message, "metadata">;
  projectId?: string;
  onOpen: (ref: NativeStructureRef, payload: NativeStructurePreviewResult) => void;
}

/**
 * FNXC:NativeStructureEmbed 2026-07-20-12:00:
 * Mail message metadata is the durable home for first-class structure embeds. This thin wrapper
 * deliberately owns no preview behavior: the shared lazy resolver handles live data and missing
 * targets, while this returns no shell for ordinary mail with no structural attachment.
 */
export const MailboxNativeStructureEmbeds = memo(function MailboxNativeStructureEmbeds({
  message,
  projectId,
  onOpen,
}: MailboxNativeStructureEmbedsProps) {
  const embeds = message.metadata?.nativeStructures;
  if (!embeds?.length) return null;

  return (
    <div className="mailbox-native-structure-embeds" data-testid="mailbox-native-structure-embeds">
      {embeds.map((embed, index) => (
        <NativeStructurePreview
          key={`${embed.kind}:${embed.id}:${index}`}
          ref={{ kind: embed.kind, id: embed.id, projectId: embed.projectId ?? projectId }}
          capturedLabel={embed.label}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
});
