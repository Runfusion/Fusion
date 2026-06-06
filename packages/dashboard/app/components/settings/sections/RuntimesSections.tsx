/**
 * Runtimes group sections (U9 / KTD-10) — thin wrappers around each plugin
 * runtime's self-contained card. These sections carry no modal form state; they
 * just title and mount the runtime card relocated from SettingsModal's switch.
 */
import { HermesRuntimeCard } from "../../HermesRuntimeCard";
import { OpenClawRuntimeCard } from "../../OpenClawRuntimeCard";
import { PaperclipRuntimeCard } from "../../PaperclipRuntimeCard";

export function HermesRuntimeSection() {
  return (
    <>
      <h4 className="settings-section-heading">Hermes Runtime</h4>
      <HermesRuntimeCard />
    </>
  );
}

export function OpenClawRuntimeSection() {
  return (
    <>
      <h4 className="settings-section-heading">OpenClaw Runtime</h4>
      <OpenClawRuntimeCard />
    </>
  );
}

export function PaperclipRuntimeSection() {
  return (
    <>
      <h4 className="settings-section-heading">Paperclip Runtime</h4>
      <PaperclipRuntimeCard />
    </>
  );
}
