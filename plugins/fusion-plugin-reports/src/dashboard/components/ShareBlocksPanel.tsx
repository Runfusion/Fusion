import { useEffect, useState } from "react";
import { copyTextToClipboard } from "@fusion/dashboard/app/utils/copyToClipboard";
import { getShareBlocks } from "../api.js";
import type { ReportRecord } from "../types.js";
import type { ShareBlocks } from "../../share-blocks.js";
import "./ShareBlocksPanel.css";

const TABS: Array<{ key: keyof ShareBlocks; label: string }> = [
  { key: "plainText", label: "Plain Text" },
  { key: "markdown", label: "Markdown" },
  { key: "slack", label: "Slack" },
  { key: "emailHtml", label: "Email HTML" },
];

export function ShareBlocksPanel({ report }: { report: ReportRecord }) {
  const [active, setActive] = useState<keyof ShareBlocks>("plainText");
  const [data, setData] = useState<ShareBlocks | null>(null);
  const [locked, setLocked] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setLocked(false);
    setData(null);
    getShareBlocks(report.id).then(setData).catch((error: Error) => {
      if (error.message.includes("409")) setLocked(true);
    });
  }, [report.id]);

  if (locked) return <section className="share-blocks-panel"><p className="share-blocks-panel__locked">Share blocks unlock after the report is approved.</p></section>;
  if (!data) return <section className="share-blocks-panel"><p>Loading share blocks…</p></section>;

  const value = data[active];
  return <section className="share-blocks-panel">
    <div className="share-blocks-panel__tabs">
      {TABS.map((tab) => <button key={tab.key} className={`btn btn-sm ${active === tab.key ? "btn-primary" : ""}`} onClick={() => setActive(tab.key)}>{tab.label}</button>)}
    </div>
    <textarea className="input share-blocks-panel__content" readOnly value={value} />
    <button className="btn btn-sm" onClick={async () => {
      /* FNXC:Clipboard 2026-07-12-00:00: Direct navigator.clipboard.writeText crashes or mis-reports on non-secure origins such as mobile http://fusionstudio:4040; copyTextToClipboard centralizes the secure-context guard and execCommand fallback. */
      const copiedToClipboard = await copyTextToClipboard(value);
      if (!copiedToClipboard) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    }}>{copied ? "Copied" : "Copy"}</button>
  </section>;
}
