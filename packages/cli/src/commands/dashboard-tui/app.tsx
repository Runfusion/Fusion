import React, { useState, useSyncExternalStore, useCallback, useEffect } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import Spinner from "ink-spinner";
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
} from "./state.js";
import { SECTION_ORDER } from "./state.js";
import type { LogEntry } from "./log-ring-buffer.js";
import { FUSION_LOGO_LINES, FUSION_TAGLINE } from "./logo.js";
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

// All-blue vertical gradient — top: brightest, bottom: shadow.
const LOGO_COLORS = ["whiteBright", "cyanBright", "cyan", "blueBright", "blue", "blue"] as const;
type InkColor = typeof LOGO_COLORS[number];

function logoColor(index: number): InkColor {
  return LOGO_COLORS[Math.min(index, LOGO_COLORS.length - 1)];
}

// ── Brand mark ────────────────────────────────────────────────────────────────

const FUSION_MARK_LINES = [
  "   ╭─────╮   ",
  "  ╱     ╱╲   ",
  " │    ╱  │   ",
  " │   ╱   │   ",
  "  ╲ ╱   ╱    ",
  "   ╰───╯     ",
];

function FusionMark() {
  return (
    <Box flexDirection="column" alignItems="center">
      {FUSION_MARK_LINES.map((line, i) => (
        <Text key={i} color="cyanBright" bold>{line}</Text>
      ))}
    </Box>
  );
}

function AnimatedFusionLogo() {
  return (
    <Box flexDirection="column" alignItems="center">
      {FUSION_LOGO_LINES.map((line, i) => (
        <Text key={i} color={logoColor(i)} bold>{line}</Text>
      ))}
    </Box>
  );
}

// ── Splash screen ─────────────────────────────────────────────────────────────

// Smallest terminal that can fit the full block-letter splash centered.
// Below either threshold we drop into a compact top-left layout so nothing
// gets clipped or re-centered awkwardly.
const SPLASH_MIN_COLS = 56;
const SPLASH_MIN_ROWS = 20;

function SplashScreen({ loadingStatus }: { loadingStatus: string }) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const compact = cols < SPLASH_MIN_COLS || rows < SPLASH_MIN_ROWS;

  if (compact) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <FusionMark />
        <Box height={1} />
        <Text bold color="cyanBright">FUSION</Text>
        <Text color="blueBright" dimColor>{FUSION_TAGLINE}</Text>
        <Box height={1} />
        <Box flexDirection="row" gap={1}>
          <Text color="cyanBright"><Spinner type="dots" /></Text>
          <Text color="blueBright" dimColor>{loadingStatus}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      flexGrow={1}
    >
      <FusionMark />
      <Box height={1} />
      <AnimatedFusionLogo />
      <Box height={1} />
      <Text color="blueBright" dimColor>{FUSION_TAGLINE}</Text>
      <Box height={1} />
      <Box flexDirection="row" gap={1}>
        <Text color="cyanBright"><Spinner type="dots" /></Text>
        <Text color="blueBright" dimColor>{loadingStatus}</Text>
      </Box>
    </Box>
  );
}

// ── Mini inline logo (header) ─────────────────────────────────────────────────

function MiniLogo() {
  return (
    <Box flexDirection="row" gap={0}>
      <Text color="cyan" bold>FUSION</Text>
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
      borderColor={isFocused ? "cyan" : "gray"}
      flexDirection="column"
      flexGrow={flexGrow}
      flexShrink={flexShrink}
      width={width}
      overflow="hidden"
    >
      <Box paddingX={1}>
        <Text bold={isFocused} color={isFocused ? "cyan" : undefined} dimColor={!isFocused}>
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
            <Text color="cyan">{info.baseUrl}</Text>
          </Box>
          {info.authEnabled ? (
            <>
              <Box flexDirection="row" gap={1}>
                <Text dimColor>Auth:</Text>
                <Text color="yellow">bearer token</Text>
              </Box>
              {info.authToken && (
                <Box flexDirection="row" gap={1}>
                  <Text dimColor>Token:</Text>
                  <Text wrap="truncate">{info.authToken}</Text>
                </Box>
              )}
            </>
          ) : (
            <Box flexDirection="row" gap={1}>
              <Text dimColor>Auth:</Text>
              <Text dimColor>disabled</Text>
            </Box>
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

function StatsPanel({ state, isFocused }: { state: DashboardState; isFocused: boolean }) {
  const stats = state.taskStats;
  return (
    <Panel title="Stats" isFocused={isFocused} flexGrow={1}>
      {!stats ? (
        <Text dimColor>Statistics not available.</Text>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text dimColor>Total:</Text>
            <Text>{stats.total}</Text>
          </Box>
          {Object.entries(stats.byColumn).map(([col, count]) => {
            const name = col.replace(/-/g, " ");
            const isActive = (col === "in-progress" || col === "in-review") && count > 0;
            return (
              <Box key={col} flexDirection="row" gap={1} marginLeft={1}>
                <Text dimColor>{name}:</Text>
                <Text color={isActive ? "green" : undefined}>{count}</Text>
              </Box>
            );
          })}
          <Box height={1} />
          <Text dimColor>Agents:</Text>
          <Box marginLeft={1} flexDirection="column">
            <Text dimColor>idle: <Text color="white">{stats.agents.idle}</Text></Text>
            <Text dimColor>active: <Text color="green">{stats.agents.active}</Text></Text>
            <Text color={stats.agents.error > 0 ? "red" : undefined} dimColor={stats.agents.error === 0}>
              error: {stats.agents.error}
            </Text>
          </Box>
        </Box>
      )}
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

  const visibleEntries = entries.slice(-availableRows);
  const visibleStart = Math.max(0, entries.length - availableRows);

  return (
    <Panel title={`Logs (${state.logEntries.length}/1000)`} isFocused={isFocused} flexGrow={1}>
      {logsExpandedMode && entries[selectedLogIndex] ? (
        <ExpandedLog
          entry={entries[selectedLogIndex]}
          index={selectedLogIndex}
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
          </Box>
          {[...visibleEntries].reverse().map((entry, displayIdx) => {
            const absoluteIndex = visibleStart + visibleEntries.length - 1 - displayIdx;
            const isSelected = absoluteIndex === selectedLogIndex;
            // Selected row: blue background + bright arrow + bold text. The
            // background spans the whole row so the cursor is visible at a
            // glance even on a busy logs panel.
            const bg = isSelected ? "blue" : undefined;
            const fg = isSelected ? "whiteBright" : undefined;
            return (
              <Box key={`${entry.timestamp.getTime()}-${displayIdx}`} flexDirection="row" gap={1}>
                <Text backgroundColor={bg} color={isSelected ? "cyanBright" : "gray"} bold={isSelected}>
                  {isSelected ? "▶" : " "}
                </Text>
                <Text backgroundColor={bg} color={fg} dimColor={!isSelected}>
                  {formatTimestamp(entry.timestamp)}
                </Text>
                <Text backgroundColor={bg}>
                  <LevelBadge level={entry.level} />
                </Text>
                {entry.prefix && (
                  <Text backgroundColor={bg} color={fg} dimColor={!isSelected}>
                    [{entry.prefix}]
                  </Text>
                )}
                <Text
                  backgroundColor={bg}
                  color={fg}
                  bold={isSelected}
                  wrap={logsWrapEnabled ? "wrap" : "truncate"}
                >
                  {entry.message}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
    </Panel>
  );
}

function ExpandedLog({ entry, index, total }: { entry: LogEntry; index: number; total: number }) {
  return (
    <Box flexDirection="column">
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
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" backgroundColor="black">
      <Text backgroundColor="black" bold color="cyanBright">{titleRow}</Text>
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
      <Box flexDirection="row" gap={1} paddingX={1} paddingY={0}>
        <MiniLogo />
        <Text dimColor>│</Text>
        {SECTION_ORDER.map((section, i) => {
          const isActive = section === focused;
          const label = section.charAt(0).toUpperCase() + section.slice(1);
          return (
            <Box key={section} marginRight={1}>
              {isActive ? (
                <Text backgroundColor="cyan" color="black" bold>{` [${i + 1}] ${label} `}</Text>
              ) : (
                <Text dimColor>{`[${i + 1}] ${label}`}</Text>
              )}
            </Box>
          );
        })}
        <Box flexGrow={1} />
        <Text dimColor>[b] board  [a] agents  [g] settings  [?] help  [q] quit</Text>
      </Box>

      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          <SystemPanel state={state} isFocused={focused === "system"} />
          <StatsPanel state={state} isFocused={focused === "stats"} />
          <SettingsPanel state={state} isFocused={focused === "settings"} />
        </Box>
        <Box flexDirection="column" flexGrow={2} overflow="hidden">
          <LogsPanel
            state={state}
            isFocused={focused === "logs"}
            availableRows={logsAvailableRows}
          />
          <UtilitiesPanel isFocused={focused === "utilities"} />
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
      <Box flexDirection="row" gap={1} paddingX={1}>
        <MiniLogo />
        <Text dimColor>│</Text>
        {SECTION_ORDER.map((section, i) => {
          const isActive = section === focused;
          const label = section.charAt(0).toUpperCase() + section.slice(1);
          return (
            <Box key={section} marginRight={1}>
              {isActive ? (
                <Text backgroundColor="cyan" color="black" bold>{` [${i + 1}] ${label} `}</Text>
              ) : (
                <Text dimColor>{`[${i + 1}] ${label}`}</Text>
              )}
            </Box>
          );
        })}
      </Box>
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

// ── Interactive mode header / tab strip ───────────────────────────────────────

function InteractiveHeader({ activeView }: { activeView: InteractiveView }) {
  const tabs: Array<{ key: string; label: string; view: InteractiveView }> = [
    { key: "b", label: "Board", view: "board" },
    { key: "a", label: "Agents", view: "agents" },
    { key: "g", label: "Settings", view: "settings" },
  ];
  return (
    <Box flexDirection="row" gap={2} paddingX={1}>
      <MiniLogo />
      <Text dimColor>│</Text>
      {tabs.map(({ key, label, view }) => {
        const isActive = view === activeView;
        return isActive ? (
          <Text key={view} backgroundColor="cyan" color="black" bold>{` [${key}] ${label} `}</Text>
        ) : (
          <Text key={view} dimColor>{`[${key}] ${label}`}</Text>
        );
      })}
      <Box flexGrow={1} />
      <Text dimColor>[s] status  [?] help  [q] quit</Text>
    </Box>
  );
}

// ── Kanban board ──────────────────────────────────────────────────────────────

const KANBAN_COLUMNS = ["todo", "in-progress", "in-review", "done"] as const;
type KanbanColumn = typeof KANBAN_COLUMNS[number];

const COLUMN_COLORS: Record<string, "yellow" | "cyan" | "magenta" | "green"> = {
  todo: "yellow",
  "in-progress": "cyan",
  "in-review": "magenta",
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
      <Text bold={selected} color={titleColor} wrap="truncate-end">
        {task.title ?? task.id}
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
}: {
  column: KanbanColumn;
  tasks: TaskItem[];
  isFocused: boolean;
  selectedIndex: number;
  width: number;
}) {
  const accent = COLUMN_COLORS[column];
  const headerColor = isFocused ? "whiteBright" : accent;
  const cardWidth = Math.max(12, width - 4);
  return (
    <Box flexDirection="column" width={width} flexShrink={0} paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Text bold color={headerColor} backgroundColor={isFocused ? accent : undefined}>
          {` ${columnLabel(column).toUpperCase()} `}
        </Text>
        <Text dimColor>{tasks.length}</Text>
      </Box>
      <Box height={1} />
      {tasks.length === 0 ? (
        <Text dimColor>—</Text>
      ) : (
        <Box flexDirection="column" gap={0}>
          {tasks.map((task, i) => (
            <TaskCard
              key={task.id}
              task={task}
              selected={isFocused && i === selectedIndex}
              width={cardWidth}
            />
          ))}
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
        <Text bold color="cyanBright">{current?.name ?? "(none)"}</Text>
        <Text dimColor>[p] change</Text>
      </Box>
    );
  }
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
      backgroundColor="black"
      width={Math.max(30, ...projects.map((p) => p.name.length + 4))}
    >
      <Text bold color="cyan" backgroundColor="black">Pick a project</Text>
      {projects.length === 0 ? (
        <Text dimColor backgroundColor="black">(no projects registered)</Text>
      ) : (
        projects.map((p, i) => {
          const isSel = i === selectedIndex;
          return (
            <Box key={p.id} flexDirection="row" gap={1} backgroundColor="black">
              <Text color={isSel ? "cyanBright" : "gray"} backgroundColor="black">{isSel ? "▶" : " "}</Text>
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

function TaskDetailScreen({ task }: { task: TaskItem }) {
  const accent = COLUMN_COLORS[task.column] ?? "white";
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      flexGrow={1}
    >
      <Text dimColor>{task.id}</Text>
      <Box height={1} />
      <Text bold color="whiteBright" wrap="wrap">{task.title ?? task.id}</Text>
      <Box height={1} />
      <Box flexDirection="row" gap={2}>
        <Box>
          <Text dimColor>Column </Text>
          <Text color={accent} bold>{columnLabel(task.column)}</Text>
        </Box>
        {task.agentState && (
          <Box>
            <Text dimColor>Agent </Text>
            <Text color={accent} bold>{task.agentState}</Text>
          </Box>
        )}
      </Box>
      {task.description && (
        <>
          <Box height={1} />
          <Text dimColor>──── Description ────</Text>
          <Box height={1} />
          <Text wrap="wrap">{task.description}</Text>
        </>
      )}
      <Box flexGrow={1} />
      <Text dimColor>[Esc / Backspace] back to board · [q] quit</Text>
    </Box>
  );
}

type BoardSubView = "board" | "detail" | "picker";

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

function BoardView({ state }: { state: DashboardState }) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const columnWidth = Math.max(20, Math.floor((cols - 2) / KANBAN_COLUMNS.length));

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

  const projectsState = useProjects(state.interactiveData);
  const selectedProject = projectsState.projects[projectIndex] ?? null;
  const tasksState = useTasks(state.interactiveData, selectedProject);
  const grouped = groupTasksByColumn(tasksState.tasks);

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

    if (input === "p" || input === "P") {
      setPickerOriginal(projectIndex);
      setSubView("picker");
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

  const hintText = subView === "picker"
    ? "↑↓ pick · Enter confirm · Esc cancel"
    : subView === "detail"
    ? "Esc back · q quit"
    : "←→ column · ↑↓ task · Enter open · p project";

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="row" gap={2} paddingX={1}>
        <ProjectSelector
          open={subView === "picker"}
          projects={projectsState.projects}
          selectedIndex={projectIndex}
          onSelect={setProjectIndex}
        />
        <Box flexGrow={1} />
        <Text dimColor>{hintText}</Text>
      </Box>

      <Box height={1} />

      {subView === "detail" && selectedTask ? (
        <Box flexGrow={1} paddingX={1}>
          <TaskDetailScreen task={selectedTask} />
        </Box>
      ) : tasksState.loading ? (
        <Box justifyContent="center" alignItems="center" flexGrow={1} gap={1}>
          <Text color="cyanBright"><Spinner type="dots" /></Text>
          <Text dimColor>Loading tasks…</Text>
        </Box>
      ) : tasksState.tasks.length === 0 ? (
        <Box justifyContent="center" alignItems="center" flexGrow={1} flexDirection="column">
          <Text dimColor>No tasks in this project.</Text>
          <Text dimColor>Press [p] to switch projects.</Text>
        </Box>
      ) : (
        <Box flexDirection="row" flexGrow={1} overflow="hidden">
          {KANBAN_COLUMNS.map((col, i) => (
            <KanbanColumnView
              key={col}
              column={col}
              tasks={grouped[col]}
              isFocused={i === colIndex}
              selectedIndex={rowByColumn[col] ?? 0}
              width={columnWidth}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

// ── Agents view ───────────────────────────────────────────────────────────────

function agentStateColor(state: string): string {
  switch (state) {
    case "active": return "cyan";
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
        {/* Left: agent list */}
        <Box
          borderStyle="round"
          borderColor={detailFocused ? "gray" : "cyan"}
          flexDirection="column"
          width="30%"
          overflow="hidden"
        >
          <Box paddingX={1}>
            <Text bold={!detailFocused} color={!detailFocused ? "cyan" : undefined} dimColor={detailFocused}>
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
                    <Text color={isSel ? "cyanBright" : "gray"}>{isSel ? "▶" : " "}</Text>
                    <Box flexDirection="column" flexGrow={1}>
                      <Box flexDirection="row" gap={1}>
                        <Text bold={isSel} color={isSel ? "whiteBright" : undefined} wrap="truncate">
                          {agent.name}
                        </Text>
                        <Text color={agentStateColor(agent.state) as "cyan" | "green" | "red" | "gray"}>
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

        {/* Right: agent detail */}
        <Box
          borderStyle="round"
          borderColor={detailFocused ? "cyan" : "gray"}
          flexDirection="column"
          flexGrow={1}
          overflow="hidden"
        >
          <Box paddingX={1}>
            <Text bold={detailFocused} color={detailFocused ? "cyan" : undefined} dimColor={!detailFocused}>
              Agent Detail
            </Text>
          </Box>
          <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
            {!selectedAgent ? (
              <Text dimColor>Select an agent from the list.</Text>
            ) : loadingDetail ? (
              <Box flexDirection="row" gap={1}>
                <Text color="cyanBright"><Spinner type="dots" /></Text>
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
                  <Text color={agentStateColor(detail.state) as "cyan" | "green" | "red" | "gray"} bold>
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
                    <Text color="cyan">{detail.taskId}</Text>
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
      </Box>

      {/* Footer */}
      <Box paddingX={1}>
        <Text dimColor>[s] start  [x] stop  [D] delete  [r] refresh  [Tab] switch panel focus  ↑↓ select</Text>
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
      return <Text color="cyan">{String(v)}</Text>;
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
          borderColor={detailFocused ? "gray" : "cyan"}
          flexDirection="column"
          width="35%"
          overflow="hidden"
        >
          <Box paddingX={1}>
            <Text bold={!detailFocused} color={!detailFocused ? "cyan" : undefined} dimColor={detailFocused}>
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
                    <Text color={isSel ? "cyanBright" : "gray"}>{isSel ? "▶" : " "}</Text>
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
          borderColor={detailFocused ? "cyan" : "gray"}
          flexDirection="column"
          flexGrow={1}
          overflow="hidden"
        >
          <Box paddingX={1}>
            <Text bold={detailFocused} color={detailFocused ? "cyan" : undefined} dimColor={!detailFocused}>
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
                        <Text color={(localSettings[selectedDef.key] as string) === opt ? "cyanBright" : "gray"}>
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

// ── Interactive mode root ─────────────────────────────────────────────────────

function InteractiveMode({ state }: { state: DashboardState }) {
  if (state.interactiveData === null) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <InteractiveHeader activeView={state.interactiveView} />
        <Box justifyContent="center" alignItems="center" flexGrow={1}>
          <Text dimColor>Interactive mode unavailable — no data source</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <InteractiveHeader activeView={state.interactiveView} />
      <Box height={1} />
      <Box flexGrow={1} overflow="hidden">
        {state.interactiveView === "board" && <BoardView state={state} />}
        {state.interactiveView === "agents" && <AgentsView state={state} />}
        {state.interactiveView === "settings" && <SettingsInteractiveView state={state} />}
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

    if (input === "s" || input === "S") {
      if (state.mode === "interactive") {
        controller.setMode("status");
        return;
      }
    }

    // Interactive mode: number keys 1/2/3 jump to Board/Agents/Settings
    if (state.mode === "interactive") {
      if (input === "1") { controller.setInteractiveView("board"); return; }
      if (input === "2") { controller.setInteractiveView("agents"); return; }
      if (input === "3") { controller.setInteractiveView("settings"); return; }
      // Let the active view handle other keys
      return;
    }

    // Help toggle
    if (input === "?" || input === "h" || input === "H") {
      controller.setShowHelp(!state.showHelp);
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

      if (input === "f" || input === "F") {
        controller.cycleSeverityFilter();
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

      if (key.end) {
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

  const isNarrow = cols < 100 || rows < 24;

  return (
    <Box flexDirection="column" height={rows}>
      {state.mode === "interactive" ? (
        <InteractiveMode state={state} />
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
