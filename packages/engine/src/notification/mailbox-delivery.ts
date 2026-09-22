import type { MessageCreateInput, Message } from "@fusion/core";

export interface MailboxDeliveryStore {
  sendMessageOnce?(input: MessageCreateInput, idempotencyKey: string): Promise<{ message: Message; inserted: boolean }>;
}

const MAILBOX_DELIVERY_TIMEOUT_MS = 5_000;

/**
 * FNXC:ExternalBlockMailbox 2026-09-22-02:24:
 * Mailbox delivery observes a durable wedge episode but never owns task lifecycle. Bound the
 * optional store call so a missing, throwing, rejecting, or stalled mailbox cannot delay recovery,
 * merge safety, or a future notification observation; late rejections remain handled.
 */
export async function deliverMailboxMessageOnce(
  store: MailboxDeliveryStore | undefined,
  input: MessageCreateInput,
  idempotencyKey: string,
  timeoutMs = MAILBOX_DELIVERY_TIMEOUT_MS,
): Promise<"delivered" | "unavailable"> {
  if (!store?.sendMessageOnce) return "unavailable";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const delivery = Promise.resolve().then(() => store.sendMessageOnce!(input, idempotencyKey));
    // Attach a handler immediately so a timed-out late rejection never escapes.
    void delivery.catch(() => undefined);
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(1, timeoutMs));
      timer.unref?.();
    });
    const outcome = await Promise.race([delivery.then(() => "delivered" as const, () => "unavailable" as const), timedOut]);
    return outcome === "delivered" ? "delivered" : "unavailable";
  } catch {
    return "unavailable";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
