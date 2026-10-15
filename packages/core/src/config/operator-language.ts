/*
FNXC:OperatorLanguage 2026-09-15-07:18:
The operator may run Fusion in a language other than English (their chat, mailbox reports, and
agent escalations are the product surface they read), but every agent system prompt is written in
English, so autonomously generated prose (heartbeat reports, mailbox messages, verdict
explanations) always came back in English. A chat turn mirrors the operator's message language by
accident of the model; autonomous lanes have no operator message to mirror — that asymmetry is the
bug this module closes. The `operatorLanguage` GLOBAL setting carries an explicit operator choice;
this builder turns it into a single prompt directive that every operator-facing lane injects.
Empty/undefined = no directive (auto: lanes mirror the language of each incoming message, the
pre-feature behavior).
*/

/** Canonical language names used inside the directive, keyed by the setting's stored code. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  sk: "Slovak (slovenčina)",
  cs: "Czech (čeština)",
  de: "German (Deutsch)",
  es: "Spanish (español)",
  fr: "French (français)",
  pt: "Portuguese (português)",
  zh: "Chinese (中文)",
  ko: "Korean (한국어)",
};

/**
 * Builds the operator-language prompt directive, or `undefined` when the setting is unset
 * (auto mode). Unknown codes are passed through verbatim so an operator can name a language the
 * picker does not list without losing the directive.
 */
export function buildOperatorLanguageDirective(settings: { operatorLanguage?: string } | undefined | null): string | undefined {
  const raw = settings?.operatorLanguage?.trim();
  if (!raw || raw === "auto") return undefined;
  const name = LANGUAGE_NAMES[raw.toLowerCase()] ?? raw;
  return [
    "## Operator Language",
    "",
    `The operator's language is **${name}**. Write every operator-facing text you produce in ${name}:`,
    "chat replies, mailbox/inbox messages, agent reports and heartbeats, task logs, completion",
    "summaries, review and verdict explanations, and escalations to the operator.",
    "Keep code, commands, file paths, identifiers, task/issue ids, tool arguments, and quoted log",
    "or error output verbatim in their original language — translate prose around them, not them.",
  ].join("\n");
}
