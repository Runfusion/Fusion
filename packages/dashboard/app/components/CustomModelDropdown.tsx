import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { ModelInfo } from "../api";
import { filterModels } from "../utils/modelFilter";
import { ProviderIcon } from "./ProviderIcon";

export interface CustomModelDropdownProps {
  models: ModelInfo[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  label: string;
}

/**
 * CustomModelDropdown - A dropdown component combining selection with icon-enhanced provider groups.
 *
 * Interaction pattern:
 * - Closed: Shows trigger button with current selection and provider icon
 * - Open: Dropdown with search input at top, scrollable list of models grouped by provider with icons
 * - Filtering: Real-time filtering using filterModels() utility
 * - Keyboard: Arrow keys navigate, Enter selects, Escape closes, Tab moves focus
 */
export function CustomModelDropdown({
  models,
  value,
  onChange,
  placeholder = "Select a model…",
  disabled = false,
  id,
  label,
}: CustomModelDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [localFilter, setLocalFilter] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter models based on local filter text
  const filteredModels = useMemo(() => filterModels(models, localFilter), [models, localFilter]);

  // Group filtered models by provider
  const modelsByProvider = useMemo(() => {
    return filteredModels.reduce<Record<string, ModelInfo[]>>((acc, m) => {
      (acc[m.provider] ??= []).push(m);
      return acc;
    }, {});
  }, [filteredModels]);

  // Get current provider from value
  const currentProvider = useMemo(() => {
    if (!value) return null;
    const slashIdx = value.indexOf("/");
    return slashIdx === -1 ? null : value.slice(0, slashIdx);
  }, [value]);

  // Build list of all selectable options (for keyboard navigation)
  const optionsList = useMemo(() => {
    const options: Array<{ type: "default" | "provider" | "model"; value: string; label: string; provider?: string }> = [
      { type: "default", value: "", label: "Use default" },
    ];

    Object.entries(modelsByProvider).forEach(([provider, providerModels]) => {
      options.push({ type: "provider", value: `__group_${provider}`, label: provider, provider });
      providerModels.forEach((m) => {
        options.push({
          type: "model",
          value: `${m.provider}/${m.id}`,
          label: m.name,
          provider: m.provider,
        });
      });
    });

    return options;
  }, [modelsByProvider]);

  // Get current selection display text
  const selectedDisplayText = useMemo(() => {
    if (!value) return "Use default";
    const slashIdx = value.indexOf("/");
    if (slashIdx === -1) return value;
    const provider = value.slice(0, slashIdx);
    const modelId = value.slice(slashIdx + 1);
    const model = models.find((m) => m.provider === provider && m.id === modelId);
    return model?.name || value;
  }, [value, models]);

  // Find index of current value in options list
  const currentValueIndex = useMemo(() => {
    return optionsList.findIndex((opt) => opt.value === value);
  }, [optionsList, value]);

  // Reset highlighted index when opening
  useEffect(() => {
    if (isOpen) {
      // Start with current value highlighted, or first selectable option
      const selectableIndex = optionsList.findIndex(
        (opt, idx) => idx >= (currentValueIndex >= 0 ? currentValueIndex : 0) && opt.type !== "provider"
      );
      setHighlightedIndex(selectableIndex >= 0 ? selectableIndex : 0);
    }
  }, [isOpen, optionsList, currentValueIndex]);

  // Focus search input when opening
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  // Click outside to close
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setLocalFilter("");
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          if (!isOpen) {
            setIsOpen(true);
          } else {
            // Find next selectable option (skip provider headers)
            let nextIndex = highlightedIndex;
            for (let i = 1; i <= optionsList.length; i++) {
              const idx = (highlightedIndex + i) % optionsList.length;
              if (optionsList[idx]?.type !== "provider") {
                nextIndex = idx;
                break;
              }
            }
            setHighlightedIndex(nextIndex);
          }
          break;

        case "ArrowUp":
          e.preventDefault();
          if (isOpen) {
            // Find previous selectable option (skip provider headers)
            let prevIndex = highlightedIndex;
            for (let i = 1; i <= optionsList.length; i++) {
              const idx = (highlightedIndex - i + optionsList.length) % optionsList.length;
              if (optionsList[idx]?.type !== "provider") {
                prevIndex = idx;
                break;
              }
            }
            setHighlightedIndex(prevIndex);
          }
          break;

        case "Enter":
          e.preventDefault();
          if (isOpen) {
            const option = optionsList[highlightedIndex];
            if (option && option.type !== "provider") {
              onChange(option.value);
              setIsOpen(false);
              setLocalFilter("");
            }
          } else {
            setIsOpen(true);
          }
          break;

        case "Escape":
          e.preventDefault();
          setIsOpen(false);
          setLocalFilter("");
          break;

        case "Tab":
          // Close dropdown on tab (focus moves to next field)
          if (isOpen) {
            setIsOpen(false);
            setLocalFilter("");
          }
          break;
      }
    },
    [isOpen, highlightedIndex, optionsList, onChange]
  );

  const handleSelect = useCallback(
    (optionValue: string) => {
      onChange(optionValue);
      setIsOpen(false);
      setLocalFilter("");
    },
    [onChange]
  );

  const handleClearFilter = useCallback(() => {
    setLocalFilter("");
    searchInputRef.current?.focus();
  }, []);

  const handleTriggerClick = useCallback(() => {
    if (!disabled) {
      setIsOpen((prev) => !prev);
    }
  }, [disabled]);

  // Scroll highlighted option into view
  useEffect(() => {
    if (isOpen && listRef.current) {
      const highlightedEl = listRef.current.querySelector(`[data-index="${highlightedIndex}"]`);
      if (highlightedEl && typeof highlightedEl.scrollIntoView === "function") {
        highlightedEl.scrollIntoView({ block: "nearest" });
      }
    }
  }, [highlightedIndex, isOpen]);

  const hasFilter = localFilter.length > 0;

  return (
    <div ref={containerRef} className="model-combobox" onKeyDown={handleKeyDown}>
      {/* Trigger Button */}
      <button
        type="button"
        id={id}
        className="model-combobox-trigger"
        onClick={handleTriggerClick}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={label}
      >
        {currentProvider && (
          <span className="model-combobox-trigger-icon">
            <ProviderIcon provider={currentProvider} size="sm" />
          </span>
        )}
        <span className="model-combobox-trigger-text">{selectedDisplayText}</span>
        <span className="model-combobox-trigger-arrow">▼</span>
      </button>

      {/* Dropdown Panel */}
      {isOpen && (
        <div className="model-combobox-dropdown" role="listbox">
          {/* Search Input */}
          <div className="model-combobox-search-wrapper">
            <input
              ref={searchInputRef}
              type="text"
              className="model-combobox-search"
              placeholder="Filter models…"
              value={localFilter}
              onChange={(e) => setLocalFilter(e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
            {hasFilter && (
              <button
                type="button"
                className="model-combobox-clear"
                onClick={handleClearFilter}
                aria-label="Clear filter"
              >
                ×
              </button>
            )}
          </div>

          {/* Results Count */}
          <div className="model-combobox-results-count">
            {filteredModels.length} model{filteredModels.length !== 1 ? "s" : ""}
          </div>

          {/* Options List */}
          <div ref={listRef} className="model-combobox-list">
            {/* Use default option */}
            <div
              data-index={0}
              className={`model-combobox-option ${highlightedIndex === 0 ? "model-combobox-option--highlighted" : ""} ${value === "" ? "model-combobox-option--selected" : ""}`}
              onClick={() => handleSelect("")}
              onMouseEnter={() => setHighlightedIndex(0)}
              role="option"
              aria-selected={value === ""}
            >
              <span className="model-combobox-option-text model-combobox-option-text--default">Use default</span>
            </div>

            {/* Provider groups */}
            {Object.entries(modelsByProvider).map(([provider, providerModels]) => {
              const groupStartIndex = optionsList.findIndex((opt) => opt.value === `__group_${provider}`);

              return (
                <div key={provider} className="model-combobox-group">
                  <div className="model-combobox-optgroup" data-index={groupStartIndex}>
                    <ProviderIcon provider={provider} size="sm" />
                    <span className="model-combobox-optgroup-text">{provider}</span>
                  </div>
                  {providerModels.map((m) => {
                    const optionValue = `${m.provider}/${m.id}`;
                    const optionIndex = optionsList.findIndex((opt) => opt.value === optionValue);
                    const isHighlighted = highlightedIndex === optionIndex;
                    const isSelected = value === optionValue;

                    return (
                      <div
                        key={optionValue}
                        data-index={optionIndex}
                        className={`model-combobox-option ${isHighlighted ? "model-combobox-option--highlighted" : ""} ${isSelected ? "model-combobox-option--selected" : ""}`}
                        onClick={() => handleSelect(optionValue)}
                        onMouseEnter={() => setHighlightedIndex(optionIndex)}
                        role="option"
                        aria-selected={isSelected}
                      >
                        <span className="model-combobox-option-text">{m.name}</span>
                        <span className="model-combobox-option-id">{m.id}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}

            {/* No results message */}
            {filteredModels.length === 0 && hasFilter && (
              <div className="model-combobox-no-results">No models match &apos;{localFilter}&apos;</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
