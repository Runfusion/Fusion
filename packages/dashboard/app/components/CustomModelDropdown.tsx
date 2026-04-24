import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
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
  /** List of favorite provider names in preferred order */
  favoriteProviders?: string[];
  /** Called when user toggles a provider's favorite status */
  onToggleFavorite?: (provider: string) => void;
  /** List of favorited model identifiers in format "{provider}/{modelId}" */
  favoriteModels?: string[];
  /** Called when user toggles a model's favorite status */
  onToggleModelFavorite?: (modelId: string) => void;
}

interface DropdownPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/**
 * CustomModelDropdown - A dropdown component combining selection with icon-enhanced provider groups.
 *
 * Interaction pattern:
 * - Closed: Shows trigger button with current selection and provider icon
 * - Open: Dropdown with search input at top, scrollable list of models grouped by provider with icons
 * - Filtering: Real-time filtering using filterModels() utility
 * - Keyboard: Arrow keys navigate, Enter selects, Escape closes, Tab moves focus
 *
 * The dropdown listbox is rendered in a portal so it can escape clipping/stacking
 * contexts created by scrollable modal or board containers while still anchoring to
 * the trigger button.
 */
export function CustomModelDropdown({
  models,
  value,
  onChange,
  placeholder = "Select a model…",
  disabled = false,
  id,
  label,
  favoriteProviders = [],
  onToggleFavorite,
  favoriteModels = [],
  onToggleModelFavorite,
}: CustomModelDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [localFilter, setLocalFilter] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter models based on local filter text
  const filteredModels = useMemo(() => filterModels(models, localFilter), [models, localFilter]);

  // Group filtered models by provider and sort by favorites
  const modelsByProvider = useMemo(() => {
    return filteredModels.reduce<Record<string, ModelInfo[]>>((acc, m) => {
      (acc[m.provider] ??= []).push(m);
      return acc;
    }, {});
  }, [filteredModels]);

  // Build favorited model entries - models that are in the favoriteModels list and in filteredModels
  const favoritedModelEntries = useMemo(() => {
    const result: Array<{ model: ModelInfo; fullId: string }> = [];
    for (const fullId of favoriteModels) {
      const slashIdx = fullId.indexOf("/");
      if (slashIdx === -1) continue;
      const provider = fullId.slice(0, slashIdx);
      const modelId = fullId.slice(slashIdx + 1);
      const model = filteredModels.find((m) => m.provider === provider && m.id === modelId);
      if (model) {
        result.push({ model, fullId });
      }
    }
    return result;
  }, [favoriteModels, filteredModels]);

  // Sort providers: favorites first (in order), then alphabetically
  const sortedProviderEntries = useMemo(() => {
    const entries = Object.entries(modelsByProvider);
    const favoritesSet = new Set(favoriteProviders);

    return entries.sort(([a], [b]) => {
      const aFavorite = favoritesSet.has(a);
      const bFavorite = favoritesSet.has(b);

      if (aFavorite && !bFavorite) return -1;
      if (!aFavorite && bFavorite) return 1;

      // Both favorites: sort by favoriteProviders order
      if (aFavorite && bFavorite) {
        const aIdx = favoriteProviders.indexOf(a);
        const bIdx = favoriteProviders.indexOf(b);
        if (aIdx !== bIdx) return aIdx - bIdx;
      }

      // Neither favorite: alphabetical
      return a.localeCompare(b);
    });
  }, [modelsByProvider, favoriteProviders]);

  // Get current provider from value
  const currentProvider = useMemo(() => {
    if (!value) return null;
    const slashIdx = value.indexOf("/");
    return slashIdx === -1 ? null : value.slice(0, slashIdx);
  }, [value]);

  // Build list of all selectable options (for keyboard navigation)
  // Includes favorited models first (as pinned rows), then provider groups
  const optionsList = useMemo(() => {
    const options: Array<{ type: "default" | "provider" | "model" | "favorite"; value: string; label: string; provider?: string }> = [
      { type: "default", value: "", label: "Use default" },
    ];

    // Add favorited models as pinned rows first
    for (const { model, fullId } of favoritedModelEntries) {
      options.push({
        type: "favorite",
        value: fullId,
        label: model.name,
        provider: model.provider,
      });
    }

    sortedProviderEntries.forEach(([provider, providerModels]) => {
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
  }, [favoritedModelEntries, sortedProviderEntries]);

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

  /**
   * Get the effective visible viewport dimensions, preferring
   * `window.visualViewport` when available (accounts for mobile virtual
   * keyboards, pinch-zoom, etc.) and falling back to `window` dimensions.
   */
  const getEffectiveViewport = useCallback(() => {
    const vv = window.visualViewport;
    if (vv && vv.height > 0 && vv.width > 0) {
      return {
        width: vv.width,
        height: vv.height,
        offsetTop: vv.offsetTop,
        offsetLeft: vv.offsetLeft,
      };
    }
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      offsetTop: 0,
      offsetLeft: 0,
    };
  }, []);

  const getPreferredDropdownHeight = useCallback(() => {
    const { height: viewportHeight } = getEffectiveViewport();
    const supportsMatchMedia = typeof window.matchMedia === "function";
    const isSmallMobile = supportsMatchMedia ? window.matchMedia("(max-width: 640px)").matches : false;
    const isMobile = supportsMatchMedia ? window.matchMedia("(max-width: 768px)").matches : false;

    if (viewportHeight <= 0) return 320;
    if (isSmallMobile) {
      return Math.min(viewportHeight * 0.6, 360);
    }
    if (isMobile) {
      return Math.min(viewportHeight * 0.7, 420);
    }
    return 320;
  }, [getEffectiveViewport]);

  const updateDropdownPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const { width: viewportWidth, height: viewportHeight, offsetTop, offsetLeft } = getEffectiveViewport();
    const horizontalPadding = 16;
    const verticalPadding = 16;
    const gap = 4;
    const preferredHeight = getPreferredDropdownHeight();

    // Calculate space below and above the trigger, relative to the visible viewport.
    // On mobile with a virtual keyboard, offsetTop/offsetLeft shift the origin.
    const triggerBottom = rect.bottom - offsetTop;
    const triggerTop = rect.top - offsetTop;
    const triggerLeft = rect.left - offsetLeft;
    const spaceBelow = viewportHeight - triggerBottom;
    const spaceAbove = triggerTop;
    const availableBelow = Math.max(spaceBelow - verticalPadding - gap, 160);
    const availableAbove = Math.max(spaceAbove - verticalPadding - gap, 160);

    // Determine if we should open upward
    // Open upward if: not enough space below AND enough space above
    const openUpward = spaceBelow < preferredHeight && spaceAbove > spaceBelow;

    const maxHeight = Math.max(
      Math.min(openUpward ? availableAbove : availableBelow, preferredHeight),
      160,
    );

    const dropdownWidth = Math.min(rect.width, viewportWidth - horizontalPadding * 2);
    const left = Math.min(
      Math.max(triggerLeft, horizontalPadding),
      viewportWidth - horizontalPadding - dropdownWidth,
    ) + offsetLeft;
    const top = openUpward
      ? Math.max(verticalPadding + offsetTop, triggerTop - maxHeight - gap + offsetTop)
      : Math.min(triggerBottom + gap + offsetTop, viewportHeight + offsetTop - verticalPadding - maxHeight);

    setDropdownPosition({
      top,
      left,
      width: dropdownWidth,
      maxHeight,
    });
  }, [getEffectiveViewport, getPreferredDropdownHeight]);

  useEffect(() => {
    setPortalRoot(document.body);
  }, []);

  // Reset highlighted index when opening
  useEffect(() => {
    if (isOpen) {
      const selectableIndex = optionsList.findIndex(
        (opt, idx) => idx >= (currentValueIndex >= 0 ? currentValueIndex : 0) && opt.type !== "provider"
      );
      setHighlightedIndex(selectableIndex >= 0 ? selectableIndex : 0);
    }
  }, [isOpen, optionsList, currentValueIndex]);

  // Focus search input and position dropdown when opening
  useEffect(() => {
    if (!isOpen) return;

    updateDropdownPosition();
    const rafId = requestAnimationFrame(() => searchInputRef.current?.focus());

    return () => cancelAnimationFrame(rafId);
  }, [isOpen, updateDropdownPosition]);

  // Keep portaled dropdown anchored during viewport and container scrolling.
  // Also reposition when the visual viewport changes (mobile virtual keyboard,
  // pinch-zoom, etc.).
  useEffect(() => {
    if (!isOpen) return;

    const handleReposition = () => updateDropdownPosition();

    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);

    // Listen for visual viewport changes (virtual keyboard open/close, zoom)
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
  }, [isOpen, updateDropdownPosition]);

  // Click outside to close, treating both trigger container and portaled menu as inside.
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const clickedInsideTrigger = containerRef.current?.contains(target);
      const clickedInsideDropdown = dropdownRef.current?.contains(target);

      if (!clickedInsideTrigger && !clickedInsideDropdown) {
        setIsOpen(false);
        setLocalFilter("");
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
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
            if (option && option.type !== "provider" && option.type !== "favorite") {
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

  const dropdownContent = isOpen && dropdownPosition ? (
    <div
      ref={dropdownRef}
      className="model-combobox-dropdown model-combobox-dropdown--portal"
      role="listbox"
      data-testid="model-combobox-portal"
      onKeyDown={handleKeyDown}
      style={{
        top: `${dropdownPosition.top}px`,
        left: `${dropdownPosition.left}px`,
        width: `${dropdownPosition.width}px`,
        maxHeight: `${dropdownPosition.maxHeight}px`,
      }}
    >
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

      <div className="model-combobox-results-count">
        {filteredModels.length} model{filteredModels.length !== 1 ? "s" : ""}
      </div>

      <div ref={listRef} className="model-combobox-list">
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

        {/* Favorited models as pinned rows */}
        {favoritedModelEntries.length > 0 && (
          <>
            <div className="model-combobox-divider" />
            {favoritedModelEntries.map(({ model, fullId }, idx) => {
              const optionIndex = idx + 1; // +1 for "Use default" at index 0
              const isHighlighted = highlightedIndex === optionIndex;
              const isSelected = value === fullId;
              return (
                <div
                  key={fullId}
                  data-index={optionIndex}
                  className={`model-combobox-option model-combobox-option--favorite ${isHighlighted ? "model-combobox-option--highlighted" : ""} ${isSelected ? "model-combobox-option--selected" : ""}`}
                  onClick={() => handleSelect(fullId)}
                  onMouseEnter={() => setHighlightedIndex(optionIndex)}
                  role="option"
                  aria-selected={isSelected}
                >
                  <ProviderIcon provider={model.provider} size="sm" />
                  <span className="model-combobox-option-text">{model.name}</span>
                  <span className="model-combobox-option-id">{model.id}</span>
                  {onToggleModelFavorite && (
                    <button
                      type="button"
                      className="model-combobox-option-favorite model-combobox-option-favorite--active"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleModelFavorite(fullId);
                      }}
                      title="Remove from favorites"
                      aria-label={`Remove ${model.name} from favorites`}
                    >
                      ★
                    </button>
                  )}
                </div>
              );
            })}
            <div className="model-combobox-divider" />
          </>
        )}

        {sortedProviderEntries.map(([provider, providerModels]) => {
          const groupStartIndex = optionsList.findIndex((opt) => opt.value === `__group_${provider}`);
          const isFavorite = favoriteProviders.includes(provider);
          
          // Filter out favorited models - they already appear in the favorites section
          const nonFavoritedModels = providerModels.filter((m) => {
            const optionValue = `${m.provider}/${m.id}`;
            return !favoriteModels.includes(optionValue);
          });
          
          // Skip provider group if all models are favorited
          if (nonFavoritedModels.length === 0) return null;

          return (
            <div key={provider} className="model-combobox-group">
              <div className="model-combobox-optgroup" data-index={groupStartIndex}>
                <ProviderIcon provider={provider} size="sm" />
                <span className="model-combobox-optgroup-text">{provider}</span>
                {onToggleFavorite && (
                  <button
                    type="button"
                    className={`model-combobox-optgroup-favorite ${isFavorite ? "model-combobox-optgroup-favorite--active" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleFavorite(provider);
                    }}
                    title={isFavorite ? "Remove from favorites" : "Add to favorites"}
                    aria-label={isFavorite ? `Remove ${provider} from favorites` : `Add ${provider} to favorites`}
                  >
                    ★
                  </button>
                )}
              </div>
              {nonFavoritedModels.map((m) => {
                const optionValue = `${m.provider}/${m.id}`;
                const optionIndex = optionsList.findIndex((opt) => opt.value === optionValue);
                const isHighlighted = highlightedIndex === optionIndex;
                const isSelected = value === optionValue;
                const isFavorited = favoriteModels.includes(optionValue);

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
                    {onToggleModelFavorite && (
                      <button
                        type="button"
                        className={`model-combobox-option-favorite ${isFavorited ? "model-combobox-option-favorite--active" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleModelFavorite(optionValue);
                        }}
                        title={isFavorited ? "Remove from favorites" : "Add to favorites"}
                        aria-label={isFavorited ? `Remove ${m.name} from favorites` : `Add ${m.name} to favorites`}
                      >
                        {isFavorited ? "★" : "☆"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}

        {filteredModels.length === 0 && hasFilter && (
          <div className="model-combobox-no-results">No models match &apos;{localFilter}&apos;</div>
        )}
      </div>
    </div>
  ) : null;

  return (
    <>
      <div ref={containerRef} className="model-combobox" onKeyDown={handleKeyDown}>
        <button
          ref={triggerRef}
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
          <span className="model-combobox-trigger-text">{selectedDisplayText || placeholder}</span>
          <span className="model-combobox-trigger-arrow">▼</span>
        </button>
      </div>
      {portalRoot && dropdownContent ? createPortal(dropdownContent, portalRoot) : null}
    </>
  );
}
