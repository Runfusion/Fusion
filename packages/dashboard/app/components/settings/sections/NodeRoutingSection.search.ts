/**
 * Search entries for the Node Routing section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per descriptor row the section renders, co-located so a setting and its index entry change in the same edit. Labels and help mirror the section's `t()` calls verbatim — search matches the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * `defaultNodeId` is deliberately absent: it is still a hand-rolled row (its NodeHealthDot has no slot in the shared select row), and the index must only carry keys a descriptor actually renders — a stale entry would scroll to an anchor that does not exist.
 */
import type { SettingsSearchEntry } from "../search/types";

export const nodeRoutingSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "node-routing",
    key: "unavailableNodePolicy",
    labelKey: "settings.nodeRouting.unavailableNodePolicy",
    labelFallback: "Unavailable Node Policy",
    helpKey: "settings.nodeRouting.unavailableNodePolicyHint",
    helpFallback: "Default: block execution.",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    The copy never says "offline" or "fallback" — the words operators reach for when a node is down — so both are indexed as genuine vocabulary gaps rather than restatements of the label.
    */
    keywords: ["offline node", "fallback", "unreachable", "local execution"],
  },
];
