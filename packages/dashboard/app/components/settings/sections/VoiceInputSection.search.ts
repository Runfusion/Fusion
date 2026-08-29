import type { SettingsSearchEntry } from "../search/types";

/** Voice Input's one persisted descriptor row, kept adjacent to its section. */
export const voiceInputSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "voice-input",
    key: "voiceInput.enabled",
    labelKey: "settings.voiceInput.enable",
    labelFallback: "Enable voice input",
    helpKey: "settings.voiceInput.enableHelp",
    helpFallback: "Default: off. Voice dictation uses the operator-managed Parakeet v3 model.",
    keywords: ["voice", "dictation", "microphone", "speech to text", "parakeet", "transcription"],
  },
];
