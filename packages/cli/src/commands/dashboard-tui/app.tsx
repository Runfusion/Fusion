import React, { useState, useSyncExternalStore, useCallback, useEffect } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { spawn } from "node:child_process";

// Open a URL in the user's default browser. Uses the platform-native opener
// (macOS `open`, Windows `start`, Linux `xdg-open`). Detached + ignored stdio
// so the spawned process doesn't block the TUI's input loop.
function openInBrowser(url: string): void {
  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // Best-effort — silently ignore if the platform tool isn't available.
  }
}
import type { DashboardTUI } from "./controller.js";
import type {
  DashboardState,
  SectionId,
  ProjectItem,
  TaskItem,
  AgentItem,
  AgentDetailItem,
  ModelItem,
  SettingsValues,
  InteractiveView,
  GitStatus,
  GitCommit,
  GitCommitDetail,
  GitBranch,
  GitWorktree,
  FileEntry,
  FileReadResult,
  TaskDetailData,
  TaskLogEntry,
  TaskEvent,
} from "./state.js";
import { SECTION_ORDER } from "./state.js";
import type { LogEntry } from "./log-ring-buffer.js";
import { FUSION_LOGO_LINES, FUSION_LOGO_LARGE_LINES, FUSION_TAGLINE } from "./logo.js";
import { useProjects, useTasks } from "./hooks/use-projects.js";

// ── Format helpers ────────────────────────────────────────────────────────────

function formatTimestamp(date: Date): string {
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  const s = date.getSeconds().toString().padStart(2, "0");
  const ms = date.getMilliseconds().toString().padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

// All-blue vertical gradient — top: brightest white, fading through plain
// blue. blueBright is avoided because some terminal themes render it with
// a purple cast; we want the gradient to read as strictly white→blue.
const LOGO_COLORS = ["whiteBright", "white", "white", "cyanBright", "cyanBright", "cyan", "cyan", "blue"] as const;
type InkColor = typeof LOGO_COLORS[number];

function logoColor(index: number, total: number): InkColor {
  // Map this row's index proportionally across LOGO_COLORS so gradient
  // looks consistent regardless of how tall the chosen logo variant is.
  const slot = Math.min(
    LOGO_COLORS.length - 1,
    Math.floor((index / Math.max(1, total - 1)) * (LOGO_COLORS.length - 1)),
  );
  return LOGO_COLORS[slot];
}

function AnimatedFusionLogo({ lines }: { lines: readonly string[] }) {
  return (
    <Box flexDirection="column" alignItems="center">
      {lines.map((line, i) => (
        <Text key={i} color={logoColor(i, lines.length)} bold>{line}</Text>
      ))}
    </Box>
  );
}

// ── Splash screen ─────────────────────────────────────────────────────────────

// Narrow-mode threshold: below this column count each multi-pane view collapses
// to a single pane so content doesn't overflow or overlap on small terminals.
const NARROW_THRESHOLD = 80;

// Logo width thresholds. Below SPLASH_MIN_COLS we fall back to the plain
// "FUSION" word; otherwise we pick the largest variant that fits.
const SPLASH_MIN_COLS = 56;
const SPLASH_MIN_ROWS = 12;
const LARGE_LOGO_MIN_COLS = 70;
const LARGE_LOGO_MIN_ROWS = 16;

function SplashScreen({ loadingStatus }: { loadingStatus: string }) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const compact = cols < SPLASH_MIN_COLS || rows < SPLASH_MIN_ROWS;
  const large = cols >= LARGE_LOGO_MIN_COLS && rows >= LARGE_LOGO_MIN_ROWS;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {compact ? (
        <Text bold color="cyanBright">FUSION</Text>
      ) : (
        <AnimatedFusionLogo lines={large ? FUSION_LOGO_LARGE_LINES : FUSION_LOGO_LINES} />
      )}
      <Text color="cyanBright" dimColor>{FUSION_TAGLINE}</Text>
      <Box height={1} />
      <Box flexDirection="row" gap={1}>
        <Text color="cyanBright"><Spinner type="dots" /></Text>
        <Text color="cyanBright" dimColor>{loadingStatus}</Text>
      </Box>
    </Box>
  );
}

// ── Mini inline logo (header) ─────────────────────────────────────────────────

function MiniLogo() {
  return (
    <Box flexDirection="row" gap={0}>
      <Text color="cyanBright" bold>FUSION</Text>
    </Box>
  );
}

// ── Panel wrapper ─────────────────────────────────────────────────────────────

interface PanelProps {
  title: string;
  isFocused: boolean;
  children: React.ReactNode;
  flexGrow?: number;
  flexShrink?: number;
  width?: number | string;
}

function Panel({ title, isFocused, children, flexGrow, flexShrink, width }: PanelProps) {
  return (
    <Box
      borderStyle="round"
      borderColor={isFocused ? "cyanBright" : "gray"}
      flexDirection="column"
      flexGrow={flexGrow}
      flexShrink={flexShrink}
      width={width}
      overflow="hidden"
    >
      <Box paddingX={1}>
        <Text bold={isFocused} color={isFocused ? "cyanBright" : undefined} dimColor={!isFocused}>
          {title}
        </Text>
      </Box>
      <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
        {children}
      </Box>
    </Box>
  );
}

// ── System panel ──────────────────────────────────────────────────────────────

function SystemPanel({ state, isFocused }: { state: DashboardState; isFocused: boolean }) {
  const info = state.systemInfo;
  return (
    <Panel title="System" isFocused={isFocused} flexGrow={1}>
      {!info ? (
        <Text dimColor>System information not available.</Text>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text dimColor>Host:</Text>
            <Text>{info.host}</Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text dimColor>Port:</Text>
            <Text>{info.port}</Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text dimColor>URL:</Text>
            <Text color="cyanBright">{info.baseUrl}</Text>
          </Box>
          {info.authEnabled ? (
            <>
              <Box flexDirection="row" gap={1}>
                <Text dimColor>Auth:</Text>
                <Text color="yellow">bearer token required</Text>
              </Box>
              {info.authToken && (
                <Box flexDirection="row" gap={1}>
                  <Text dimColor>Token:</Text>
                  <Text wrap="truncate" color="yellow">{info.authToken}</Text>
                </Box>
              )}
              {info.tokenizedUrl && (
                <Box flexDirection="row" gap={1}>
                  <Text dimColor>Open:</Text>
                  <Text wrap="truncate" color="white">{info.tokenizedUrl}</Text>
                </Box>
              )}
            </>
          ) : (
            <>
              <Box flexDirection="row" gap={1}>
                <Text dimColor>Auth:</Text>
                <Text color="yellow">no auth</Text>
              </Box>
            </>
          )}
          <Box flexDirection="row" gap={1}>
            <Text dimColor>Engine:</Text>
            {info.engineMode === "dev" && <Text color="yellow">dev</Text>}
            {info.engineMode === "paused" && <Text color="yellow">paused</Text>}
            {info.engineMode === "active" && <Text color="green">active</Text>}
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text dimColor>Watcher:</Text>
            {info.fileWatcher ? <Text color="green">active</Text> : <Text color="red">inactive</Text>}
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text dimColor>Uptime:</Text>
            <Text>{formatUptime(Date.now() - info.startTimeMs)}</Text>
          </Box>
        </Box>
      )}
    </Panel>
  );
}

// ── Stats panel ───────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const mb = bytes / (1024 * 1024);
  // Space between number and unit so a wrap break, if forced, happens after
  // the unit rather than splitting "450MB" across two lines.
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function heapColor(used: number, limit: number): "red" | "yellow" | "green" {
  if (limit <= 0) return "green";
  const pct = used / limit;
  if (pct >= 0.85) return "red";
  if (pct >= 0.65) return "yellow";
  return "green";
}

function rssColor(rss: number, totalSystemMem: number): "red" | "yellow" | undefined {
  if (totalSystemMem <= 0) return undefined;
  const pct = rss / totalSystemMem;
  if (pct >= 0.5) return "red";
  if (pct >= 0.25) return "yellow";
  return undefined;
}

function sysMemColor(used: number, total: number): "red" | "yellow" | undefined {
  if (total <= 0) return undefined;
  const pct = used / total;
  if (pct >= 0.9) return "red";
  if (pct >= 0.75) return "yellow";
  return undefined;
}

function cpuColor(percent: number, cores: number): "red" | "yellow" | undefined {
  // Per-core normalized — >100% means oversubscribed.
  const norm = cores > 0 ? percent / cores : percent;
  if (norm >= 80) return "red";
  if (norm >= 50) return "yellow";
  return undefined;
}

function StatRow({ label, children }: { label: string; children: React.ReactNode }) {
  // Fixed-width label column + gap={2} between value tokens so each
  // measurement (number + unit + dim qualifier) stays on the same row
  // without breaking apart when one of the tokens is wider than usual.
  return (
    <Box flexDirection="row">
      <Box width={10}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexDirection="row" gap={2}>{children}</Box>
    </Box>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <Box flexDirection="row" gap={1}>
      <Text bold color="cyanBright">{title}</Text>
    </Box>
  );
}

function StatsPanel({ state, isFocused }: { state: DashboardState; isFocused: boolean }) {
  const stats = state.taskStats;
  const sys = state.systemStats;
  return (
    <Panel title="Stats" isFocused={isFocused} flexGrow={1}>
      <Box flexDirection="column">
        {sys && (
          <>
            <SectionHeader title="Process" />
            <StatRow label="RSS">
              <Text color={rssColor(sys.rss, sys.systemTotalMem)}>
                {formatBytes(sys.rss)}
              </Text>
              {sys.systemTotalMem > 0 && (
                <Text dimColor>
                  {((sys.rss / sys.systemTotalMem) * 100).toFixed(1)}%
                </Text>
              )}
            </StatRow>
            <StatRow label="Heap">
              <Text color={heapColor(sys.heapUsed, sys.heapLimit)}>
                {formatBytes(sys.heapUsed)}
              </Text>
              <Text dimColor>/</Text>
              <Text>{formatBytes(sys.heapTotal)}</Text>
            </StatRow>
            <StatRow label="">
              <Text dimColor>limit</Text>
              <Text>{formatBytes(sys.heapLimit)}</Text>
            </StatRow>
            <StatRow label="External">
              <Text>{formatBytes(sys.external)}</Text>
              <Text dimColor>buffers</Text>
              <Text>{formatBytes(sys.arrayBuffers)}</Text>
            </StatRow>
            <StatRow label="CPU">
              <Text color={cpuColor(sys.cpuPercent, sys.cpuCount)}>
                {sys.cpuPercent.toFixed(1)}%
              </Text>
              <Text dimColor>load</Text>
              <Text>{sys.loadAvg.map((n) => n.toFixed(2)).join(" ")}</Text>
            </StatRow>

            <SectionHeader title="System" />
            <StatRow label="Memory">
              <Text color={sysMemColor(sys.systemTotalMem - sys.systemFreeMem, sys.systemTotalMem)}>
                {formatBytes(sys.systemTotalMem - sys.systemFreeMem)}
              </Text>
              <Text dimColor>used</Text>
              <Text>{formatBytes(sys.systemFreeMem)}</Text>
              <Text dimColor>free</Text>
            </StatRow>
            <StatRow label="Cores">
              <Text>{sys.cpuCount}</Text>
              <Text dimColor>{sys.platform}</Text>
            </StatRow>
            <StatRow label="Node">
              <Text>{sys.nodeVersion}</Text>
              <Text dimColor>pid</Text>
              <Text>{sys.pid}</Text>
            </StatRow>
          </>
        )}
        {stats && (
          <>
            <SectionHeader title="Tasks" />
            {Object.entries(stats.byColumn).map(([col, count]) => {
              const name = col.replace(/-/g, " ");
              const isActive = (col === "in-progress" || col === "in-review") && count > 0;
              return (
                <StatRow key={col} label={name}>
                  <Text color={isActive ? "green" : undefined}>{count}</Text>
                </StatRow>
              );
            })}

            <SectionHeader title="Agents" />
            <StatRow label="idle">
              <Text>{stats.agents.idle}</Text>
            </StatRow>
            <StatRow label="active">
              <Text color="green">{stats.agents.active}</Text>
            </StatRow>
            <StatRow label="error">
              <Text color={stats.agents.error > 0 ? "red" : undefined}>
                {stats.agents.error}
              </Text>
            </StatRow>
          </>
        )}
        {!sys && !stats && <Text dimColor>Stats not available.</Text>}
      </Box>
    </Panel>
  );
}

// ── Settings panel (status mode) ──────────────────────────────────────────────

function SettingsPanel({ state, isFocused }: { state: DashboardState; isFocused: boolean }) {
  const s = state.settings;
  return (
    <Panel title="Settings" isFocused={isFocused} flexGrow={1}>
      {!s ? (
        <Text dimColor>Settings not available.</Text>
      ) : (
        <Box flexDirection="column">
          {(
            [
              ["maxConcurrent", s.maxConcurrent.toString()],
              ["maxWorktrees", s.maxWorktrees.toString()],
              ["autoMerge", s.autoMerge ? "enabled" : "disabled"],
              ["mergeStrategy", s.mergeStrategy],
              ["pollMs", `${s.pollIntervalMs}`],
              ["paused", s.enginePaused ? "yes" : "no"],
              ["globalPause", s.globalPause ? "yes" : "no"],
            ] as Array<[string, string]>
          ).map(([key, value]) => {
            const isEnabled = value === "enabled" || value === "yes";
            const isDisabled = value === "disabled" || value === "no";
            const color = isEnabled ? "green" : isDisabled ? "yellow" : undefined;
            return (
              <Box key={key} flexDirection="row" gap={1}>
                <Text dimColor>{key}</Text>
                <Text color={color}>{value}</Text>
              </Box>
            );
          })}
        </Box>
      )}
    </Panel>
  );
}

// ── Logs panel ────────────────────────────────────────────────────────────────

// Width of the prefix slot in log rows. Long prefixes are truncated; short
// ones (and missing prefixes) are padded so the message column stays aligned.
const PREFIX_WIDTH = 14;

function LevelBadge({ level }: { level: LogEntry["level"] }) {
  if (level === "error") return <Text color="red">✗</Text>;
  if (level === "warn") return <Text color="yellow">⚠</Text>;
  return <Text color="green">✓</Text>;
}

function LogsPanel({
  state,
  isFocused,
  availableRows,
}: {
  state: DashboardState;
  isFocused: boolean;
  availableRows: number;
}) {
  const { logsSeverityFilter, logsWrapEnabled, logsExpandedMode, selectedLogIndex } = state;

  const entries = logsSeverityFilter === "all"
    ? state.logEntries
    : state.logEntries.filter((e) => e.level === logsSeverityFilter);

  // Default cursor to the newest entry when the user hasn't navigated yet
  // (selectedLogIndex of 0 on a long buffer would be offscreen at the top).
  const cursor = entries.length === 0
    ? 0
    : Math.min(Math.max(selectedLogIndex, 0), entries.length - 1);

  // Slide the viewport so the cursor is always visible. Newest entries sit at
  // the bottom; oldest at the top — matching `tail`/`less` and how every
  // human reads a log file.
  const rowBudget = Math.max(1, availableRows);
  const visibleStart = Math.max(0, Math.min(
    cursor - Math.floor(rowBudget / 2),
    entries.length - rowBudget,
  ));
  const visibleEnd = Math.min(entries.length, visibleStart + rowBudget);
  const visibleEntries = entries.slice(visibleStart, visibleEnd);
  const hiddenAbove = visibleStart;
  const hiddenBelow = entries.length - visibleEnd;

  return (
    <Panel title={`Logs (${state.logEntries.length}/1000)`} isFocused={isFocused} flexGrow={1}>
      {logsExpandedMode && entries[cursor] ? (
        <ExpandedLog
          entry={entries[cursor]}
          index={cursor}
          total={entries.length}
        />
      ) : entries.length === 0 ? (
        <Text dimColor>No log entries yet.</Text>
      ) : entries.length !== state.logEntries.length && entries.length === 0 ? (
        <Text dimColor>No entries match filter {logsSeverityFilter.toUpperCase()}.</Text>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} marginBottom={0}>
            <Text dimColor>[w] wrap {logsWrapEnabled ? "on" : "off"}</Text>
            <Text dimColor>[f] {logsSeverityFilter}</Text>
            {hiddenAbove > 0 && <Text dimColor>↑ {hiddenAbove} more</Text>}
            {hiddenBelow > 0 && <Text dimColor>↓ {hiddenBelow} more</Text>}
          </Box>
          {visibleEntries.map((entry, displayIdx) => {
            const absoluteIndex = visibleStart + displayIdx;
            const isSelected = absoluteIndex === cursor;
            const bg = isSelected ? "cyan" : undefined;
            const fg = isSelected ? "whiteBright" : undefined;
            const ts = formatTimestamp(entry.timestamp);
            const lvl = entry.level === "error" ? "✗" : entry.level === "warn" ? "⚠" : "✓";
            const lvlColor = entry.level === "error" ? "red" : entry.level === "warn" ? "yellow" : "green";
            // Pad/truncate prefix to a fixed slot so message column aligns
            // across rows (rows without a prefix get blank padding instead of
            // collapsing).
            const prefixSlot = entry.prefix
              ? `[${entry.prefix}]`.slice(0, PREFIX_WIDTH).padEnd(PREFIX_WIDTH)
              : " ".repeat(PREFIX_WIDTH);
            const marker = isSelected ? "▶ " : "  ";
            return (
              <Text
                key={`${entry.timestamp.getTime()}-${displayIdx}`}
                backgroundColor={bg}
                wrap={logsWrapEnabled ? "wrap" : "truncate-end"}
              >
                <Text color={isSelected ? "white" : "gray"} bold={isSelected}>{marker}</Text>
                <Text color={fg} dimColor={!isSelected}>{ts} </Text>
                <Text color={lvlColor}>{lvl}</Text>
                <Text color={fg} dimColor={!isSelected}>{` ${prefixSlot} `}</Text>
                <Text color={fg} bold={isSelected}>{entry.message}</Text>
              </Text>
            );
          })}
        </Box>
      )}
    </Panel>
  );
}

function ExpandedLog({ entry, index, total }: { entry: LogEntry; index: number; total: number }) {
  return (
    <Box flexDirection="column" flexGrow={1} width="100%">
      <Text dimColor>Entry {index + 1}/{total} · [Enter/Esc] close</Text>
      <Box height={1} />
      <Box flexDirection="row" gap={1}>
        <Text dimColor>Time:</Text>
        <Text>{formatTimestamp(entry.timestamp)}</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <Text dimColor>Level:</Text>
        <LevelBadge level={entry.level} />
        <Text>{entry.level.toUpperCase()}</Text>
      </Box>
      {entry.prefix && (
        <Box flexDirection="row" gap={1}>
          <Text dimColor>Prefix:</Text>
          <Text>{entry.prefix}</Text>
        </Box>
      )}
      <Box height={1} />
      <Text wrap="wrap">{entry.message}</Text>
    </Box>
  );
}

// ── Utilities panel ───────────────────────────────────────────────────────────

function UtilitiesPanel({ isFocused }: { isFocused: boolean }) {
  const actions = [
    { key: "r", label: "Refresh Stats" },
    { key: "c", label: "Clear Logs" },
    { key: "t", label: "Toggle Engine Pause" },
    { key: "?", label: "Help" },
  ];
  return (
    <Panel title="Utilities" isFocused={isFocused} flexShrink={0}>
      <Box flexDirection="column">
        {actions.map((action) => (
          <Box key={action.key} flexDirection="row" gap={1}>
            <Text color="yellow">[{action.key}]</Text>
            <Text>{action.label}</Text>
          </Box>
        ))}
      </Box>
    </Panel>
  );
}

// ── Help overlay ──────────────────────────────────────────────────────────────

function HelpOverlay() {
  const shortcuts: Array<[string, string]> = [
    ["[b]", "Board view (interactive mode)"],
    ["[a]", "Agents view"],
    ["[g]", "Settings view"],
    ["[t]", "Git view"],
    ["[s]", "Status mode"],
    ["[1] / [2] / [3]", "Board / Agents / Settings (interactive)"],
    ["[Tab]", "Cycle focused panel forward"],
    ["[Shift+Tab]", "Cycle focused panel backward"],
    ["[1-5]", "Jump to panel by number (status mode)"],
    ["[→] / [n]", "Next panel (status mode)"],
    ["[←] / [p]", "Previous panel (status mode)"],
    ["[r]", "Refresh stats (Utilities)"],
    ["[c]", "Clear logs (Utilities)"],
    ["[t]", "Toggle engine pause (Utilities)"],
    ["[↑/↓/k/j]", "Navigate log entries (Logs)"],
    ["[Home/End]", "First/last log entry (Logs)"],
    ["[Enter/Space/e]", "Expand log entry (Logs)"],
    ["[w]", "Toggle word wrap (Logs)"],
    ["[f]", "Cycle severity filter (Logs)"],
    ["[s/x]", "Start/stop agent (Agents view)"],
    ["[D]", "Delete agent — requires confirm (Agents view)"],
    ["[r]", "Refresh agent detail (Agents view)"],
    ["[Space]", "Toggle boolean (Settings view)"],
    ["[+/-]", "Adjust number (Settings view)"],
    ["[?] / [h]", "Toggle help"],
    ["[q]", "Quit"],
    ["[Ctrl+C]", "Force quit"],
  ];

  const rowKeyWidth = 22;
  const rowDescWidth = Math.max(...shortcuts.map(([, d]) => d.length));
  const innerWidth = rowKeyWidth + 2 + rowDescWidth + 2;
  const titleRow = " KEYBOARD SHORTCUTS".padEnd(innerWidth);

  return (
    <Box borderStyle="round" borderColor="cyanBright" flexDirection="column" backgroundColor="black">
      <Text backgroundColor="black" bold color="white">{titleRow}</Text>
      <Text backgroundColor="black"> </Text>
      {shortcuts.map(([key, desc]) => {
        const keyCell = ` ${key.padEnd(rowKeyWidth - 1)} `;
        const descCell = ` ${desc.padEnd(rowDescWidth)} `;
        return (
          <Box key={key} flexDirection="row">
            <Text backgroundColor="black" color="yellow">{keyCell}</Text>
            <Text backgroundColor="black" color="white">{descCell}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ── Status mode grid layout ────────────────────────────────────────────────────

const PANEL_ORDER: SectionId[] = ["system", "logs", "utilities", "stats", "settings"];

function StatusModeGrid({
  state,
  rows,
  controller,
}: {
  state: DashboardState;
  rows: number;
  controller: DashboardTUI;
}) {
  const focused = state.activeSection;
  const bodyRows = Math.max(8, rows - 7);
  const logsAvailableRows = Math.max(4, bodyRows - 4);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <MainHeader state={state} />

      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        <Box flexDirection="column" flexGrow={5} overflow="hidden">
          <SystemPanel state={state} isFocused={focused === "system"} />
          <StatsPanel state={state} isFocused={focused === "stats"} />
        </Box>
        <Box flexDirection="column" flexGrow={6} overflow="hidden">
          <LogsPanel
            state={state}
            isFocused={focused === "logs"}
            availableRows={logsAvailableRows}
          />
          <Box flexDirection="row" overflow="hidden">
            <Box flexDirection="column" flexGrow={1} overflow="hidden">
              <UtilitiesPanel isFocused={focused === "utilities"} />
            </Box>
            <Box flexDirection="column" flexGrow={1} overflow="hidden">
              <SettingsPanel state={state} isFocused={focused === "settings"} />
            </Box>
          </Box>
        </Box>
      </Box>

      <StatusBar state={state} controller={controller} />
    </Box>
  );
}

function StatusModeSingle({
  state,
  controller,
}: {
  state: DashboardState;
  controller: DashboardTUI;
}) {
  const focused = state.activeSection;

  const activePanel = () => {
    switch (focused) {
      case "system": return <SystemPanel state={state} isFocused />;
      case "logs": return <LogsPanel state={state} isFocused availableRows={Math.max(4, (process.stdout.rows ?? 24) - 8)} />;
      case "utilities": return <UtilitiesPanel isFocused />;
      case "stats": return <StatsPanel state={state} isFocused />;
      case "settings": return <SettingsPanel state={state} isFocused />;
    }
  };

  return (
    <Box flexDirection="column" flexGrow={1}>
      <MainHeader state={state} />
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        {activePanel()}
      </Box>
      <StatusBar state={state} controller={controller} />
    </Box>
  );
}

function StatusBar({ state, controller: _controller }: { state: DashboardState; controller: DashboardTUI }) {
  const { systemInfo, activeSection } = state;

  const hotkeys: string[] = [];
  if (activeSection === "logs") {
    hotkeys.push("↑↓ navigate", "w wrap", "f filter", "Enter expand");
  } else if (activeSection === "utilities") {
    hotkeys.push("r refresh", "c clear logs", "t toggle pause");
  } else {
    hotkeys.push("Tab cycle panel", "1-5 jump");
  }

  const statusParts: string[] = [];
  if (systemInfo) {
    statusParts.push(systemInfo.baseUrl);
    statusParts.push(formatUptime(Date.now() - systemInfo.startTimeMs));
  }

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text dimColor>{hotkeys.join("  ·  ")}</Text>
      {statusParts.length > 0 && <Text dimColor>{statusParts.join(" | ")}</Text>}
    </Box>
  );
}

// ── Interactive mode ──────────────────────────────────────────────────────────

// ── Unified main header — used by both status and interactive modes ──────────

function MainHeader({ state }: { state: DashboardState }) {
  const inInteractive = state.mode === "interactive";
  const focused = state.activeSection;
  const interactiveView = state.interactiveView;
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const interactiveTabs: Array<{ key: string; label: string; view: InteractiveView }> = [
    { key: "b", label: "Board", view: "board" },
    { key: "a", label: "Agents", view: "agents" },
    { key: "g", label: "Settings", view: "settings" },
    { key: "t", label: "Git", view: "git" },
    { key: "e", label: "Explorer", view: "files" },
  ];
  // Keep FUSION on a single line by progressively dropping decoration as the
  // terminal shrinks. Thresholds tuned to the natural widths of each segment:
  //   * Help/quit (~20 chars) drops first.
  //   * Inactive interactive tabs collapse to a `[k]` glyph.
  //   * Inactive section tabs collapse to `[N]`.
  //   * Active-only mode hides every inactive tab.
  //   * Tiny mode drops the whole header — the row is too precious to spend.
  if (rows < 10) return null;
  const showHelpHint = cols >= 110;
  const compactInteractive = cols < 100;
  const compactSections = cols < 90;
  const minimal = cols < 70;
  const tiny = cols < 50;
  if (tiny) {
    // Just FUSION + the single active tab. No dividers, no other tabs.
    const activeSectionIdx = inInteractive
      ? -1
      : SECTION_ORDER.indexOf(focused);
    const activeSectionLabel = activeSectionIdx >= 0
      ? SECTION_ORDER[activeSectionIdx].charAt(0).toUpperCase() + SECTION_ORDER[activeSectionIdx].slice(1)
      : null;
    const activeInteractive = inInteractive
      ? interactiveTabs.find((t) => t.view === interactiveView) ?? null
      : null;
    return (
      <Box flexDirection="row" gap={1} paddingX={1}>
        <MiniLogo />
        {activeSectionLabel && (
          <Text backgroundColor="cyan" color="black" bold>{` ${activeSectionIdx + 1} ${activeSectionLabel} `}</Text>
        )}
        {activeInteractive && (
          <Text backgroundColor="cyan" color="black" bold>{` ${activeInteractive.key} ${activeInteractive.label} `}</Text>
        )}
      </Box>
    );
  }
  return (
    <Box flexDirection="row" gap={1} paddingX={1} paddingY={0}>
      <MiniLogo />
      {!minimal && <Text dimColor>│</Text>}
      {SECTION_ORDER.map((section, i) => {
        const isActive = !inInteractive && section === focused;
        const label = section.charAt(0).toUpperCase() + section.slice(1);
        if (minimal && !isActive) return null;
        return (
          <Box key={section} marginRight={1}>
            {isActive ? (
              <Text backgroundColor="cyan" color="black" bold>
                {compactSections ? ` ${i + 1} ${label} ` : ` [${i + 1}] ${label} `}
              </Text>
            ) : compactSections ? (
              <Text dimColor>{`[${i + 1}]`}</Text>
            ) : (
              <Text dimColor>{`[${i + 1}] ${label}`}</Text>
            )}
          </Box>
        );
      })}
      {!minimal && <Text dimColor>│</Text>}
      {interactiveTabs.map(({ key, label, view }) => {
        const isActive = inInteractive && view === interactiveView;
        if (minimal && !isActive) return null;
        return (
          <Box key={view} marginRight={1}>
            {isActive ? (
              <Text backgroundColor="cyan" color="black" bold>
                {compactInteractive ? ` ${key} ${label} ` : ` [${key}] ${label} `}
              </Text>
            ) : compactInteractive ? (
              <Text dimColor>{`[${key}]`}</Text>
            ) : (
              <Text dimColor>{`[${key}] ${label}`}</Text>
            )}
          </Box>
        );
      })}
      <Box flexGrow={1} />
      {showHelpHint && <Text dimColor>[?] help  [q] quit</Text>}
    </Box>
  );
}

// ── Kanban board ──────────────────────────────────────────────────────────────

const KANBAN_COLUMNS = ["todo", "in-progress", "in-review", "done"] as const;
type KanbanColumn = typeof KANBAN_COLUMNS[number];

const COLUMN_COLORS: Record<string, "yellow" | "cyanBright" | "cyan" | "green"> = {
  todo: "yellow",
  "in-progress": "cyanBright",
  "in-review": "cyan",
  done: "green",
};

function columnLabel(col: string): string {
  return col.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

function TaskCard({
  task,
  selected,
  width,
}: {
  task: TaskItem;
  selected: boolean;
  width: number;
}) {
  const accent = COLUMN_COLORS[task.column] ?? "white";
  const borderColor = selected ? "cyanBright" : "gray";
  const titleColor = selected ? "whiteBright" : undefined;
  const shortId = task.id.length > 10 ? task.id.slice(0, 8) : task.id;
  const title = task.title ?? task.description ?? "(untitled)";
  return (
    <Box
      borderStyle="round"
      borderColor={borderColor}
      flexDirection="column"
      paddingX={1}
      width={width}
      flexShrink={0}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor>{shortId}</Text>
        {task.agentState && (
          <Text color={accent}>● {task.agentState}</Text>
        )}
      </Box>
      <Text bold={selected} color={titleColor} wrap="wrap">
        {title}
      </Text>
    </Box>
  );
}

function KanbanColumnView({
  column,
  tasks,
  isFocused,
  selectedIndex,
  width,
  availableRows,
}: {
  column: KanbanColumn;
  tasks: TaskItem[];
  isFocused: boolean;
  selectedIndex: number;
  width: number;
  availableRows: number;
}) {
  const accent = COLUMN_COLORS[column];
  const headerColor = isFocused ? "whiteBright" : accent;
  const cardWidth = Math.max(16, width - 2);
  const innerHeaderWidth = Math.max(8, width - 2);
  const label = `${columnLabel(column).toUpperCase()} (${tasks.length})`;
  const headerText = ` ${label} `.length > innerHeaderWidth
    ? ` ${label} `.slice(0, innerHeaderWidth)
    : ` ${label} `.padEnd(innerHeaderWidth, " ");

  // Each TaskCard takes ~4 rows (top border + id row + title row + bottom
  // border + sometimes a wrapped title row). Reserve 2 rows for header +
  // header spacer + 2 rows for "↑/↓ N more" hints, then floor(remaining/4).
  const cardRowsBudget = Math.max(0, availableRows - 4);
  const visibleCount = Math.max(1, Math.floor(cardRowsBudget / 4));
  // Slide the window so the selected card is centered when possible.
  const halfWindow = Math.floor(visibleCount / 2);
  const maxStart = Math.max(0, tasks.length - visibleCount);
  const windowStart = Math.max(0, Math.min(selectedIndex - halfWindow, maxStart));
  const windowEnd = Math.min(tasks.length, windowStart + visibleCount);
  const visibleTasks = tasks.slice(windowStart, windowEnd);
  const hiddenAbove = windowStart;
  const hiddenBelow = tasks.length - windowEnd;

  return (
    <Box
      flexDirection="column"
      width={width}
      flexShrink={1}
      flexGrow={1}
      paddingX={1}
      overflow="hidden"
    >
      <Box width={innerHeaderWidth} flexShrink={0}>
        <Text bold color={headerColor} backgroundColor={isFocused ? accent : undefined}>
          {headerText}
        </Text>
      </Box>
      <Box height={1} flexShrink={0} />
      {tasks.length === 0 ? (
        <Text dimColor>—</Text>
      ) : (
        <Box flexDirection="column" gap={0} flexShrink={1} overflow="hidden">
          {hiddenAbove > 0 && (
            <Text dimColor>↑ {hiddenAbove} more</Text>
          )}
          {visibleTasks.map((task, i) => (
            <TaskCard
              key={task.id}
              task={task}
              selected={isFocused && (windowStart + i) === selectedIndex}
              width={cardWidth}
            />
          ))}
          {hiddenBelow > 0 && (
            <Text dimColor>↓ {hiddenBelow} more</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function ProjectSelector({
  open,
  projects,
  selectedIndex,
  onSelect: _onSelect,
}: {
  open: boolean;
  projects: ProjectItem[];
  selectedIndex: number;
  onSelect: (i: number) => void;
}) {
  const current = projects[selectedIndex] ?? null;
  if (!open) {
    return (
      <Box flexDirection="row" gap={1}>
        <Text dimColor>Project:</Text>
        <Text bold color="white">{current?.name ?? "(none)"}</Text>
        <Text dimColor>[p] change</Text>
      </Box>
    );
  }
  return (
    <Box
      borderStyle="round"
      borderColor="cyanBright"
      flexDirection="column"
      paddingX={1}
      backgroundColor="black"
      width={Math.max(30, ...projects.map((p) => p.name.length + 4))}
    >
      <Text bold color="cyanBright" backgroundColor="black">Pick a project</Text>
      {projects.length === 0 ? (
        <Text dimColor backgroundColor="black">(no projects registered)</Text>
      ) : (
        projects.map((p, i) => {
          const isSel = i === selectedIndex;
          return (
            <Box key={p.id} flexDirection="row" gap={1} backgroundColor="black">
              <Text color={isSel ? "white" : "gray"} backgroundColor="black">{isSel ? "▶" : " "}</Text>
              <Text bold={isSel} color={isSel ? "whiteBright" : undefined} backgroundColor="black">
                {p.name}
              </Text>
            </Box>
          );
        })
      )}
      <Box height={1} />
      <Text dimColor backgroundColor="black">↑↓ navigate · Enter select · Esc cancel</Text>
    </Box>
  );
}

// ── Duration helpers for step display ────────────────────────────────────────

function formatDurationMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// Format a single log timestamp as HH:MM:SS, gracefully falling back on parse errors.
function formatLogTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
  } catch {
    return "??:??:??";
  }
}

// ── Step checklist icon + color mapping ──────────────────────────────────────

const STEP_ICON: Record<string, string> = {
  done: "✓",
  running: "▶",
  pending: "·",
  failed: "✗",
  skipped: "⏭",
};
type StepStatusColor = "green" | "blue" | "gray" | "red" | "white";
const STEP_COLOR: Record<string, StepStatusColor> = {
  done: "green",
  running: "blue",
  pending: "gray",
  failed: "red",
  skipped: "gray",
};

// MAX log entries kept in the detail pane to avoid unbounded growth.
const MAX_LOG_ENTRIES = 1000;
// Initial log rows fetched from the store.
const INITIAL_LOG_LIMIT = 200;

// ── TaskDetailScreen ──────────────────────────────────────────────────────────

function TaskDetailScreen({
  task,
  projectPath,
  interactiveData,
}: {
  task: TaskItem;
  projectPath: string | null;
  interactiveData: DashboardState["interactiveData"];
}) {
  const { stdout } = useStdout();
  // How many lines the log pane can show — leave room for header + steps + dividers.
  const rows = stdout?.rows ?? 24;

  // Live task detail — initially null (loading) until the initial fetch resolves.
  const [detail, setDetail] = useState<TaskDetailData | null | "unavailable">(null);

  // Log scroll state: scrollOffset is from the bottom (0 = at bottom).
  const [logScrollOffset, setLogScrollOffset] = useState(0);
  const [autoFollow, setAutoFollow] = useState(true);

  // Steps section height is bounded so logs get the remaining space.
  // Reserve: header (3) + title (3) + meta row (2) + steps header (2) +
  //          up to 8 step rows + log header (2) + hints (2) + borders (2) = ~22 fixed
  const FIXED_ROWS = 22;
  const logPaneRows = Math.max(4, rows - FIXED_ROWS);

  // ── Mount: fetch initial data + subscribe to live events ─────────────────
  useEffect(() => {
    if (!projectPath || !interactiveData) {
      setDetail("unavailable");
      return;
    }
    let cancelled = false;

    void interactiveData.tasks.getTaskDetail(projectPath, task.id).then((d) => {
      if (cancelled) return;
      if (d === null) {
        setDetail("unavailable");
      } else {
        // Only keep last INITIAL_LOG_LIMIT entries in the initial load.
        const trimmed = { ...d, recentLogs: d.recentLogs.slice(-INITIAL_LOG_LIMIT) };
        setDetail(trimmed);
      }
    });

    const unsub = interactiveData.tasks.subscribeTaskEvents(
      projectPath,
      task.id,
      (event: TaskEvent) => {
        if (cancelled) return;
        setDetail((prev) => {
          if (!prev || prev === "unavailable") return prev;
          if (event.kind === "step:updated") {
            const steps = prev.steps.map((s) =>
              s.index === event.step.index ? event.step : s,
            );
            return { ...prev, steps };
          }
          if (event.kind === "log:appended") {
            const logs = [...prev.recentLogs, event.entry];
            // Cap at MAX_LOG_ENTRIES, dropping oldest when over limit.
            const trimmed = logs.length > MAX_LOG_ENTRIES ? logs.slice(logs.length - MAX_LOG_ENTRIES) : logs;
            return { ...prev, recentLogs: trimmed };
          }
          if (event.kind === "task:updated") {
            // Full replacement but merge logs so we don't lose buffered entries.
            const merged = [...prev.recentLogs, ...event.task.recentLogs];
            const deduped = Array.from(
              new Map(merged.map((e) => [e.timestamp + e.text, e])).values(),
            );
            const trimmed = deduped.length > MAX_LOG_ENTRIES ? deduped.slice(deduped.length - MAX_LOG_ENTRIES) : deduped;
            return { ...event.task, recentLogs: trimmed };
          }
          return prev;
        });
      },
    );

    return () => {
      cancelled = true;
      unsub();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, task.id]);

  // When auto-follow is on and new log entries arrive, reset scroll to bottom.
  const logCount = detail && detail !== "unavailable" ? detail.recentLogs.length : 0;
  useEffect(() => {
    if (autoFollow) setLogScrollOffset(0);
  }, [autoFollow, logCount]);

  // ── Keyboard: ↑↓ / j/k scroll logs; G = jump to bottom; g = jump to top ──
  useInput((input, key) => {
    // All detail-screen keys except Esc/Backspace are consumed here so they
    // don't bleed into BoardView's handler (which has return guards for detail).
    if (detail && detail !== "unavailable" && detail.recentLogs.length > 0) {
      const maxOffset = Math.max(0, detail.recentLogs.length - logPaneRows);
      if (key.upArrow || input === "k") {
        setAutoFollow(false);
        setLogScrollOffset((o) => Math.min(maxOffset, o + 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setLogScrollOffset((o) => {
          const next = Math.max(0, o - 1);
          if (next === 0) setAutoFollow(true);
          return next;
        });
        return;
      }
      if (key.pageUp) {
        setAutoFollow(false);
        setLogScrollOffset((o) => Math.min(maxOffset, o + Math.floor(logPaneRows / 2)));
        return;
      }
      if (key.pageDown) {
        setLogScrollOffset((o) => {
          const next = Math.max(0, o - Math.floor(logPaneRows / 2));
          if (next === 0) setAutoFollow(true);
          return next;
        });
        return;
      }
      if (input === "G") {
        setLogScrollOffset(0);
        setAutoFollow(true);
        return;
      }
      if (input === "g") {
        setAutoFollow(false);
        setLogScrollOffset(maxOffset);
        return;
      }
    }
  });

  const accent = COLUMN_COLORS[task.column] ?? "white";

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Box
      borderStyle="round"
      borderColor="cyanBright"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      flexGrow={1}
    >
      {/* Header strip: id + pills + back hint */}
      <Box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <Box flexDirection="row" gap={2}>
          <Text dimColor>{task.id}</Text>
          <Text color={accent} bold>[{columnLabel(task.column)}]</Text>
          {task.agentState && (
            <Text color={accent}>▶ {task.agentState}</Text>
          )}
        </Box>
        <Text dimColor>[Esc] back</Text>
      </Box>

      <Box height={1} flexShrink={0} />

      {/* Title */}
      <Text bold color="whiteBright" wrap="wrap">{task.title ?? task.id}</Text>

      <Box height={1} flexShrink={0} />

      {/* Loading / unavailable state */}
      {detail === null && (
        <Box flexDirection="row" gap={1} flexShrink={0}>
          <Text color="cyanBright"><Spinner type="dots" /></Text>
          <Text dimColor>Loading task details…</Text>
        </Box>
      )}

      {detail === "unavailable" && (
        <Text color="yellow">Task no longer available — Esc to go back</Text>
      )}

      {detail && detail !== "unavailable" && (
        <>
          {/* Meta row: branch + worktree */}
          {(detail.branch || detail.worktree) && (
            <Box flexDirection="row" gap={2} flexShrink={0}>
              {detail.branch && (
                <Box flexDirection="row" gap={1}>
                  <Text dimColor>Branch</Text>
                  <Text color="cyan">{detail.branch}</Text>
                </Box>
              )}
              {detail.worktree && (
                <Box flexDirection="row" gap={1}>
                  <Text dimColor>Worktree</Text>
                  <Text color="cyan" wrap="truncate">{detail.worktree}</Text>
                </Box>
              )}
            </Box>
          )}

          <Box height={1} flexShrink={0} />

          {/* Steps section */}
          <Text dimColor>── Steps ──────────────────────────────────────</Text>
          {detail.steps.length === 0 ? (
            <Text dimColor>(no steps yet)</Text>
          ) : (
            detail.steps.map((step) => {
              const icon = STEP_ICON[step.status] ?? "·";
              const color = STEP_COLOR[step.status] ?? "white";
              const isRunning = step.status === "running";
              const isDone = step.status === "done" || step.status === "failed" || step.status === "skipped";

              let durationText = "";
              if (isRunning && step.startedAt) {
                const elapsed = Date.now() - new Date(step.startedAt).getTime();
                durationText = ` (running — ${formatDurationMs(elapsed)})`;
              } else if (isDone && step.startedAt && step.endedAt) {
                const elapsed = new Date(step.endedAt).getTime() - new Date(step.startedAt).getTime();
                durationText = ` (${step.status} — ${formatDurationMs(elapsed)})`;
              }

              return (
                <Box key={step.index} flexDirection="row" gap={1} flexShrink={0}>
                  <Text color={color}>{icon}</Text>
                  <Text bold={isRunning} color={isRunning ? "whiteBright" : undefined} dimColor={step.status === "pending"}>
                    {step.index + 1}. {step.name}
                  </Text>
                  {durationText !== "" && (
                    <Text dimColor>{durationText}</Text>
                  )}
                </Box>
              );
            })
          )}

          <Box height={1} flexShrink={0} />

          {/* Logs section — flexGrow so it fills remaining vertical space */}
          <Box flexDirection="row" justifyContent="space-between" flexShrink={0}>
            <Text dimColor>── Logs ───────────────────────────────────────</Text>
            <Text color={autoFollow ? "cyanBright" : undefined} dimColor={!autoFollow}>
              {autoFollow ? "[live]" : "[paused]"}
            </Text>
          </Box>

          {detail.recentLogs.length === 0 ? (
            <Text dimColor>(no log entries yet)</Text>
          ) : (
            <Box flexDirection="column" flexGrow={1} overflow="hidden">
              {/* Compute the visible window from the bottom, offset by scroll position. */}
              {(() => {
                const logs = detail.recentLogs;
                const total = logs.length;
                // scrollOffset counts lines from the bottom; 0 = show tail.
                const endIdx = total - logScrollOffset;
                const startIdx = Math.max(0, endIdx - logPaneRows);
                const visible = logs.slice(startIdx, endIdx);
                return visible.map((entry, i) => {
                  const levelColor =
                    entry.level === "warn" ? "yellow" :
                    entry.level === "error" ? "red" :
                    entry.level === "debug" ? "gray" : "white";
                  const levelLabel = entry.level.toUpperCase().padEnd(5);
                  return (
                    <Box key={startIdx + i} flexDirection="row" gap={1} flexShrink={0}>
                      <Text dimColor>{formatLogTime(entry.timestamp)}</Text>
                      <Text color={levelColor}>{levelLabel}</Text>
                      {entry.source && (
                        <Text color="cyan" dimColor>[{entry.source}]</Text>
                      )}
                      <Text wrap="wrap">{entry.text}</Text>
                    </Box>
                  );
                });
              })()}
            </Box>
          )}
        </>
      )}

      <Box flexGrow={1} />
      <Text dimColor>↑↓/j/k scroll · PgUp/PgDn half-page · g top · G bottom · Esc back</Text>
    </Box>
  );
}

type BoardSubView = "board" | "detail" | "picker" | "create";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function groupTasksByColumn(tasks: TaskItem[]): Record<KanbanColumn, TaskItem[]> {
  const out: Record<KanbanColumn, TaskItem[]> = {
    todo: [],
    "in-progress": [],
    "in-review": [],
    done: [],
  };
  for (const task of tasks) {
    const col = (KANBAN_COLUMNS as readonly string[]).includes(task.column)
      ? (task.column as KanbanColumn)
      : "todo";
    out[col].push(task);
  }
  return out;
}

function BoardView({ state, controller }: { state: DashboardState; controller: DashboardTUI }) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  // Narrow mode: collapse 4-column kanban to a single full-width column so
  // columns don't overflow or overlap when the terminal is too slim.
  const isNarrow = cols < NARROW_THRESHOLD;
  const columnWidth = isNarrow
    ? Math.max(20, cols - 2)
    : Math.max(20, Math.floor((cols - 2) / KANBAN_COLUMNS.length));
  // Reserve rows for header + project bar + spacer + footer hints. The
  // kanban column then windows its cards based on what remains so cards
  // beyond the visible area still scroll into view as the cursor moves.
  const availableCardRows = Math.max(8, rows - 8);

  const [subView, setSubView] = useState<BoardSubView>("board");
  const [projectIndex, setProjectIndex] = useState(0);
  const [colIndex, setColIndex] = useState(0);
  const [rowByColumn, setRowByColumn] = useState<Record<KanbanColumn, number>>({
    todo: 0,
    "in-progress": 0,
    "in-review": 0,
    done: 0,
  });
  const [pickerOriginal, setPickerOriginal] = useState(0);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const projectsState = useProjects(state.interactiveData);
  const selectedProject = projectsState.projects[projectIndex] ?? null;
  const tasksState = useTasks(state.interactiveData, selectedProject);
  const grouped = groupTasksByColumn(tasksState.tasks);

  // Push the board's selected project into the controller so dashboard.ts
  // refreshes the global Stats panel from this project's store instead of cwd.
  useEffect(() => {
    controller.setBoardScopedProjectPath(selectedProject?.path ?? null);
    return () => {
      controller.setBoardScopedProjectPath(null);
    };
  }, [controller, selectedProject?.path]);

  const focusedColumn = KANBAN_COLUMNS[colIndex];
  const focusedTasks = grouped[focusedColumn];
  const focusedRow = clamp(rowByColumn[focusedColumn] ?? 0, 0, Math.max(0, focusedTasks.length - 1));
  const selectedTask = focusedTasks[focusedRow] ?? null;

  useInput((input, key) => {
    if (subView === "picker") {
      if (key.upArrow || input === "k") {
        setProjectIndex((p) => Math.max(0, p - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setProjectIndex((p) => Math.min(projectsState.projects.length - 1, p + 1));
        return;
      }
      if (key.return) {
        setSubView("board");
        return;
      }
      if (key.escape) {
        setProjectIndex(pickerOriginal);
        setSubView("board");
        return;
      }
      return;
    }

    if (subView === "detail") {
      if (key.escape || key.backspace || input === "h") {
        setSubView("board");
      }
      return;
    }

    if (subView === "create") {
      // TextInput owns most key handling; only Esc cancels here. Submit is
      // wired through the TextInput's onSubmit prop.
      if (key.escape) {
        setSubView("board");
        setNewTaskTitle("");
        setCreateError(null);
      }
      return;
    }

    // Cross-view shortcuts — explicit so they work regardless of any
    // global-handler ordering quirks. p/n stay board-local.
    if (input === "g" || input === "G") {
      controller.setInteractiveView("settings");
      return;
    }
    if (input === "a" || input === "A") {
      controller.setInteractiveView("agents");
      return;
    }
    if (input === "t" || input === "T") {
      controller.setInteractiveView("git");
      return;
    }

    if (input === "p" || input === "P") {
      setPickerOriginal(projectIndex);
      setSubView("picker");
      return;
    }
    if (input === "n" || input === "N") {
      if (!selectedProject) return;
      setNewTaskTitle("");
      setCreateError(null);
      setSubView("create");
      return;
    }
    if (key.return) {
      if (selectedTask) setSubView("detail");
      return;
    }
    if (key.leftArrow || input === "h") {
      setColIndex((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow || input === "l") {
      setColIndex((c) => Math.min(KANBAN_COLUMNS.length - 1, c + 1));
      return;
    }
    if (key.upArrow || input === "k") {
      setRowByColumn((m) => ({
        ...m,
        [focusedColumn]: Math.max(0, (m[focusedColumn] ?? 0) - 1),
      }));
      return;
    }
    if (key.downArrow || input === "j") {
      setRowByColumn((m) => {
        const len = grouped[focusedColumn].length;
        return { ...m, [focusedColumn]: Math.min(Math.max(0, len - 1), (m[focusedColumn] ?? 0) + 1) };
      });
      return;
    }
  });

  const narrowColumnIndicator = isNarrow
    ? ` · ${colIndex + 1}/${KANBAN_COLUMNS.length} ${columnLabel(focusedColumn).toUpperCase()} (${focusedTasks.length})`
    : "";
  const hintText = subView === "picker"
    ? "↑↓ pick · Enter confirm · Esc cancel"
    : subView === "detail"
    ? "Esc back · q quit"
    : subView === "create"
    ? "type a task title · Enter create · Esc cancel"
    : `←→ column · ↑↓ task · Enter open · n new · p project${narrowColumnIndicator}`;

  const submitNewTask = async () => {
    const title = newTaskTitle.trim();
    if (!title) {
      setCreateError("Title cannot be empty");
      return;
    }
    if (!state.interactiveData || !selectedProject) {
      setCreateError("No project selected");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await state.interactiveData.createTask(selectedProject.path, { title });
      setNewTaskTitle("");
      setSubView("board");
      tasksState.refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="row" gap={2} paddingX={1} flexShrink={0}>
        <ProjectSelector
          open={subView === "picker"}
          projects={projectsState.projects}
          selectedIndex={projectIndex}
          onSelect={setProjectIndex}
        />
        <Box flexGrow={1} />
        <Text dimColor>{hintText}</Text>
      </Box>

      <Box height={1} flexShrink={0} />

      {subView === "create" ? (
        <Box justifyContent="center" alignItems="center" flexGrow={1}>
          <Box
            borderStyle="round"
            borderColor="cyanBright"
            flexDirection="column"
            paddingX={2}
            paddingY={1}
            width={Math.min(80, Math.max(40, cols - 8))}
          >
            <Text bold color="white">New Task</Text>
            <Text dimColor>Project: {selectedProject?.name ?? "(none)"}</Text>
            <Box height={1} />
            <Text dimColor>Title</Text>
            <Box>
              <Text color="white">▸ </Text>
              <TextInput
                value={newTaskTitle}
                onChange={setNewTaskTitle}
                onSubmit={() => void submitNewTask()}
                placeholder="What needs doing?"
              />
            </Box>
            <Box height={1} />
            {createError && (
              <Text color="red">{createError}</Text>
            )}
            {creating ? (
              <Box flexDirection="row" gap={1}>
                <Text color="white"><Spinner type="dots" /></Text>
                <Text dimColor>Creating…</Text>
              </Box>
            ) : (
              <Text dimColor>Enter to create · Esc to cancel</Text>
            )}
          </Box>
        </Box>
      ) : subView === "detail" && selectedTask ? (
        <Box flexGrow={1} paddingX={1}>
          <TaskDetailScreen
            task={selectedTask}
            projectPath={selectedProject?.path ?? null}
            interactiveData={state.interactiveData}
          />
        </Box>
      ) : tasksState.loading ? (
        <Box justifyContent="center" alignItems="center" flexGrow={1} gap={1}>
          <Text color="white"><Spinner type="dots" /></Text>
          <Text dimColor>Loading tasks…</Text>
        </Box>
      ) : tasksState.tasks.length === 0 ? (
        <Box justifyContent="center" alignItems="center" flexGrow={1} flexDirection="column">
          <Text dimColor>No tasks in this project.</Text>
          <Text dimColor>Press [p] to switch projects.</Text>
        </Box>
      ) : (
        <Box flexDirection="row" flexGrow={1} overflow="hidden">
          {/* Narrow: render only the focused column at full width; ←→ cycles columns */}
          {isNarrow ? (
            <KanbanColumnView
              key={focusedColumn}
              column={focusedColumn}
              tasks={focusedTasks}
              isFocused={true}
              selectedIndex={focusedRow}
              width={columnWidth}
              availableRows={availableCardRows}
            />
          ) : (
            KANBAN_COLUMNS.map((col, i) => (
              <KanbanColumnView
                key={col}
                column={col}
                tasks={grouped[col]}
                isFocused={i === colIndex}
                selectedIndex={rowByColumn[col] ?? 0}
                width={columnWidth}
                availableRows={availableCardRows}
              />
            ))
          )}
        </Box>
      )}
    </Box>
  );
}

// ── Agents view ───────────────────────────────────────────────────────────────

function agentStateColor(state: string): string {
  switch (state) {
    case "active": return "cyanBright";
    case "running": return "green";
    case "error": return "red";
    default: return "gray";
  }
}

function heartbeatFreshness(lastHeartbeatAt?: string): { fresh: boolean; label: string } {
  if (!lastHeartbeatAt) return { fresh: false, label: "never" };
  const ageMs = Date.now() - new Date(lastHeartbeatAt).getTime();
  return { fresh: ageMs < 5 * 60 * 1000, label: formatRelativeTime(lastHeartbeatAt) };
}

type AgentSubView = "list" | "confirm-delete";

function AgentsView({ state }: { state: DashboardState }) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  // Narrow mode: hide the inactive pane so list and detail don't overlap side-by-side.
  const isNarrow = cols < NARROW_THRESHOLD;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [detail, setDetail] = useState<AgentDetailItem | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [subView, setSubView] = useState<AgentSubView>("list");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [detailFocused, setDetailFocused] = useState(false);

  const data = state.interactiveData;

  useEffect(() => {
    if (!data) return;
    data.listAgents().then(setAgents).catch(() => setAgents([]));
  }, [data]);

  const selectedAgent = agents[selectedIndex] ?? null;

  useEffect(() => {
    if (!data || !selectedAgent) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    data.getAgentDetail(selectedAgent.id).then((d) => {
      setDetail(d);
      setLoadingDetail(false);
    }).catch(() => {
      setDetail(null);
      setLoadingDetail(false);
    });
  }, [data, selectedAgent?.id]);

  function refreshDetail() {
    if (!data || !selectedAgent) return;
    setLoadingDetail(true);
    data.getAgentDetail(selectedAgent.id).then((d) => {
      setDetail(d);
      setLoadingDetail(false);
    }).catch(() => {
      setDetail(null);
      setLoadingDetail(false);
    });
  }

  async function refreshList() {
    if (!data) return;
    const list = await data.listAgents().catch(() => [] as AgentItem[]);
    setAgents(list);
    setSelectedIndex((i) => Math.min(i, Math.max(0, list.length - 1)));
  }

  useInput((input, key) => {
    if (subView === "confirm-delete") {
      if (input === "y" || input === "Y") {
        if (!data || !selectedAgent) { setSubView("list"); return; }
        data.deleteAgent(selectedAgent.id)
          .then(() => {
            setStatusMsg(`Deleted agent ${selectedAgent.name}`);
            return refreshList();
          })
          .catch((err: unknown) => setStatusMsg(`Error: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => setSubView("list"));
        return;
      }
      setSubView("list");
      return;
    }

    if (key.tab) {
      setDetailFocused((f) => !f);
      return;
    }

    if (!detailFocused) {
      if (key.upArrow || input === "k") {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setSelectedIndex((i) => Math.min(agents.length - 1, i + 1));
        return;
      }
    }

    if (input === "s") {
      if (!data || !selectedAgent) return;
      data.updateAgentState(selectedAgent.id, "active")
        .then(() => { setStatusMsg("Agent started"); return refreshList(); })
        .catch((err: unknown) => setStatusMsg(`Error: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    if (input === "x") {
      if (!data || !selectedAgent) return;
      data.updateAgentState(selectedAgent.id, "idle")
        .then(() => { setStatusMsg("Agent stopped"); return refreshList(); })
        .catch((err: unknown) => setStatusMsg(`Error: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    if (input === "D") {
      if (selectedAgent) setSubView("confirm-delete");
      return;
    }
    if (input === "r") {
      refreshDetail();
      return;
    }
  });

  if (subView === "confirm-delete" && selectedAgent) {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <Box borderStyle="round" borderColor="red" flexDirection="column" paddingX={2} paddingY={1}>
          <Text bold color="red">Delete agent?</Text>
          <Box height={1} />
          <Text>Agent: <Text bold color="whiteBright">{selectedAgent.name}</Text></Text>
          <Text dimColor>ID: {selectedAgent.id}</Text>
          <Box height={1} />
          <Text>[y] confirm delete  [any other key] cancel</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      {statusMsg && (
        <Box paddingX={1}>
          <Text color="yellow">{statusMsg}</Text>
        </Box>
      )}
      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        {/* List panel — in narrow mode, hidden when detail pane is focused */}
        {(!isNarrow || !detailFocused) && (
          <Box
            borderStyle="round"
            borderColor={detailFocused ? "gray" : "cyanBright"}
            flexDirection="column"
            width={isNarrow ? undefined : "30%"}
            flexGrow={isNarrow ? 1 : 0}
            flexShrink={0}
            overflow="hidden"
          >
            <Box paddingX={1}>
              <Text bold={!detailFocused} color={!detailFocused ? "cyanBright" : undefined} dimColor={detailFocused}>
                Agents ({agents.length})
              </Text>
            </Box>
            <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
              {agents.length === 0 ? (
                <Text dimColor>No agents found.</Text>
              ) : (
                agents.map((agent, i) => {
                  const isSel = i === selectedIndex;
                  const { fresh, label } = heartbeatFreshness(agent.lastHeartbeatAt);
                  return (
                    <Box key={agent.id} flexDirection="row" gap={1}>
                      <Text color={isSel ? "white" : "gray"}>{isSel ? "▶" : " "}</Text>
                      <Box flexDirection="column" flexGrow={1}>
                        <Box flexDirection="row" gap={1}>
                          <Text bold={isSel} color={isSel ? "whiteBright" : undefined} wrap="truncate">
                            {agent.name}
                          </Text>
                          <Text color={agentStateColor(agent.state) as "cyanBright" | "green" | "red" | "gray"}>
                            {agent.state}
                          </Text>
                        </Box>
                        <Box flexDirection="row" gap={1}>
                          <Text color={fresh ? "green" : "gray"} dimColor>●</Text>
                          <Text dimColor>{label}</Text>
                        </Box>
                      </Box>
                    </Box>
                  );
                })
              )}
            </Box>
          </Box>
        )}

        {/* Right: agent detail — in narrow mode, hidden when list pane is focused */}
        {(!isNarrow || detailFocused) && (
          <Box
            borderStyle="round"
            borderColor={detailFocused ? "cyanBright" : "gray"}
            flexDirection="column"
            flexGrow={1}
            overflow="hidden"
          >
            <Box paddingX={1}>
              <Text bold={detailFocused} color={detailFocused ? "cyanBright" : undefined} dimColor={!detailFocused}>
                Agent Detail
              </Text>
            </Box>
            <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
              {!selectedAgent ? (
                <Text dimColor>Select an agent from the list.</Text>
              ) : loadingDetail ? (
                <Box flexDirection="row" gap={1}>
                  <Text color="white"><Spinner type="dots" /></Text>
                  <Text dimColor>Loading…</Text>
                </Box>
              ) : !detail ? (
                <Text dimColor>Could not load agent detail.</Text>
              ) : (
                <Box flexDirection="column">
                  <Text bold color="whiteBright">{detail.name}</Text>
                  <Text dimColor>{detail.id}</Text>
                  <Box height={1} />
                  <Box flexDirection="row" gap={1}>
                    <Text dimColor>State:</Text>
                    <Text color={agentStateColor(detail.state) as "cyanBright" | "green" | "red" | "gray"} bold>
                      {detail.state}
                    </Text>
                  </Box>
                  <Box flexDirection="row" gap={1}>
                    <Text dimColor>Role:</Text>
                    <Text>{detail.role}</Text>
                  </Box>
                  {detail.title && (
                    <Box flexDirection="row" gap={1}>
                      <Text dimColor>Title:</Text>
                      <Text>{detail.title}</Text>
                    </Box>
                  )}
                  {detail.taskId && (
                    <Box flexDirection="row" gap={1}>
                      <Text dimColor>Task:</Text>
                      <Text color="cyanBright">{detail.taskId}</Text>
                    </Box>
                  )}
                  {detail.capabilities.length > 0 && (
                    <Box flexDirection="row" gap={1}>
                      <Text dimColor>Caps:</Text>
                      <Text>{detail.capabilities.join(", ")}</Text>
                    </Box>
                  )}
                  {detail.recentRuns.length > 0 && (
                    <>
                      <Box height={1} />
                      <Text dimColor>Recent runs (latest first):</Text>
                      {detail.recentRuns.slice(0, 5).map((run) => (
                        <Box key={run.id} flexDirection="row" gap={1} marginLeft={1}>
                          <Text color={run.status === "completed" ? "green" : run.status === "failed" ? "red" : "yellow"}>
                            {run.status.slice(0, 4)}
                          </Text>
                          <Text dimColor>{run.startedAt.slice(11, 19)}</Text>
                          {run.triggerDetail && <Text dimColor>{run.triggerDetail}</Text>}
                        </Box>
                      ))}
                    </>
                  )}
                </Box>
              )}
            </Box>
          </Box>
        )}
      </Box>

      {/* Footer */}
      <Box paddingX={1} flexDirection="row" gap={1}>
        <Text dimColor>[s] start  [x] stop  [D] delete  [r] refresh  [Tab] focus  ↑↓ select</Text>
        {isNarrow && (
          <Text dimColor>[narrow] {detailFocused ? "detail" : "list"}</Text>
        )}
      </Box>
    </Box>
  );
}

// ── Settings interactive view ─────────────────────────────────────────────────

type SettingKey = "maxConcurrent" | "maxWorktrees" | "autoMerge" | "mergeStrategy" | "pollIntervalMs" | "enginePaused" | "globalPause";

interface SettingDef {
  key: SettingKey;
  label: string;
  type: "number" | "boolean" | "enum";
  options?: string[];
}

const SETTING_DEFS: SettingDef[] = [
  { key: "maxConcurrent", label: "Max Concurrent", type: "number" },
  { key: "maxWorktrees", label: "Max Worktrees", type: "number" },
  { key: "autoMerge", label: "Auto Merge", type: "boolean" },
  { key: "mergeStrategy", label: "Merge Strategy", type: "enum", options: ["direct", "squash", "rebase"] },
  { key: "pollIntervalMs", label: "Poll Interval (ms)", type: "number" },
  { key: "enginePaused", label: "Engine Paused", type: "boolean" },
  { key: "globalPause", label: "Global Pause", type: "boolean" },
];

function SettingsInteractiveView({ state }: { state: DashboardState }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [localSettings, setLocalSettings] = useState<SettingsValues | null>(null);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [detailFocused, setDetailFocused] = useState(false);

  const data = state.interactiveData;

  useEffect(() => {
    if (!data) return;
    data.getSettings().then(setLocalSettings).catch(() => {});
    setModels(data.listModels());
  }, [data]);

  const selectedDef = SETTING_DEFS[selectedIndex];

  async function saveField(partial: Partial<SettingsValues>) {
    if (!data || !localSettings) return;
    setSaving(true);
    try {
      await data.updateSettings(partial);
      const updated = await data.getSettings();
      setLocalSettings(updated);
      setStatusMsg("Saved");
    } catch (err) {
      setStatusMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  useInput((input, key) => {
    if (key.tab) {
      setDetailFocused((f) => !f);
      return;
    }

    if (!detailFocused) {
      if (key.upArrow || input === "k") {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setSelectedIndex((i) => Math.min(SETTING_DEFS.length - 1, i + 1));
        return;
      }
      return;
    }

    if (!selectedDef || !localSettings) return;

    if (selectedDef.type === "boolean" && input === " ") {
      const current = localSettings[selectedDef.key] as boolean;
      const updated = { ...localSettings, [selectedDef.key]: !current };
      setLocalSettings(updated);
      void saveField({ [selectedDef.key]: !current });
      return;
    }

    if (selectedDef.type === "number") {
      const current = localSettings[selectedDef.key] as number;
      if (input === "+" || input === "=") {
        const step = selectedDef.key === "pollIntervalMs" ? 5000 : 1;
        const updated = { ...localSettings, [selectedDef.key]: current + step };
        setLocalSettings(updated);
        void saveField({ [selectedDef.key]: current + step });
        return;
      }
      if (input === "-" || input === "_") {
        const step = selectedDef.key === "pollIntervalMs" ? 5000 : 1;
        const newVal = Math.max(0, current - step);
        const updated = { ...localSettings, [selectedDef.key]: newVal };
        setLocalSettings(updated);
        void saveField({ [selectedDef.key]: newVal });
        return;
      }
    }

    if (selectedDef.type === "enum" && selectedDef.options) {
      const current = localSettings[selectedDef.key] as string;
      const idx = selectedDef.options.indexOf(current);
      if (key.rightArrow || input === "l") {
        const next = selectedDef.options[(idx + 1) % selectedDef.options.length];
        const updated = { ...localSettings, [selectedDef.key]: next };
        setLocalSettings(updated);
        void saveField({ [selectedDef.key]: next });
        return;
      }
      if (key.leftArrow || input === "h") {
        const prev = selectedDef.options[(idx - 1 + selectedDef.options.length) % selectedDef.options.length];
        const updated = { ...localSettings, [selectedDef.key]: prev };
        setLocalSettings(updated);
        void saveField({ [selectedDef.key]: prev });
        return;
      }
    }
  });

  function renderValue(def: SettingDef, settings: SettingsValues): React.ReactNode {
    const v = settings[def.key];
    if (def.type === "boolean") {
      return <Text color={v ? "green" : "yellow"}>{v ? "enabled" : "disabled"}</Text>;
    }
    if (def.type === "enum") {
      return <Text color="cyanBright">{String(v)}</Text>;
    }
    return <Text>{String(v)}</Text>;
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      {statusMsg && (
        <Box paddingX={1}>
          <Text color="yellow">{saving ? "Saving…" : statusMsg}</Text>
        </Box>
      )}
      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        {/* Left: settings list */}
        <Box
          borderStyle="round"
          borderColor={detailFocused ? "gray" : "cyanBright"}
          flexDirection="column"
          width="35%"
          overflow="hidden"
        >
          <Box paddingX={1}>
            <Text bold={!detailFocused} color={!detailFocused ? "cyanBright" : undefined} dimColor={detailFocused}>
              Settings
            </Text>
          </Box>
          <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
            {!localSettings ? (
              <Text dimColor>Loading…</Text>
            ) : (
              SETTING_DEFS.map((def, i) => {
                const isSel = i === selectedIndex;
                return (
                  <Box key={def.key} flexDirection="row" gap={1}>
                    <Text color={isSel ? "white" : "gray"}>{isSel ? "▶" : " "}</Text>
                    <Text bold={isSel} color={isSel ? "whiteBright" : undefined} wrap="truncate">
                      {def.label}
                    </Text>
                    <Box flexGrow={1} />
                    {renderValue(def, localSettings)}
                  </Box>
                );
              })
            )}
          </Box>
        </Box>

        {/* Right: edit + models */}
        <Box
          borderStyle="round"
          borderColor={detailFocused ? "cyanBright" : "gray"}
          flexDirection="column"
          flexGrow={1}
          overflow="hidden"
        >
          <Box paddingX={1}>
            <Text bold={detailFocused} color={detailFocused ? "cyanBright" : undefined} dimColor={!detailFocused}>
              Edit / Models
            </Text>
          </Box>
          <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
            {!localSettings ? (
              <Text dimColor>Loading settings…</Text>
            ) : !selectedDef ? null : (
              <>
                <Text bold color="whiteBright">{selectedDef.label}</Text>
                <Box height={1} />
                <Box flexDirection="row" gap={1}>
                  <Text dimColor>Current:</Text>
                  {renderValue(selectedDef, localSettings)}
                </Box>
                <Box height={1} />
                {selectedDef.type === "boolean" && (
                  <Text dimColor>[Space] toggle</Text>
                )}
                {selectedDef.type === "number" && (
                  <Text dimColor>
                    {selectedDef.key === "pollIntervalMs" ? "[+/-] adjust by 5000ms" : "[+/-] adjust by 1"}
                  </Text>
                )}
                {selectedDef.type === "enum" && selectedDef.options && (
                  <Box flexDirection="column">
                    <Text dimColor>[←/→] cycle options:</Text>
                    {selectedDef.options.map((opt) => (
                      <Box key={opt} flexDirection="row" gap={1} marginLeft={1}>
                        <Text color={(localSettings[selectedDef.key] as string) === opt ? "white" : "gray"}>
                          {(localSettings[selectedDef.key] as string) === opt ? "▶" : " "}
                        </Text>
                        <Text>{opt}</Text>
                      </Box>
                    ))}
                  </Box>
                )}

                {/* Models subsection */}
                {models.length > 0 && (
                  <>
                    <Box height={1} />
                    <Text dimColor>──── Available Models ────</Text>
                    <Text dimColor>Configure default model in web dashboard</Text>
                    <Box height={1} />
                    {models.slice(0, 8).map((m) => (
                      <Box key={`${m.provider}/${m.id}`} flexDirection="row" gap={1}>
                        <Text dimColor>{m.provider}</Text>
                        <Text wrap="truncate">{m.name}</Text>
                        <Text dimColor>{Math.round(m.contextWindow / 1000)}k ctx</Text>
                      </Box>
                    ))}
                    {models.length > 8 && (
                      <Text dimColor>… and {models.length - 8} more</Text>
                    )}
                  </>
                )}
              </>
            )}
          </Box>
        </Box>
      </Box>

      <Box paddingX={1}>
        <Text dimColor>[Tab] switch panel  ↑↓ select setting  [Space] toggle bool  [+/-] adjust num  [←/→] cycle enum</Text>
      </Box>
    </Box>
  );
}

// ── Git view ──────────────────────────────────────────────────────────────────

function relMs(ms: number | null): string {
  if (ms === null) return "never";
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function statusColor(s: string): "green" | "yellow" | "red" | "cyan" | "gray" {
  if (s === "A") return "green";
  if (s === "D") return "red";
  if (s === "R" || s === "C") return "cyan";
  if (s === "M" || s === "m") return "yellow";
  return "gray";
}

function truncatePath(p: string, maxLen: number): string {
  if (p.length <= maxLen) return p;
  return "…" + p.slice(-(maxLen - 1));
}

function authorInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return (parts[0] ?? "?").slice(0, 2).toUpperCase();
  return ((parts[0]?.[0] ?? "") + (parts[parts.length - 1]?.[0] ?? "")).toUpperCase();
}

type GitPane = "status" | "branches" | "worktrees" | "commits" | "changes";

type PushModalState =
  | { phase: "confirm"; commits: GitCommit[] }
  | { phase: "pushing" }
  | { phase: "done"; message: string; isError: boolean };

function PushModal({
  status,
  commits,
  onConfirm,
  onCancel,
}: {
  status: GitStatus;
  commits: GitCommit[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useInput((_input, key) => {
    if (key.return) { onConfirm(); return; }
    if (key.escape) { onCancel(); return; }
  });

  const toPush = commits.slice(0, status.ahead);
  return (
    <Box
      position="absolute"
      flexDirection="column"
      borderStyle="round"
      borderColor="cyanBright"
      paddingX={2}
      paddingY={1}
      backgroundColor="black"
    >
      <Text bold color="white">Push to remote</Text>
      <Box height={1} />
      <Box flexDirection="row" gap={1}>
        <Text dimColor>Branch:</Text>
        <Text color="cyan">{status.branch}</Text>
        <Text dimColor>ahead</Text>
        <Text color="yellow">{status.ahead}</Text>
      </Box>
      {toPush.length > 0 && (
        <>
          <Box height={1} />
          <Text dimColor>Commits to push (oldest→newest):</Text>
          {[...toPush].reverse().map((c) => (
            <Box key={c.sha} flexDirection="row" gap={1} marginLeft={1}>
              <Text color="gray">{c.shortSha}</Text>
              <Text wrap="truncate">{c.subject}</Text>
            </Box>
          ))}
        </>
      )}
      <Box height={1} />
      <Text dimColor>[Enter] push  [Esc] cancel</Text>
    </Box>
  );
}

function GitView({ state }: { state: DashboardState }) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  const data = state.interactiveData;

  const [projectIndex, setProjectIndex] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerOriginal, setPickerOriginal] = useState(0);

  const projectsState = useProjects(data);
  const selectedProject = projectsState.projects[projectIndex] ?? null;
  const projectPath = selectedProject?.path ?? null;

  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const [commitIndex, setCommitIndex] = useState(0);
  const [commitDetail, setCommitDetail] = useState<GitCommitDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [branchIndex, setBranchIndex] = useState(0);
  const [worktreeIndex, setWorktreeIndex] = useState(0);

  const [activePane, setActivePane] = useState<GitPane>("status");

  const [pushModal, setPushModal] = useState<PushModalState | null>(null);

  const refresh = useCallback(async () => {
    if (!data || !projectPath) return;
    setLoading(true);
    try {
      const [s, c, b, w] = await Promise.all([
        data.git.getStatus(projectPath),
        data.git.listCommits(projectPath, 15),
        data.git.listBranches(projectPath),
        data.git.listWorktrees(projectPath),
      ]);
      setGitStatus(s);
      setCommits(c);
      setBranches(b);
      setWorktrees(w);
    } catch (err) {
      setStatusMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [data, projectPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const id = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const selectedCommit = commits[commitIndex] ?? null;

  useEffect(() => {
    if (!data || !projectPath || !selectedCommit) {
      setCommitDetail(null);
      return;
    }
    setLoadingDetail(true);
    data.git.showCommit(projectPath, selectedCommit.sha).then((d) => {
      setCommitDetail(d);
      setLoadingDetail(false);
    }).catch(() => {
      setCommitDetail(null);
      setLoadingDetail(false);
    });
  }, [data, projectPath, selectedCommit?.sha]);

  useInput((input, key) => {
    if (pushModal) {
      if (pushModal.phase === "confirm") {
        if (key.return) {
          setPushModal({ phase: "pushing" });
          if (data && projectPath) {
            data.git.push(projectPath).then((result) => {
              setPushModal({ phase: "done", message: result.output || (result.success ? "Push successful" : "Push failed"), isError: !result.success });
              if (result.success) {
                setTimeout(() => { setPushModal(null); void refresh(); }, 2000);
              }
            }).catch((err: unknown) => {
              setPushModal({ phase: "done", message: err instanceof Error ? err.message : String(err), isError: true });
            });
          }
          return;
        }
        if (key.escape) { setPushModal(null); return; }
      }
      if (pushModal.phase === "done" && (pushModal.isError || key.escape)) {
        setPushModal(null);
        return;
      }
      return;
    }

    if (pickerOpen) {
      if (key.upArrow || input === "k") { setProjectIndex((p) => Math.max(0, p - 1)); return; }
      if (key.downArrow || input === "j") { setProjectIndex((p) => Math.min(projectsState.projects.length - 1, p + 1)); return; }
      if (key.return) { setPickerOpen(false); return; }
      if (key.escape) { setProjectIndex(pickerOriginal); setPickerOpen(false); return; }
      return;
    }

    if (input === "p") { setPickerOriginal(projectIndex); setPickerOpen(true); return; }

    if (input === "r") { void refresh(); return; }

    if (input === "P" && gitStatus && gitStatus.ahead > 0) {
      setPushModal({ phase: "confirm", commits });
      return;
    }

    if (input === "F" && data && projectPath) {
      setStatusMsg("Fetching…");
      data.git.fetch(projectPath).then((result) => {
        setStatusMsg(result.success ? "Fetched" : `Fetch failed: ${result.output}`);
        void refresh();
      }).catch((err: unknown) => {
        setStatusMsg(`Fetch error: ${err instanceof Error ? err.message : String(err)}`);
      });
      return;
    }

    if (key.leftArrow || input === "h") {
      setActivePane((p) => {
        const order: GitPane[] = worktrees.length > 1
          ? ["status", "branches", "worktrees", "commits", "changes"]
          : ["status", "branches", "commits", "changes"];
        const i = order.indexOf(p);
        return order[Math.max(0, i - 1)] ?? p;
      });
      return;
    }
    if (key.rightArrow || input === "l") {
      setActivePane((p) => {
        const order: GitPane[] = worktrees.length > 1
          ? ["status", "branches", "worktrees", "commits", "changes"]
          : ["status", "branches", "commits", "changes"];
        const i = order.indexOf(p);
        return order[Math.min(order.length - 1, i + 1)] ?? p;
      });
      return;
    }

    if (activePane === "commits") {
      if (key.upArrow || input === "k") { setCommitIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow || input === "j") { setCommitIndex((i) => Math.min(commits.length - 1, i + 1)); return; }
    }
    if (activePane === "branches") {
      if (key.upArrow || input === "k") { setBranchIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow || input === "j") { setBranchIndex((i) => Math.min(branches.length - 1, i + 1)); return; }
    }
    if (activePane === "worktrees") {
      if (key.upArrow || input === "k") { setWorktreeIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow || input === "j") { setWorktreeIndex((i) => Math.min(worktrees.length - 1, i + 1)); return; }
    }
  });

  // Narrow mode: collapse multi-pane layout to a single full-width pane so
  // the stacked left+right columns don't overflow on small terminals.
  const isNarrow = cols < NARROW_THRESHOLD;
  const leftWidth = Math.max(24, Math.floor(cols * 0.35));
  const rightWidth = cols - leftWidth - 1;

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {/* Top bar: project selector + status */}
      <Box flexDirection="row" gap={2} paddingX={1}>
        <Box flexDirection="row" gap={1}>
          <Text dimColor>Project:</Text>
          <Text bold color="white">{selectedProject?.name ?? "(none)"}</Text>
          <Text dimColor>[p] change</Text>
        </Box>
        {loading && (
          <Box flexDirection="row" gap={1}>
            <Text color="cyanBright"><Spinner type="dots" /></Text>
            <Text dimColor>refreshing</Text>
          </Box>
        )}
        {statusMsg && <Text color="yellow">{statusMsg}</Text>}
        <Box flexGrow={1} />
        {gitStatus && (
          <Box flexDirection="row" gap={1}>
            {gitStatus.detached ? (
              <Text color="yellow">detached HEAD</Text>
            ) : (
              <>
                <Text color="cyanBright">{gitStatus.branch}</Text>
                {gitStatus.ahead > 0 && <Text color="green">↑{gitStatus.ahead}</Text>}
                {gitStatus.behind > 0 && <Text color="yellow">↓{gitStatus.behind}</Text>}
              </>
            )}
          </Box>
        )}
      </Box>

      {/* Main body — narrow: render only the active pane at full width so stacked columns don't overflow */}
      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        {/* Left column: status + branches + worktrees — hidden in narrow when right pane is active */}
        {(!isNarrow || activePane === "status" || activePane === "branches" || activePane === "worktrees") && (
          <Box
            flexDirection="column"
            width={isNarrow ? undefined : leftWidth}
            flexGrow={isNarrow ? 1 : 0}
            flexShrink={0}
            overflow="hidden"
          >
            {/* Status panel — in narrow mode only shown when it is the active pane */}
            {(!isNarrow || activePane === "status") && (
              <Box
                borderStyle="round"
                borderColor={activePane === "status" ? "cyanBright" : "gray"}
                flexDirection="column"
                flexShrink={0}
                overflow="hidden"
              >
                <Box paddingX={1}>
                  <Text bold={activePane === "status"} color={activePane === "status" ? "blue" : undefined} dimColor={activePane !== "status"}>
                    Status
                  </Text>
                </Box>
                <Box flexDirection="column" paddingX={1} overflow="hidden">
                  {!gitStatus ? (
                    <Text dimColor>{projectPath ? "Loading…" : "No project"}</Text>
                  ) : (
                    <>
                      <Box flexDirection="row" gap={1}>
                        <Text dimColor>Remote:</Text>
                        <Text color="gray" wrap="truncate">{gitStatus.remoteUrl || "(none)"}</Text>
                      </Box>
                      <Box flexDirection="row" gap={1}>
                        <Text dimColor>Fetched:</Text>
                        <Text color="gray">{relMs(gitStatus.lastFetchAt)}</Text>
                      </Box>
                      <Box flexDirection="row" gap={1}>
                        <Text dimColor>Staged:</Text>
                        <Text color={gitStatus.staged.length > 0 ? "green" : "gray"}>{gitStatus.staged.length}</Text>
                        <Text dimColor>Modified:</Text>
                        <Text color={gitStatus.unstaged.length > 0 ? "yellow" : "gray"}>{gitStatus.unstaged.length}</Text>
                        <Text dimColor>New:</Text>
                        <Text color={gitStatus.untracked.length > 0 ? "cyan" : "gray"}>{gitStatus.untracked.length}</Text>
                      </Box>
                    </>
                  )}
                </Box>
              </Box>
            )}

            {/* Branches panel — in narrow mode only shown when it is the active pane */}
            {(!isNarrow || activePane === "branches") && (
              <Box
                borderStyle="round"
                borderColor={activePane === "branches" ? "cyanBright" : "gray"}
                flexDirection="column"
                flexGrow={isNarrow ? 1 : 1}
                overflow="hidden"
              >
                <Box paddingX={1}>
                  <Text bold={activePane === "branches"} color={activePane === "branches" ? "blue" : undefined} dimColor={activePane !== "branches"}>
                    Branches
                  </Text>
                </Box>
                <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
                  {branches.length === 0 ? (
                    <Text dimColor>—</Text>
                  ) : (
                    branches.slice(0, 8).map((b, bi) => {
                      const isSel = activePane === "branches" && bi === branchIndex;
                      return (
                        <Box key={b.name} flexDirection="row" gap={1}>
                          <Text color={isSel ? "white" : b.isCurrent ? "cyanBright" : "gray"}>{isSel ? "▶" : b.isCurrent ? "▶" : " "}</Text>
                          <Text color={isSel ? "whiteBright" : b.isCurrent ? "white" : "gray"} bold={isSel || b.isCurrent} wrap="truncate">
                            {b.name}
                          </Text>
                          <Text dimColor>{b.shortSha}</Text>
                        </Box>
                      );
                    })
                  )}
                  {branches.length > 8 && <Text dimColor>…+{branches.length - 8} more</Text>}
                </Box>
              </Box>
            )}

            {/* Worktrees panel — in narrow mode only shown when it is the active pane */}
            {worktrees.length > 1 && (!isNarrow || activePane === "worktrees") && (
              <Box
                borderStyle="round"
                borderColor={activePane === "worktrees" ? "cyanBright" : "gray"}
                flexDirection="column"
                flexShrink={0}
                overflow="hidden"
              >
                <Box paddingX={1}>
                  <Text bold={activePane === "worktrees"} color={activePane === "worktrees" ? "blue" : undefined} dimColor={activePane !== "worktrees"}>
                    Worktrees ({worktrees.length})
                  </Text>
                </Box>
                <Box flexDirection="column" paddingX={1} overflow="hidden">
                  {worktrees.map((wt, wi) => {
                    const isSel = activePane === "worktrees" && wi === worktreeIndex;
                    return (
                      <Box key={wt.path} flexDirection="row" gap={1}>
                        <Text color={isSel ? "white" : wt.isCurrent ? "cyanBright" : "gray"}>{isSel ? "▶" : wt.isCurrent ? "▶" : " "}</Text>
                        <Text color={isSel ? "whiteBright" : wt.isCurrent ? "white" : "gray"} bold={isSel} wrap="truncate">
                          {wt.branch}
                        </Text>
                        {wt.isLocked && <Text color="yellow">🔒</Text>}
                      </Box>
                    );
                  })}
                </Box>
              </Box>
            )}
          </Box>
        )}

        {/* Right column: commits + changes — hidden in narrow when left pane is active */}
        {(!isNarrow || activePane === "commits" || activePane === "changes") && (
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {/* Commits panel — in narrow mode only shown when it is the active pane */}
            {(!isNarrow || activePane === "commits") && (
              <Box
                borderStyle="round"
                borderColor={activePane === "commits" ? "cyanBright" : "gray"}
                flexDirection="column"
                flexGrow={1}
                overflow="hidden"
              >
                <Box paddingX={1}>
                  <Text bold={activePane === "commits"} color={activePane === "commits" ? "blue" : undefined} dimColor={activePane !== "commits"}>
                    Commits
                  </Text>
                </Box>
                <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
                  {commits.length === 0 ? (
                    <Text dimColor>{loading ? "Loading…" : "No commits"}</Text>
                  ) : (
                    commits.map((c, i) => {
                      const isSel = i === commitIndex;
                      const initials = authorInitials(c.authorName);
                      const subjectWidth = Math.max(10, (isNarrow ? cols - 30 : rightWidth - 30));
                      const subject = c.subject.length > subjectWidth
                        ? c.subject.slice(0, subjectWidth - 1) + "…"
                        : c.subject;
                      return (
                        <Box key={c.sha} flexDirection="row" gap={1}>
                          <Text color={isSel ? "white" : "gray"}>{isSel ? "▶" : " "}</Text>
                          <Text color="gray">{c.shortSha}</Text>
                          <Text dimColor>{c.relativeTime.slice(0, 8).padEnd(8)}</Text>
                          <Text color="cyanBright">{initials.padEnd(2)}</Text>
                          <Text bold={isSel} color={isSel ? "whiteBright" : undefined} wrap="truncate">
                            {subject}
                          </Text>
                        </Box>
                      );
                    })
                  )}
                </Box>
                {/* Commit detail strip */}
                {selectedCommit && (
                  <Box
                    borderStyle="round"
                    borderColor="gray"
                    flexDirection="column"
                    paddingX={1}
                    flexShrink={0}
                    overflow="hidden"
                  >
                    {loadingDetail ? (
                      <Box flexDirection="row" gap={1}>
                        <Text color="cyanBright"><Spinner type="dots" /></Text>
                        <Text dimColor>Loading…</Text>
                      </Box>
                    ) : commitDetail ? (
                      <>
                        <Box flexDirection="row" gap={1}>
                          <Text color="gray">{commitDetail.shortSha}</Text>
                          <Text dimColor>{commitDetail.isoTime.slice(0, 16)}</Text>
                          <Text dimColor>by</Text>
                          <Text color="cyanBright">{commitDetail.authorName}</Text>
                        </Box>
                        {commitDetail.body && (
                          <Text dimColor wrap="wrap">{commitDetail.body.slice(0, 200)}</Text>
                        )}
                        {commitDetail.stat && (
                          <Text dimColor wrap="truncate">{commitDetail.stat.split("\n").slice(-1)[0]}</Text>
                        )}
                      </>
                    ) : null}
                  </Box>
                )}
              </Box>
            )}

            {/* Changes panel — in narrow mode only shown when it is the active pane */}
            {(!isNarrow || activePane === "changes") && (
              <Box
                borderStyle="round"
                borderColor={activePane === "changes" ? "cyanBright" : "gray"}
                flexDirection="column"
                flexShrink={0}
                overflow="hidden"
              >
                <Box paddingX={1}>
                  <Text bold={activePane === "changes"} color={activePane === "changes" ? "blue" : undefined} dimColor={activePane !== "changes"}>
                    Changes
                  </Text>
                </Box>
                {gitStatus && (gitStatus.staged.length > 0 || gitStatus.unstaged.length > 0 || gitStatus.untracked.length > 0) ? (
                  <Box flexDirection="row" paddingX={1} overflow="hidden">
                    {/* Staged */}
                    <Box flexDirection="column" width="50%" overflow="hidden">
                      <Text dimColor>Staged ({gitStatus.staged.length})</Text>
                      {gitStatus.staged.slice(0, 6).map((f) => (
                        <Box key={`s-${f.path}`} flexDirection="row" gap={1}>
                          <Text color={statusColor(f.status)}>{f.status}</Text>
                          <Text color="gray" wrap="truncate">{truncatePath(f.path, Math.floor(leftWidth / 2) - 4)}</Text>
                        </Box>
                      ))}
                      {gitStatus.staged.length > 6 && <Text dimColor>…+{gitStatus.staged.length - 6}</Text>}
                    </Box>
                    {/* Unstaged + untracked */}
                    <Box flexDirection="column" flexGrow={1} overflow="hidden">
                      <Text dimColor>Unstaged ({gitStatus.unstaged.length + gitStatus.untracked.length})</Text>
                      {gitStatus.unstaged.slice(0, 4).map((f) => (
                        <Box key={`u-${f.path}`} flexDirection="row" gap={1}>
                          <Text color={statusColor(f.status)}>{f.status}</Text>
                          <Text color="gray" wrap="truncate">{truncatePath(f.path, Math.floor((isNarrow ? cols : rightWidth) / 2) - 4)}</Text>
                        </Box>
                      ))}
                      {gitStatus.untracked.slice(0, 2).map((f) => (
                        <Box key={`n-${f.path}`} flexDirection="row" gap={1}>
                          <Text color="gray">?</Text>
                          <Text color="gray" wrap="truncate">{truncatePath(f.path, Math.floor((isNarrow ? cols : rightWidth) / 2) - 4)}</Text>
                        </Box>
                      ))}
                      {(gitStatus.unstaged.length + gitStatus.untracked.length) > 6 && (
                        <Text dimColor>…+{gitStatus.unstaged.length + gitStatus.untracked.length - 6}</Text>
                      )}
                    </Box>
                  </Box>
                ) : (
                  <Box paddingX={1}>
                    <Text dimColor>Working tree clean</Text>
                  </Box>
                )}
              </Box>
            )}
          </Box>
        )}
      </Box>

      {/* Footer */}
      <Box paddingX={1} flexDirection="row" gap={1}>
        <Text dimColor>
          [r] refresh  {gitStatus && gitStatus.ahead > 0 ? "[P] push  " : ""}[F] fetch  [↑↓] rows  [←→] status▸branches{worktrees.length > 1 ? "▸worktrees" : ""}▸commits▸changes  [p] project  [Esc/s] back
        </Text>
        {isNarrow && (
          <Text dimColor>[narrow] {activePane}</Text>
        )}
      </Box>

      {/* Project picker overlay */}
      {pickerOpen && (
        <Box position="absolute" marginTop={1} marginLeft={1}>
          <ProjectSelector
            open={true}
            projects={projectsState.projects}
            selectedIndex={projectIndex}
            onSelect={setProjectIndex}
          />
        </Box>
      )}

      {/* Push modal overlay */}
      {pushModal && (
        <Box position="absolute" marginTop={2} marginLeft={4}>
          {pushModal.phase === "confirm" && gitStatus && (
            <PushModal
              status={gitStatus}
              commits={commits}
              onConfirm={() => {
                setPushModal({ phase: "pushing" });
                if (data && projectPath) {
                  data.git.push(projectPath).then((result) => {
                    setPushModal({ phase: "done", message: result.output || (result.success ? "Push successful" : "Push failed"), isError: !result.success });
                    if (result.success) {
                      setTimeout(() => { setPushModal(null); void refresh(); }, 2000);
                    }
                  }).catch((err: unknown) => {
                    setPushModal({ phase: "done", message: err instanceof Error ? err.message : String(err), isError: true });
                  });
                }
              }}
              onCancel={() => setPushModal(null)}
            />
          )}
          {pushModal.phase === "pushing" && (
            <Box
              borderStyle="round"
              borderColor="cyanBright"
              flexDirection="row"
              paddingX={2}
              paddingY={1}
              gap={1}
              backgroundColor="black"
            >
              <Text color="cyanBright"><Spinner type="dots" /></Text>
              <Text color="white">Pushing to origin/{gitStatus?.branch ?? "…"}</Text>
            </Box>
          )}
          {pushModal.phase === "done" && (
            <Box
              borderStyle="round"
              borderColor={pushModal.isError ? "red" : "blue"}
              flexDirection="column"
              paddingX={2}
              paddingY={1}
              backgroundColor="black"
            >
              <Text color={pushModal.isError ? "red" : "green"}>
                {pushModal.message}
              </Text>
              {pushModal.isError && <Text dimColor>[Esc] dismiss</Text>}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

// ── File explorer view ────────────────────────────────────────────────────────

// Directories we never descend into — same list as the data layer denylist.
const FILES_DENYLIST = new Set(["node_modules", ".git", "dist", ".next", "target", "build"]);

type FilesPane = "tree" | "preview";

interface TreeNode {
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  // children loaded; undefined = not yet fetched
  children: TreeNode[] | undefined;
}

// Truncate a path string in the middle: "…/long/path/file.ts"
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return s.slice(0, half) + "…" + s.slice(s.length - (max - half - 1));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// Build the flat visible list from the tree (depth-first, expanded nodes reveal children)
function flattenTree(nodes: TreeNode[], showHidden: boolean): TreeNode[] {
  const result: TreeNode[] = [];
  function walk(list: TreeNode[]) {
    for (const node of list) {
      if (!showHidden && node.entry.name.startsWith(".")) continue;
      result.push(node);
      if (node.expanded && node.children) {
        walk(node.children);
      }
    }
  }
  walk(nodes);
  return result;
}

// Convert FileEntry[] from listDirectory into TreeNode[]
function entriesToNodes(entries: FileEntry[], depth: number): TreeNode[] {
  // Filter denylist entries
  const filtered = entries.filter((e) => !FILES_DENYLIST.has(e.name));
  // Sort: directories first, then files; alphabetical within each group
  const dirs = filtered.filter((e) => e.isDirectory).sort((a, b) => a.name.localeCompare(b.name));
  const files = filtered.filter((e) => !e.isDirectory).sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files].map((e) => ({ entry: e, depth, expanded: false, children: undefined }));
}

function FilesView({ state }: { state: DashboardState }) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  const data = state.interactiveData;

  const [projectIndex, setProjectIndex] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerOriginal, setPickerOriginal] = useState(0);

  const projectsState = useProjects(data);
  const selectedProject = projectsState.projects[projectIndex] ?? null;
  const projectPath = selectedProject?.path ?? null;

  // Tree state
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showHidden, setShowHidden] = useState(false);

  // Preview state
  const [previewResult, setPreviewResult] = useState<FileReadResult | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewScroll, setPreviewScroll] = useState(0);
  const [wrapEnabled, setWrapEnabled] = useState(false);

  // Focus
  const [focusedPane, setFocusedPane] = useState<FilesPane>("tree");

  // Derived flat list for rendering
  const flatNodes = flattenTree(rootNodes, showHidden);
  const selectedNode = flatNodes[selectedIndex] ?? null;

  // Count hidden top-level items for footer hint
  const hiddenCount = rootNodes.filter((n) => n.entry.name.startsWith(".")).length;

  // Load root directory when project changes
  useEffect(() => {
    if (!data || !projectPath) return;
    setTreeLoading(true);
    setRootNodes([]);
    setSelectedIndex(0);
    setPreviewResult(null);
    setPreviewPath(null);
    data.files.listDirectory(projectPath, "").then((entries) => {
      setRootNodes(entriesToNodes(entries, 0));
    }).catch(() => {
      setRootNodes([]);
    }).finally(() => {
      setTreeLoading(false);
    });
  }, [data, projectPath]);

  // Load file preview when selected node changes (only for files, on demand)
  // The preview is loaded when Enter is pressed or pane switches to preview;
  // here we auto-preview when selection lands on a file so it feels snappy.
  useEffect(() => {
    if (!data || !projectPath || !selectedNode) return;
    if (selectedNode.entry.isDirectory) return;
    const rel = selectedNode.entry.path;
    if (rel === previewPath) return; // already loaded
    setPreviewLoading(true);
    setPreviewScroll(0);
    data.files.readFile(projectPath, rel).then((result) => {
      setPreviewResult(result);
      setPreviewPath(rel);
    }).catch(() => {
      setPreviewResult(null);
      setPreviewPath(rel);
    }).finally(() => {
      setPreviewLoading(false);
    });
  }, [data, projectPath, selectedNode?.entry.path]);

  // Expand a directory node and load its children
  const expandNode = useCallback(async (node: TreeNode) => {
    if (!data || !projectPath) return;
    if (!node.entry.isDirectory) return;
    if (node.children !== undefined) {
      // Already loaded — just toggle
      node.expanded = !node.expanded;
      setRootNodes((prev) => [...prev]);
      return;
    }
    try {
      const entries = await data.files.listDirectory(projectPath, node.entry.path);
      node.children = entriesToNodes(entries, node.depth + 1);
      node.expanded = true;
      setRootNodes((prev) => [...prev]);
    } catch {
      node.children = [];
      node.expanded = true;
      setRootNodes((prev) => [...prev]);
    }
  }, [data, projectPath]);

  const collapseNode = useCallback((node: TreeNode) => {
    node.expanded = false;
    setRootNodes((prev) => [...prev]);
  }, []);

  // Find parent node in tree (for left-arrow collapse-to-parent)
  function findParentOf(nodes: TreeNode[], target: TreeNode, depth: number): TreeNode | null {
    for (const n of nodes) {
      if (n.depth === depth - 1 && n.expanded && n.children) {
        if (n.children.includes(target)) return n;
        const found = findParentOf(n.children, target, depth);
        if (found) return found;
      }
    }
    return null;
  }

  // Compute visible preview line count for PgUp/PgDn
  // Reserve: header (3 lines) + footer (2 lines) + pane border (2 lines) = ~7 lines overhead
  const previewHeight = Math.max(4, (stdout?.rows ?? 24) - 7);
  const halfPage = Math.max(1, Math.floor(previewHeight / 2));

  useInput((input, key) => {
    if (!data) return;

    if (pickerOpen) {
      if (key.upArrow || input === "k") { setProjectIndex((p) => Math.max(0, p - 1)); return; }
      if (key.downArrow || input === "j") { setProjectIndex((p) => Math.min(projectsState.projects.length - 1, p + 1)); return; }
      if (key.return) { setPickerOpen(false); return; }
      if (key.escape) { setProjectIndex(pickerOriginal); setPickerOpen(false); return; }
      return;
    }

    if (input === "p") { setPickerOriginal(projectIndex); setPickerOpen(true); return; }

    // Tab cycles pane focus
    if (key.tab) {
      setFocusedPane((p) => p === "tree" ? "preview" : "tree");
      return;
    }

    if (input === ".") {
      setShowHidden((v) => !v);
      return;
    }

    if (input === "w" || input === "W") {
      setWrapEnabled((v) => !v);
      return;
    }

    if (input === "r" || input === "R") {
      // Force-reload the current file preview
      if (data && projectPath && selectedNode && !selectedNode.entry.isDirectory) {
        setPreviewLoading(true);
        setPreviewScroll(0);
        setPreviewPath(null); // clear to force re-fetch via effect
      }
      return;
    }

    if (focusedPane === "tree") {
      if (key.upArrow || input === "k") {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setSelectedIndex((i) => Math.min(flatNodes.length - 1, i + 1));
        return;
      }
      if (key.rightArrow) {
        if (selectedNode?.entry.isDirectory) {
          if (selectedNode.expanded) {
            // Move into first child
            const ci = flatNodes.indexOf(selectedNode) + 1;
            if (ci < flatNodes.length) setSelectedIndex(ci);
          } else {
            void expandNode(selectedNode);
          }
        }
        return;
      }
      if (key.leftArrow) {
        if (selectedNode?.entry.isDirectory && selectedNode.expanded) {
          collapseNode(selectedNode);
        } else if (selectedNode && selectedNode.depth > 0) {
          // Move to parent
          const parent = findParentOf(rootNodes, selectedNode, selectedNode.depth);
          if (parent) {
            const pi = flatNodes.indexOf(parent);
            if (pi >= 0) setSelectedIndex(pi);
          }
        }
        return;
      }
      if (key.return) {
        if (selectedNode?.entry.isDirectory) {
          void expandNode(selectedNode);
        } else if (selectedNode) {
          // Switch to preview pane when opening a file
          setFocusedPane("preview");
          setPreviewScroll(0);
        }
        return;
      }
    }

    if (focusedPane === "preview") {
      const lineCount = previewResult?.lineCount ?? 0;
      const maxScroll = Math.max(0, lineCount - previewHeight);

      if (key.upArrow || input === "k") {
        setPreviewScroll((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setPreviewScroll((s) => Math.min(maxScroll, s + 1));
        return;
      }
      if (key.pageUp) {
        setPreviewScroll((s) => Math.max(0, s - halfPage));
        return;
      }
      if (key.pageDown) {
        setPreviewScroll((s) => Math.min(maxScroll, s + halfPage));
        return;
      }
      if (input === "g") {
        setPreviewScroll(0);
        return;
      }
      if (input === "G") {
        setPreviewScroll(maxScroll);
        return;
      }
    }
  }, { isActive: state.interactiveView === "files" });

  // Narrow mode: collapse tree+preview side-by-side to a single pane so the
  // two columns don't overflow on terminals below the threshold.
  const isNarrow = cols < NARROW_THRESHOLD;
  // Layout: 38% tree, 62% preview; in narrow mode the active pane takes full width
  const treeWidth = isNarrow ? Math.max(20, cols - 2) : Math.max(20, Math.floor(cols * 0.38));

  const previewEntry = selectedNode && !selectedNode.entry.isDirectory ? selectedNode.entry : null;

  // Lines of preview content to show
  const previewLines = previewResult?.content
    ? previewResult.content.split("\n").slice(previewScroll, previewScroll + previewHeight)
    : null;
  const totalLines = previewResult?.lineCount ?? 0;
  const lineNumWidth = Math.max(3, String(previewScroll + previewHeight).length);

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {/* Header strip */}
      <Box flexDirection="row" paddingX={1} gap={1}>
        <Text color="cyanBright" bold>{selectedProject?.name ?? "—"}</Text>
        <Text dimColor>│</Text>
        <Text dimColor color={focusedPane === "tree" ? "cyanBright" : "gray"}>
          {focusedPane === "tree" ? "tree" : "preview"}
        </Text>
        {previewEntry && (
          <>
            <Text dimColor>│</Text>
            <Text color="white" wrap="truncate">{truncateMiddle(previewEntry.path, Math.max(10, cols - 40))}</Text>
            <Text dimColor>│</Text>
            <Text dimColor>{formatFileSize(previewEntry.size)}</Text>
            {previewResult && !previewResult.isBinary && !previewResult.tooLarge && (
              <>
                <Text dimColor>{previewResult.lineCount}L</Text>
                <Text dimColor>{formatRelativeTime(previewEntry.modifiedAt)}</Text>
              </>
            )}
          </>
        )}
      </Box>

      {/* Main pane row — narrow: only the focused pane is rendered at full width */}
      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        {/* Left: tree pane — hidden in narrow mode when preview is focused */}
        {(!isNarrow || focusedPane === "tree") && (
        <Box
          flexDirection="column"
          width={isNarrow ? undefined : treeWidth}
          flexGrow={isNarrow ? 1 : 0}
          flexShrink={0}
          borderStyle="round"
          borderColor={focusedPane === "tree" ? "cyanBright" : "gray"}
          overflow="hidden"
        >
          <Box paddingX={1}>
            <Text bold={focusedPane === "tree"} color={focusedPane === "tree" ? "cyanBright" : undefined} dimColor={focusedPane !== "tree"}>
              Files
            </Text>
          </Box>
          <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
            {treeLoading ? (
              <Box flexDirection="row" gap={1}>
                <Text color="cyanBright"><Spinner type="dots" /></Text>
                <Text dimColor>Loading…</Text>
              </Box>
            ) : flatNodes.length === 0 ? (
              <Text dimColor>(empty)</Text>
            ) : (
              flatNodes.map((node, i) => {
                const isSelected = focusedPane === "tree" && i === selectedIndex;
                const indent = "  ".repeat(node.depth);
                let prefix: string;
                if (node.entry.isDirectory) {
                  prefix = node.expanded ? "▾ " : "▸ ";
                } else {
                  prefix = "· ";
                }
                const name = node.entry.name;
                const maxNameWidth = treeWidth - node.depth * 2 - 4;
                const displayName = name.length > maxNameWidth ? name.slice(0, maxNameWidth - 1) + "…" : name;
                return (
                  <Box key={node.entry.path} flexDirection="row">
                    {isSelected && <Text color="cyanBright">▶</Text>}
                    {!isSelected && <Text> </Text>}
                    <Text
                      color={isSelected ? "whiteBright" : node.entry.isDirectory ? "cyan" : undefined}
                      dimColor={!isSelected && !node.entry.isDirectory}
                      wrap="truncate"
                    >
                      {indent}{prefix}{displayName}
                    </Text>
                  </Box>
                );
              })
            )}
          </Box>
          {/* Tree footer: path strip */}
          <Box paddingX={1}>
            <Text dimColor wrap="truncate">
              {selectedNode
                ? truncateMiddle(
                    projectPath ? `${projectPath}/${selectedNode.entry.path}` : selectedNode.entry.path,
                    treeWidth - 4,
                  )
                : " "}
            </Text>
            {!showHidden && hiddenCount > 0 && (
              <Text dimColor> [{hiddenCount} hidden]</Text>
            )}
          </Box>
        </Box>
        )}

        {/* Right: preview pane — hidden in narrow mode when tree is focused */}
        {(!isNarrow || focusedPane === "preview") && (
          <Box
            flexDirection="column"
            flexGrow={1}
            borderStyle="round"
            borderColor={focusedPane === "preview" ? "cyanBright" : "gray"}
            overflow="hidden"
          >
            <Box paddingX={1}>
              <Text bold={focusedPane === "preview"} color={focusedPane === "preview" ? "cyanBright" : undefined} dimColor={focusedPane !== "preview"}>
                Preview
              </Text>
            </Box>
            <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
              {previewLoading ? (
                <Box flexDirection="row" gap={1}>
                  <Text color="cyanBright"><Spinner type="dots" /></Text>
                  <Text dimColor>Loading…</Text>
                </Box>
              ) : !previewEntry ? (
                <Text dimColor>Select a file to preview</Text>
              ) : previewResult === null ? (
                <Text dimColor>Unable to read file</Text>
              ) : previewResult.isBinary ? (
                <Text dimColor>[binary file, {formatFileSize(previewResult.size)}]</Text>
              ) : previewResult.tooLarge ? (
                <Text dimColor>{formatFileSize(previewResult.size)} — [too large to preview]</Text>
              ) : previewResult.content === "" ? (
                <Text dimColor>(empty file)</Text>
              ) : previewLines ? (
                <Box flexDirection="column" overflow="hidden">
                  {previewLines.map((line, i) => {
                    const lineNo = previewScroll + i + 1;
                    return (
                      <Box key={lineNo} flexDirection="row">
                        <Box width={lineNumWidth + 1} flexShrink={0}>
                          <Text dimColor>{String(lineNo).padStart(lineNumWidth)}</Text>
                        </Box>
                        <Text wrap={wrapEnabled ? "wrap" : "truncate-end"}>{line}</Text>
                      </Box>
                    );
                  })}
                  {totalLines > previewScroll + previewHeight && (
                    <Text dimColor>… {totalLines - previewScroll - previewHeight} more lines</Text>
                  )}
                </Box>
              ) : null}
            </Box>
          </Box>
        )}
      </Box>

      {/* Footer hints */}
      <Box paddingX={1} flexDirection="row" gap={1}>
        <Text dimColor>
          [Tab] switch pane  [↑↓/jk] move  [Enter] open  [←/→] collapse/expand  [.] hidden  [w] wrap  [p] project  [r] reload
        </Text>
        {isNarrow && (
          <Text dimColor>[narrow] {focusedPane}</Text>
        )}
      </Box>

      {/* Project picker overlay */}
      {pickerOpen && (
        <Box position="absolute" marginTop={2} marginLeft={2}>
          <Box
            borderStyle="round"
            borderColor="cyanBright"
            flexDirection="column"
            paddingX={2}
            paddingY={1}
            backgroundColor="black"
          >
            <Text bold color="white">Select Project</Text>
            <Box height={1} />
            {projectsState.projects.map((proj, i) => (
              <Box key={proj.id} flexDirection="row" gap={1}>
                <Text color={i === projectIndex ? "cyanBright" : "gray"}>{i === projectIndex ? "▶" : " "}</Text>
                <Text color={i === projectIndex ? "whiteBright" : undefined}>{proj.name}</Text>
              </Box>
            ))}
            <Box height={1} />
            <Text dimColor>[↑↓] move  [Enter] select  [Esc] cancel</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

// ── Interactive mode root ─────────────────────────────────────────────────────

function InteractiveMode({ state, controller }: { state: DashboardState; controller: DashboardTUI }) {
  if (state.interactiveData === null) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <MainHeader state={state} />
        <Box justifyContent="center" alignItems="center" flexGrow={1}>
          <Text dimColor>Interactive mode unavailable — no data source</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexShrink={0}>
        <MainHeader state={state} />
      </Box>
      <Box height={1} flexShrink={0} />
      <Box flexGrow={1} overflow="hidden">
        {state.interactiveView === "board" && <BoardView state={state} controller={controller} />}
        {state.interactiveView === "agents" && <AgentsView state={state} />}
        {state.interactiveView === "settings" && <SettingsInteractiveView state={state} />}
        {state.interactiveView === "git" && <GitView state={state} />}
        {state.interactiveView === "files" && <FilesView state={state} />}
      </Box>
    </Box>
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────

interface DashboardAppProps {
  controller: DashboardTUI;
}

export function DashboardApp({ controller }: DashboardAppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;

  const state = useSyncExternalStore(
    useCallback((cb) => controller.subscribe(cb), [controller]),
    useCallback(() => controller.getSnapshot(), [controller]),
  );

  // Global key handling
  useInput((input, key) => {
    // Quit
    if (input === "q" || input === "Q" || (key.ctrl && input === "c")) {
      void controller.stop();
      exit();
      process.exit(0);
    }

    // View switching shortcuts — b/a/g enter interactive + set view
    if (input === "b" || input === "B") {
      controller.setMode("interactive");
      controller.setInteractiveView("board");
      return;
    }
    if (input === "a" || input === "A") {
      controller.setMode("interactive");
      controller.setInteractiveView("agents");
      return;
    }
    if (input === "g" || input === "G") {
      controller.setMode("interactive");
      controller.setInteractiveView("settings");
      return;
    }
    // Logs severity filter — works any time the logs panel is visible
    // (status mode). Cycles all → info → warn → error → all.
    if (input === "f" || input === "F") {
      if (state.mode === "status") {
        controller.cycleSeverityFilter();
        return;
      }
    }

    if (input === "t" || input === "T") {
      controller.setMode("interactive");
      controller.setInteractiveView("git");
      return;
    }

    if (input === "e" || input === "E") {
      controller.setMode("interactive");
      controller.setInteractiveView("files");
      return;
    }

    if (input === "s" || input === "S") {
      if (state.mode === "interactive") {
        controller.setMode("status");
        return;
      }
    }

    // Number keys 1-5 always jump to a status-mode section (matching the
    // [1]System [2]Logs [3]Utilities [4]Stats [5]Settings tabs in the
    // MainHeader). They switch back from interactive mode if needed —
    // the interactive views still have letter shortcuts (b/a/g/t).
    const sectionForNumber: Record<string, SectionId | undefined> = {
      "1": "system",
      "2": "logs",
      "3": "utilities",
      "4": "stats",
      "5": "settings",
    };
    const targetSection = sectionForNumber[input];
    if (targetSection) {
      if (state.mode === "interactive") controller.setMode("status");
      controller.setActiveSection(targetSection);
      return;
    }

    // Let interactive views handle their own keys (n/p/arrows/etc).
    if (state.mode === "interactive") {
      return;
    }

    // Help toggle
    if (input === "?" || input === "h" || input === "H") {
      controller.setShowHelp(!state.showHelp);
      return;
    }

    // Status mode: Enter from the System panel opens the dashboard URL in
    // the user's browser. Logs panel handles Enter itself (expand log entry)
    // so we gate by activeSection.
    if (key.return && state.activeSection === "system" && state.systemInfo) {
      const url = state.systemInfo.tokenizedUrl ?? state.systemInfo.baseUrl;
      openInBrowser(url);
      return;
    }

    // Number keys switch panels (status mode)
    if (input >= "1" && input <= "5") {
      const section = SECTION_ORDER[parseInt(input, 10) - 1];
      if (section) {
        controller.setActiveSection(section);
      }
      return;
    }

    // Tab / Shift+Tab cycle focused panel
    if (key.tab) {
      const shift = key.shift;
      const idx = PANEL_ORDER.indexOf(state.activeSection);
      if (shift) {
        controller.setActiveSection(PANEL_ORDER[(idx - 1 + PANEL_ORDER.length) % PANEL_ORDER.length]);
      } else {
        controller.setActiveSection(PANEL_ORDER[(idx + 1) % PANEL_ORDER.length]);
      }
      return;
    }

    // Arrow/n/p navigation (skip when logs expanded)
    if (key.rightArrow || input === "n" || input === "N") {
      if (state.activeSection !== "logs" || !state.logsExpandedMode) {
        controller.cycleSection(1);
      }
      return;
    }
    if (key.leftArrow || input === "p" || input === "P") {
      if (state.activeSection !== "logs" || !state.logsExpandedMode) {
        controller.cycleSection(-1);
      }
      return;
    }

    // Utilities actions
    if (state.activeSection === "utilities") {
      void controller.handleUtilityAction(input);
      return;
    }

    // Logs-specific keys
    if (state.activeSection === "logs") {
      const filteredEntries = controller.getFilteredLogEntries();

      if (key.escape) {
        if (state.logsExpandedMode) {
          controller.setLogsExpandedMode(false);
          controller.setShowHelp(false);
        } else if (state.showHelp) {
          controller.setShowHelp(false);
        }
        return;
      }

      if (key.return || input === " " || input === "e" || input === "E") {
        if (filteredEntries.length > 0) {
          controller.setLogsExpandedMode(!state.logsExpandedMode);
        }
        return;
      }

      if (input === "w" || input === "W") {
        controller.setLogsWrapEnabled(!state.logsWrapEnabled);
        return;
      }

      if (key.upArrow || input === "k" || input === "K") {
        if (state.selectedLogIndex > 0) {
          controller.setSelectedLogIndex(state.selectedLogIndex - 1);
        }
        return;
      }

      if (key.downArrow || input === "j" || input === "J") {
        if (state.selectedLogIndex < filteredEntries.length - 1) {
          controller.setSelectedLogIndex(state.selectedLogIndex + 1);
        }
        return;
      }

      if (key.home) {
        controller.setSelectedLogIndex(0);
        return;
      }

      // Vim-style "G" jumps to the newest log entry. "g" stays as the
      // global Settings shortcut, so we don't bind it here.
      if (key.end || input === "G") {
        controller.setSelectedLogIndex(Math.max(0, filteredEntries.length - 1));
        return;
      }
    }
  });

  // Splash: show while systemInfo is not yet set
  if (!state.systemInfo) {
    return (
      <Box flexDirection="column" height={rows}>
        <SplashScreen loadingStatus={state.loadingStatus} />
      </Box>
    );
  }

  const isNarrow = cols < 80 || rows < 20;

  return (
    <Box flexDirection="column" height={rows}>
      {state.mode === "interactive" ? (
        <InteractiveMode state={state} controller={controller} />
      ) : isNarrow ? (
        <StatusModeSingle state={state} controller={controller} />
      ) : (
        <StatusModeGrid state={state} rows={rows} controller={controller} />
      )}
      {state.showHelp && (
        <Box position="absolute" marginTop={3} marginLeft={4}>
          <HelpOverlay />
        </Box>
      )}
    </Box>
  );
}
