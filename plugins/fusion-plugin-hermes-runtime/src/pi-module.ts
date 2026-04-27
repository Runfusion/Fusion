import { randomUUID } from "node:crypto";
import {
  getModel,
  streamSimple,
  type Api,
  type AssistantMessageEvent,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
} from "@mariozechner/pi-ai";
import type {
  HermesCallbacks,
  HermesStreamSession,
  ResolvedModelConfig,
} from "./types.js";

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL_ID = "claude-sonnet-4-5";

function resolveStringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function resolveModelConfig(settings?: Record<string, unknown>): ResolvedModelConfig {
  const provider =
    resolveStringSetting(settings?.provider) ?? resolveStringSetting(process.env.HERMES_PROVIDER) ?? DEFAULT_PROVIDER;
  const modelId =
    resolveStringSetting(settings?.modelId) ?? resolveStringSetting(process.env.HERMES_MODEL_ID) ?? DEFAULT_MODEL_ID;
  const apiKey = resolveStringSetting(settings?.apiKey) ?? resolveStringSetting(process.env.HERMES_API_KEY);
  const thinkingLevel =
    resolveStringSetting(settings?.thinkingLevel) ?? resolveStringSetting(process.env.HERMES_THINKING_LEVEL) ?? undefined;

  return { provider, modelId, apiKey, thinkingLevel };
}

export function createStreamSession(options: {
  provider: string;
  modelId: string;
  apiKey?: string;
  thinkingLevel?: string;
  systemPrompt: string;
  callbacks?: HermesCallbacks;
}): HermesStreamSession {
  const model = getModel(options.provider as never, options.modelId as never) as Model<Api>;

  return {
    model,
    systemPrompt: options.systemPrompt,
    messages: [],
    apiKey: options.apiKey,
    thinkingLevel: options.thinkingLevel,
    sessionId: randomUUID(),
    lastModelDescription: `${model.provider}/${model.id}`,
    callbacks: options.callbacks ?? {},
    usage: undefined,
    dispose: () => undefined,
  };
}

export async function streamPrompt(session: HermesStreamSession, _userMessage: Message): Promise<void> {
  const context: Context = {
    systemPrompt: session.systemPrompt,
    messages: [...(session.messages as Message[])],
  };

  const options: SimpleStreamOptions = {
    sessionId: session.sessionId,
  };

  if (session.apiKey) {
    options.apiKey = session.apiKey;
  }

  if (session.thinkingLevel) {
    options.reasoning = session.thinkingLevel as ThinkingLevel;
  }

  const stream = streamSimple(session.model as Model<Api>, context, options);

  let fullText = "";
  for await (const event of stream) {
    handleStreamEvent(event, session, (delta) => {
      fullText += delta;
    });
  }

  const finalMessage = await stream.result();
  const responseText =
    finalMessage.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("") || fullText;

  session.messages.push({ role: "assistant", content: responseText });
  session.lastModelDescription = `${(session.model as Model<Api>).provider}/${(session.model as Model<Api>).id}`;
}

function handleStreamEvent(
  event: AssistantMessageEvent,
  session: HermesStreamSession,
  onTextDelta: (delta: string) => void,
): void {
  if (event.type === "text_delta") {
    session.callbacks.onText?.(event.delta);
    onTextDelta(event.delta);
    return;
  }

  if (event.type === "thinking_delta") {
    session.callbacks.onThinking?.(event.delta);
    return;
  }

  if (event.type === "toolcall_end") {
    session.callbacks.onToolStart?.(event.toolCall.name, event.toolCall.arguments);
    session.callbacks.onToolEnd?.(event.toolCall.name, false, event.toolCall.arguments);
    return;
  }

  if (event.type === "error") {
    const errorMessage = event.error.errorMessage ?? "Hermes stream failed";
    throw new Error(errorMessage);
  }

  if (event.type === "done") {
    session.usage = event.message.usage;
  }
}

export function describeStreamModel(session: HermesStreamSession): string {
  return session.lastModelDescription;
}
