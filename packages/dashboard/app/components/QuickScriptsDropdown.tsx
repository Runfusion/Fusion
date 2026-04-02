import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Terminal, Play, Settings, Loader2, ChevronDown } from "lucide-react";
import { fetchScripts } from "../api";

export interface QuickScriptsDropdownProps {
  onOpenScripts: () => void;
  onRunScript: (name: string, command: string) => void;
}

/**
 * QuickScriptsDropdown - Dropdown for quick script execution
 *
 * Features:
 * - Dropdown trigger with Terminal icon + chevron
 * - Fetches and displays all available scripts
 * - Click to run script immediately (opens terminal)
 * - "Manage Scripts..." footer to open full modal
 * - Keyboard navigation: arrow keys, enter to run, escape to close
 * - Loading state while fetching
 * - Empty state when no scripts configured
 * - Closes on outside click
 */
export function QuickScriptsDropdown({
  onOpenScripts,
  onRunScript,
}: QuickScriptsDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Script entries sorted alphabetically
  const scriptEntries = useMemo(() => {
    return Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b));
  }, [scripts]);

  const showFooter = scriptEntries.length > 0;

  // Total items for keyboard navigation (scripts + "Manage Scripts...")
  const totalItems = scriptEntries.length + (showFooter ? 1 : 0);

  // Fetch scripts when dropdown opens
  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    setLoading(true);

    fetchScripts()
      .then((data) => {
        if (!cancelled) {
          setScripts(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setScripts({});
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close on escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Reset highlight when dropdown opens and focus the menu
  useEffect(() => {
    if (isOpen) {
      setHighlightedIndex(-1);
      // Focus menu for keyboard navigation
      setTimeout(() => menuRef.current?.focus(), 0);
    }
  }, [isOpen]);

  // Handle keyboard navigation within dropdown
  const handleDropdownKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev < totalItems - 1 ? prev + 1 : 0
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev > 0 ? prev - 1 : totalItems - 1
          );
          break;
        case "Enter":
          e.preventDefault();
          if (highlightedIndex >= 0) {
            if (highlightedIndex < scriptEntries.length) {
              // Run script
              const [name, command] = scriptEntries[highlightedIndex];
              handleRunScript(name, command);
            } else if (showFooter && highlightedIndex === scriptEntries.length) {
              // Manage Scripts...
              handleManageScripts();
            }
          }
          break;
        case "Home":
          e.preventDefault();
          setHighlightedIndex(0);
          break;
        case "End":
          e.preventDefault();
          setHighlightedIndex(totalItems - 1);
          break;
      }
    },
    [highlightedIndex, totalItems, scriptEntries, showFooter]
  );

  // Toggle dropdown
  const toggleDropdown = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  // Handle run script
  const handleRunScript = useCallback(
    (name: string, command: string) => {
      onRunScript(name, command);
      setIsOpen(false);
    },
    [onRunScript]
  );

  // Handle manage scripts
  const handleManageScripts = useCallback(() => {
    onOpenScripts();
    setIsOpen(false);
  }, [onOpenScripts]);

  return (
    <div className="quick-scripts-dropdown" ref={dropdownRef}>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        className={`btn-icon quick-scripts-dropdown__trigger ${isOpen ? "open btn-icon--active" : ""}`}
        onClick={toggleDropdown}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label="Quick scripts"
        data-testid="scripts-btn"
        title="Scripts"
      >
        <Terminal size={16} />
        <ChevronDown
          size={14}
          className={`quick-scripts-dropdown__trigger-chevron ${isOpen ? "rotate" : ""}`}
        />
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div
          ref={menuRef}
          tabIndex={-1}
          className="quick-scripts-dropdown__menu"
          role="listbox"
          aria-label="Scripts"
          onKeyDown={handleDropdownKeyDown}
          data-testid="quick-scripts-dropdown"
        >
          {loading ? (
            <div className="quick-scripts-dropdown__loading" data-testid="quick-scripts-loading">
              <Loader2 size={16} className="animate-spin" />
              <span>Loading scripts...</span>
            </div>
          ) : scriptEntries.length === 0 ? (
            <div className="quick-scripts-dropdown__empty" data-testid="quick-scripts-empty">
              <div className="quick-scripts-dropdown__empty-icon">
                <Terminal size={16} />
              </div>
              <p>No scripts configured</p>
              <button
                className="quick-scripts-dropdown__empty-action btn"
                onClick={handleManageScripts}
              >
                Add your first script
              </button>
            </div>
          ) : (
            <>
              {/* Script list */}
              <div className="quick-scripts-dropdown__list">
                {scriptEntries.map(([name, command], index) => (
                  <button
                    key={name}
                    className={`quick-scripts-dropdown__item ${
                      highlightedIndex === index ? "highlighted" : ""
                    }`}
                    onClick={() => handleRunScript(name, command)}
                    role="option"
                    aria-selected={highlightedIndex === index}
                    data-testid={`quick-script-item-${name}`}
                  >
                    <Play size={14} className="quick-scripts-dropdown__item-icon" />
                    <div className="quick-scripts-dropdown__item-info">
                      <span className="quick-scripts-dropdown__item-name">{name}</span>
                      <span className="quick-scripts-dropdown__item-command" title={command}>
                        {command.length > 50 ? `${command.slice(0, 50)}...` : command}
                      </span>
                    </div>
                  </button>
                ))}
              </div>

              {/* Footer */}
              <div className="quick-scripts-dropdown__footer">
                <button
                  className={`quick-scripts-dropdown__manage ${
                    showFooter && highlightedIndex === scriptEntries.length ? "highlighted" : ""
                  }`}
                  onClick={handleManageScripts}
                  data-testid="quick-scripts-manage"
                >
                  <Settings size={14} />
                  <span>Manage Scripts...</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
