import "./TerminalLauncher.css";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Loader2, Play, Settings, Terminal } from "lucide-react";
import { fetchScripts } from "../api";

interface DropdownPosition {
  top: number;
  left: number;
  width: number;
}

export interface TerminalLauncherProps {
  projectId?: string;
  onToggleTerminal?: () => void;
  onOpenScripts?: () => void;
  onRunScript?: (name: string, command: string) => void;
  variant?: "header" | "footer";
  compact?: boolean;
}

/*
FNXC:Terminal 2026-06-21-22:05:
FN-6887 extracts the terminal launcher (icon, Terminal label, and scripts dropdown) so desktop/tablet can render the single canonical launcher in the footer status bar instead of the Header toolbar.
*/
export function TerminalLauncher({
  projectId,
  onToggleTerminal,
  onOpenScripts,
  onRunScript,
  variant = "footer",
  compact = false,
}: TerminalLauncherProps) {
  const { t } = useTranslation("app");
  const [isScriptsOpen, setIsScriptsOpen] = useState(false);
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [scriptsLoading, setScriptsLoading] = useState(false);
  const [highlightedScriptIndex, setHighlightedScriptIndex] = useState(-1);
  const [scriptsDropdownPosition, setScriptsDropdownPosition] = useState<DropdownPosition | null>(null);
  const splitButtonRef = useRef<HTMLDivElement>(null);
  const chevronButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const scriptEntries = useMemo(() => Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b)), [scripts]);
  const showScriptsFooter = scriptEntries.length > 0;
  const totalScriptItems = scriptEntries.length + (showScriptsFooter ? 1 : 0);
  const scriptsEnabled = Boolean(onOpenScripts && onRunScript);

  const getEffectiveViewport = useCallback(() => {
    const vv = window.visualViewport;
    if (vv && vv.width > 0 && vv.height > 0) {
      return { width: vv.width, height: vv.height, offsetTop: vv.offsetTop, offsetLeft: vv.offsetLeft };
    }
    return { width: window.innerWidth, height: window.innerHeight, offsetTop: 0, offsetLeft: 0 };
  }, []);

  const updateScriptsDropdownPosition = useCallback(() => {
    const trigger = chevronButtonRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const menu = menuRef.current;
    const { width: viewportWidth, height: viewportHeight, offsetTop, offsetLeft } = getEffectiveViewport();
    const rootStyle = getComputedStyle(document.documentElement);
    const horizontalPadding = Number.parseFloat(rootStyle.getPropertyValue("--space-md")) || 16;
    const verticalPadding = horizontalPadding;
    const gap = Number.parseFloat(rootStyle.getPropertyValue("--space-xs")) || 6;
    const minWidth = Number.parseFloat(rootStyle.getPropertyValue("--terminal-launcher-menu-min-width")) || 160;
    const preferredWidth = Number.parseFloat(rootStyle.getPropertyValue("--terminal-launcher-menu-width")) || 260;
    const preferredHeight = Number.parseFloat(rootStyle.getPropertyValue("--terminal-launcher-menu-height")) || 280;

    const measuredWidth = menu?.offsetWidth || Math.max(rect.width, preferredWidth);
    const width = Math.min(measuredWidth, Math.max(viewportWidth - horizontalPadding * 2, minWidth));
    const measuredHeight = menu?.offsetHeight || preferredHeight;
    const constrainedHeight = Math.min(measuredHeight, Math.max(viewportHeight - verticalPadding * 2, minWidth));
    const triggerTop = rect.top - offsetTop;
    const triggerBottom = rect.bottom - offsetTop;
    const triggerRight = rect.right - offsetLeft;
    const spaceBelow = viewportHeight - triggerBottom;
    const spaceAbove = triggerTop;
    const openUpward = spaceBelow < constrainedHeight && spaceAbove > spaceBelow;
    const left = Math.min(
      Math.max(triggerRight - width, horizontalPadding),
      viewportWidth - horizontalPadding - width,
    ) + offsetLeft;
    const top = openUpward
      ? Math.max(verticalPadding + offsetTop, triggerTop - constrainedHeight - gap + offsetTop)
      : Math.min(triggerBottom + gap + offsetTop, viewportHeight + offsetTop - verticalPadding - constrainedHeight);

    setScriptsDropdownPosition({ top, left, width });
  }, [getEffectiveViewport]);

  const handleRunQuickScript = useCallback((name: string, command: string) => {
    onRunScript?.(name, command);
    setIsScriptsOpen(false);
    setHighlightedScriptIndex(-1);
  }, [onRunScript]);

  const handleManageScripts = useCallback(() => {
    onOpenScripts?.();
    setIsScriptsOpen(false);
    setHighlightedScriptIndex(-1);
  }, [onOpenScripts]);

  const handleScriptsDropdownKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (totalScriptItems > 0) setHighlightedScriptIndex((prev) => (prev < totalScriptItems - 1 ? prev + 1 : 0));
        break;
      case "ArrowUp":
        e.preventDefault();
        if (totalScriptItems > 0) setHighlightedScriptIndex((prev) => (prev > 0 ? prev - 1 : totalScriptItems - 1));
        break;
      case "Enter":
        e.preventDefault();
        if (highlightedScriptIndex >= 0) {
          if (highlightedScriptIndex < scriptEntries.length) {
            const [name, command] = scriptEntries[highlightedScriptIndex];
            handleRunQuickScript(name, command);
          } else if (showScriptsFooter && highlightedScriptIndex === scriptEntries.length) {
            handleManageScripts();
          }
        }
        break;
      case "Home":
        e.preventDefault();
        if (totalScriptItems > 0) setHighlightedScriptIndex(0);
        break;
      case "End":
        e.preventDefault();
        if (totalScriptItems > 0) setHighlightedScriptIndex(totalScriptItems - 1);
        break;
    }
  }, [handleManageScripts, handleRunQuickScript, highlightedScriptIndex, scriptEntries, showScriptsFooter, totalScriptItems]);

  useEffect(() => {
    if (!isScriptsOpen || !scriptsEnabled) return;
    let cancelled = false;
    setScriptsLoading(true);
    fetchScripts(projectId)
      .then((data) => {
        if (!cancelled) setScripts(data);
      })
      .catch(() => {
        if (!cancelled) setScripts({});
      })
      .finally(() => {
        if (!cancelled) setScriptsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isScriptsOpen, projectId, scriptsEnabled]);

  useEffect(() => {
    if (!isScriptsOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (splitButtonRef.current && !splitButtonRef.current.contains(e.target as Node)) {
        setIsScriptsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isScriptsOpen]);

  useEffect(() => {
    if (!isScriptsOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsScriptsOpen(false);
        chevronButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isScriptsOpen]);

  useEffect(() => {
    if (isScriptsOpen) {
      setHighlightedScriptIndex(-1);
      const timeoutId = window.setTimeout(() => menuRef.current?.focus(), 0);
      return () => window.clearTimeout(timeoutId);
    }
    setScriptsDropdownPosition(null);
  }, [isScriptsOpen]);

  useEffect(() => {
    if (!isScriptsOpen) return;
    const rafId = requestAnimationFrame(() => updateScriptsDropdownPosition());
    return () => cancelAnimationFrame(rafId);
  }, [isScriptsOpen, scriptsLoading, scriptEntries.length, showScriptsFooter, updateScriptsDropdownPosition]);

  useEffect(() => {
    if (!isScriptsOpen) return;
    const handleReposition = () => updateScriptsDropdownPosition();
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", handleReposition);
      vv.addEventListener("scroll", handleReposition);
    }
    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
      if (vv) {
        vv.removeEventListener("resize", handleReposition);
        vv.removeEventListener("scroll", handleReposition);
      }
    };
  }, [isScriptsOpen, updateScriptsDropdownPosition]);

  return (
    <div className={`terminal-launcher terminal-launcher--${variant}${compact ? " terminal-launcher--compact" : ""}`} ref={splitButtonRef}>
      <button
        className="btn terminal-launcher__main"
        onClick={onToggleTerminal}
        title={t("header.openTerminal", "Open Terminal")}
        data-testid="terminal-toggle-btn"
        type="button"
      >
        <Terminal size={16} />
        {!compact && <span className="terminal-launcher__label">{t("header.terminal", "Terminal")}</span>}
      </button>
      {scriptsEnabled && (
        <>
          <span className="terminal-launcher__divider" />
          <button
            ref={chevronButtonRef}
            className={`btn-icon terminal-launcher__chevron${isScriptsOpen ? " btn-icon--active" : ""}`}
            onClick={() => setIsScriptsOpen((prev) => !prev)}
            title={t("header.scripts", "Scripts")}
            aria-haspopup="listbox"
            aria-expanded={isScriptsOpen}
            aria-label={t("header.quickScripts", "Quick scripts")}
            data-testid="scripts-btn"
            type="button"
          >
            <ChevronDown size={12} className={`quick-scripts-dropdown__trigger-chevron${isScriptsOpen ? " rotate" : ""}`} />
          </button>
          {isScriptsOpen && (
            <div
              ref={menuRef}
              tabIndex={-1}
              className="quick-scripts-dropdown__menu"
              role="listbox"
              aria-label={t("header.scripts", "Scripts")}
              onKeyDown={handleScriptsDropdownKeyDown}
              data-testid="quick-scripts-dropdown"
              style={scriptsDropdownPosition ? { position: "fixed", top: `${scriptsDropdownPosition.top}px`, left: `${scriptsDropdownPosition.left}px`, width: `${scriptsDropdownPosition.width}px`, right: "auto" } : undefined}
            >
              {scriptsLoading ? (
                <div className="quick-scripts-dropdown__loading" data-testid="quick-scripts-loading">
                  <Loader2 size={16} className="animate-spin" />
                  <span>{t("header.loadingScripts", "Loading scripts...")}</span>
                </div>
              ) : scriptEntries.length === 0 ? (
                <div className="quick-scripts-dropdown__empty" data-testid="quick-scripts-empty">
                  <div className="quick-scripts-dropdown__empty-icon"><Terminal size={16} /></div>
                  <p>{t("header.noScriptsConfigured", "No scripts configured")}</p>
                  <button className="quick-scripts-dropdown__empty-action btn" onClick={handleManageScripts} type="button">
                    {t("header.addFirstScript", "Add your first script")}
                  </button>
                </div>
              ) : (
                <>
                  <div className="quick-scripts-dropdown__list">
                    {scriptEntries.map(([name, command], index) => (
                      <button
                        key={name}
                        className={`quick-scripts-dropdown__item ${highlightedScriptIndex === index ? "highlighted" : ""}`}
                        onClick={() => handleRunQuickScript(name, command)}
                        role="option"
                        aria-selected={highlightedScriptIndex === index}
                        data-testid={`quick-script-item-${name}`}
                        type="button"
                      >
                        <Play size={14} className="quick-scripts-dropdown__item-icon" />
                        <div className="quick-scripts-dropdown__item-info">
                          <span className="quick-scripts-dropdown__item-name">{name}</span>
                          <span className="quick-scripts-dropdown__item-command" title={command}>{command.length > 50 ? `${command.slice(0, 50)}...` : command}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                  <div className="quick-scripts-dropdown__footer">
                    <button
                      className={`quick-scripts-dropdown__manage ${showScriptsFooter && highlightedScriptIndex === scriptEntries.length ? "highlighted" : ""}`}
                      onClick={handleManageScripts}
                      data-testid="quick-scripts-manage"
                      type="button"
                    >
                      <Settings size={14} />
                      <span>{t("header.manageScripts", "Manage Scripts...")}</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
