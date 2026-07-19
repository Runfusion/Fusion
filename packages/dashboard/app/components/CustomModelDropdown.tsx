import "./CustomModelDropdown.css";
import { useState, useEffect, useCallback, useMemo, useRef, useId } from "react";
import { THINKING_LEVELS } from "@fusion/core";
import { useTranslation } from "react-i18next";
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
  /** Optional untouched sentinel value for contexts that need a third lane (e.g. list-view bulk edit). */
  noChangeValue?: string;
  /** Display label for noChangeValue (defaults to "No change"). */
  noChangeLabel?: string;
  /** Display label for the inherited/default option (defaults to "Use default"). */
  defaultOptionLabel?: string;
  /** List of favorite provider names in preferred order */
  favoriteProviders?: string[];
  /** Called when user toggles a provider's favorite status */
  onToggleFavorite?: (provider: string) => void;
  /** List of favorited model identifiers in format "{provider}/{modelId}" */
  favoriteModels?: string[];
  /** Called when user toggles a model's favorite status */
  onToggleModelFavorite?: (modelId: string) => void;
  /** Request a wider menu for dense settings surfaces while default callers keep trigger-width sizing. */
  menuWidth?: "trigger" | "readable";
  /** Optional thinking/reasoning effort value; empty string means inherit/default when defaultThinkingLevel is provided. */
  thinkingLevel?: string;
  /** Called when the optional inline thinking-level selector changes. */
  onThinkingLevelChange?: (level: string) => void;
  /** Effective default thinking level; when supplied, the selector includes an empty "Default (level)" option. */
  defaultThinkingLevel?: string;
  /** Explicitly render the optional inline thinking-level selector even without a change callback. */
  showThinkingLevel?: boolean;
}

interface DropdownPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

const COLLAPSED_PROVIDERS_STORAGE_KEY = "fusion-dashboard-model-dropdown-collapsed-providers";

/**
 * FNXC:ModelDropdown 2026-07-15-00:00:
 * Provider-group collapse is dashboard-local preference state, not a server setting. Read defensively so SSR, unavailable storage, and malformed legacy data keep every provider expanded instead of breaking a model picker.
 */
function loadCollapsedProviders(): Set<string> {
  if (typeof window === "undefined") return new Set();

  try {
    const raw = window.localStorage.getItem(COLLAPSED_PROVIDERS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((provider): provider is string => typeof provider === "string")) : new Set();
  } catch {
    return new Set();
  }
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
  placeholder: placeholderProp,
  disabled = false,
  id,
  label,
  favoriteProviders = [],
  onToggleFavorite,
  favoriteModels = [],
  onToggleModelFavorite,
  noChangeValue,
  noChangeLabel: noChangeLabelProp,
  defaultOptionLabel: defaultOptionLabelProp,
  menuWidth = "trigger",
  thinkingLevel,
  onThinkingLevelChange,
  defaultThinkingLevel,
  showThinkingLevel,
}: CustomModelDropdownProps) {
  const { t } = useTranslation("app");
  const placeholder = placeholderProp ?? t("model.selectPlaceholder", "Select a model…");
  const noChangeLabel = noChangeLabelProp ?? t("model.noChange", "No change");
  const defaultOptionLabel = defaultOptionLabelProp ?? t("models.useDefault", "Use default");
  const [isOpen, setIsOpen] = useState(false);
  const [localFilter, setLocalFilter] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(loadCollapsedProviders);
  const generatedThinkingId = useId();

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter models based on local filter text
  const filteredModels = useMemo(() => filterModels(models, localFilter), [models, localFilter]);
  const hasFilter = localFilter.length > 0;

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

  /*
  FNXC:ModelDropdown 2026-07-15-00:00:
  Collapsed provider rows are omitted from both the DOM and keyboard option list. An active filter temporarily expands every matching group so search never hides a matching model; the saved collapsed preference resumes after clearing the filter.
  */
  const visibleProviderEntries = useMemo(() => sortedProviderEntries.flatMap(([provider, providerModels]) => {
    const nonFavoritedModels = providerModels.filter((model) => !favoriteModels.includes(`${model.provider}/${model.id}`));
    if (nonFavoritedModels.length === 0) return [];

    return [{
      provider,
      models: nonFavoritedModels,
      isCollapsed: !hasFilter && collapsedProviders.has(provider),
    }];
  }), [collapsedProviders, favoriteModels, hasFilter, sortedProviderEntries]);

  const hasNoChangeOption = typeof noChangeValue === "string" && noChangeValue.length > 0;
  const shouldShowThinking = showThinkingLevel ?? Boolean(onThinkingLevelChange);
  const normalizedThinkingLevel = thinkingLevel ?? "";
  const hasDefaultThinkingOption = typeof defaultThinkingLevel === "string";
  const thinkingSelectId = id ? `${id}-thinking-level` : `${generatedThinkingId}-thinking-level`;

  /*
  FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
  The shared model dropdown can optionally embed a thinking-level selector so task and agent model pickers expose one consistent reasoning-effort affordance, including `xhigh`. The selector stays inert unless a caller opts in with `showThinkingLevel` or `onThinkingLevelChange`, preserving every settings, insights, schedule, workflow, planning, onboarding, and bulk-edit surface that only needs model selection.
  */
  const thinkingOptions = useMemo(() => THINKING_LEVELS.map((level) => ({
    value: level,
    label: t(`models.options.${level}`, level === "xhigh" ? "Very High" : level.charAt(0).toUpperCase() + level.slice(1)),
  })), [t]);

  const thinkingBadgeLabel = useMemo(() => {
    if (!shouldShowThinking) return "";
    if (normalizedThinkingLevel) {
      return thinkingOptions.find((option) => option.value === normalizedThinkingLevel)?.label ?? normalizedThinkingLevel;
    }
    if (hasDefaultThinkingOption) {
      return t("modelSelection.thinkingDefault", "Default ({{level}})", { level: defaultThinkingLevel });
    }
    return thinkingOptions.find((option) => option.value === "off")?.label ?? "Off";
  }, [defaultThinkingLevel, hasDefaultThinkingOption, normalizedThinkingLevel, shouldShowThinking, t, thinkingOptions]);

  // Get current provider from value
  const currentProvider = useMemo(() => {
    if (!value || (hasNoChangeOption && value === noChangeValue)) return null;
    const slashIdx = value.indexOf("/");
    return slashIdx === -1 ? null : value.slice(0, slashIdx);
  }, [hasNoChangeOption, noChangeValue, value]);

  const specialOptions = useMemo(() => {
    const options: Array<{ type: "default" | "no-change"; value: string; label: string }> = [];
    if (hasNoChangeOption) {
      options.push({ type: "no-change", value: noChangeValue, label: noChangeLabel });
    }
    options.push({ type: "default", value: "", label: defaultOptionLabel });
    return options;
  }, [defaultOptionLabel, hasNoChangeOption, noChangeLabel, noChangeValue]);

  // Build list of all selectable options (for keyboard navigation)
  // Includes special rows first (optional "No change" + "Use default"),
  // favorited models next, then provider groups.
  const optionsList = useMemo(() => {
    const options: Array<{ type: "default" | "no-change" | "provider" | "model" | "favorite"; value: string; label: string; provider?: string }> = [...specialOptions];

    // Add favorited models as pinned rows first
    for (const { model, fullId } of favoritedModelEntries) {
      options.push({
        type: "favorite",
        value: fullId,
        label: model.name,
        provider: model.provider,
      });
    }

    visibleProviderEntries.forEach(({ provider, models: providerModels, isCollapsed }) => {
      options.push({ type: "provider", value: `__group_${provider}`, label: provider, provider });
      if (isCollapsed) return;
      providerModels.forEach((model) => {
        options.push({
          type: "model",
          value: `${model.provider}/${model.id}`,
          label: model.name,
          provider: model.provider,
        });
      });
    });

    return options;
  }, [favoritedModelEntries, specialOptions, visibleProviderEntries]);

  // Get current selection display text
  const selectedDisplayText = useMemo(() => {
    if (hasNoChangeOption && value === noChangeValue) {
      return noChangeLabel;
    }
    if (!value) return defaultOptionLabel;
    const slashIdx = value.indexOf("/");
    if (slashIdx === -1) return value;
    const provider = value.slice(0, slashIdx);
    const modelId = value.slice(slashIdx + 1);
    const model = models.find((m) => m.provider === provider && m.id === modelId);
    return model?.name || value;
  }, [defaultOptionLabel, hasNoChangeOption, noChangeLabel, noChangeValue, value, models]);

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

    const maxDropdownWidth = viewportWidth - horizontalPadding * 2;
    /*
    FNXC:ModelDropdown 2026-07-01-00:00:
    Project Models lanes need a readable portaled menu for long provider/model names, but shared model selectors elsewhere must retain trigger-width behavior unless they opt in.
    Clamp the widened target to the effective viewport, including visualViewport offsets, so desktop and mobile keyboards never create offscreen click targets.
    */
    const preferredDropdownWidth = menuWidth === "readable"
      ? Math.max(rect.width, Math.min(rect.width * 1.6, viewportWidth * 0.72))
      : rect.width;
    const dropdownWidth = Math.min(preferredDropdownWidth, maxDropdownWidth);
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
  }, [getEffectiveViewport, getPreferredDropdownHeight, menuWidth]);

  useEffect(() => {
    setPortalRoot(document.body);
  }, []);

  // Initialise the highlighted option on open. We only seed once per open
  // session — re-seeding on every optionsList change (which fires on each
  // keystroke into the filter) was snapping highlightedIndex back to the
  // current model's position, and the scrollIntoView effect below then
  // yanked the list back to that row, making filtering feel like the
  // dropdown was "refreshing" or fighting the user's scroll.
  const didInitHighlightRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      didInitHighlightRef.current = false;
      return;
    }
    if (didInitHighlightRef.current) return;
    if (optionsList.length === 0) return;
    const selectableIndex = optionsList.findIndex(
      (opt, idx) => idx >= (currentValueIndex >= 0 ? currentValueIndex : 0) && opt.type !== "provider"
    );
    setHighlightedIndex(selectableIndex >= 0 ? selectableIndex : 0);
    didInitHighlightRef.current = true;
  }, [isOpen, optionsList, currentValueIndex]);

  // When the filter changes, reset to the first option and scroll the list
  // back to the top instead of keeping a now-invalid highlight position.
  useEffect(() => {
    if (!isOpen) return;
    if (!didInitHighlightRef.current) return;
    setHighlightedIndex(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [localFilter, isOpen]);

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

  const handleToggleCollapsedProvider = useCallback((provider: string) => {
    setCollapsedProviders((previous) => {
      const next = new Set(previous);
      if (next.has(provider)) {
        next.delete(provider);
      } else {
        next.add(provider);
      }

      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(COLLAPSED_PROVIDERS_STORAGE_KEY, JSON.stringify([...next].sort()));
        }
      } catch {
        // Storage failures must not prevent the in-memory affordance from working.
      }

      return next;
    });
    setHighlightedIndex(0);
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

  const dropdownContent = isOpen && dropdownPosition ? (
    <div
      ref={dropdownRef}
      className="model-combobox-dropdown model-combobox-dropdown--portal"
      role="listbox"
      data-testid="model-combobox-portal"
      data-menu-width={menuWidth}
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
          placeholder={t("models.filterPlaceholder", "Filter models…")}
          value={localFilter}
          onChange={(e) => setLocalFilter(e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
        {hasFilter && (
          <button
            type="button"
            className="model-combobox-clear"
            onClick={handleClearFilter}
            aria-label={t("models.clearFilter", "Clear filter")}
          >
            ×
          </button>
        )}
      </div>

      <div className="model-combobox-results-count">
        {t("models.count", { count: filteredModels.length, defaultValue_one: "{{count}} model", defaultValue_other: "{{count}} models" })}
      </div>

      {shouldShowThinking && (
        <div className="model-combobox-thinking" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <label className="model-combobox-thinking-label" htmlFor={thinkingSelectId}>
            {t("models.labels.thinkingLevel", "Thinking Level")}
          </label>
          <select
            id={thinkingSelectId}
            className="thinking-level-select model-combobox-thinking-select"
            data-testid="custom-model-dropdown-thinking"
            value={normalizedThinkingLevel}
            onChange={(e) => onThinkingLevelChange?.(e.target.value)}
            disabled={disabled || !onThinkingLevelChange}
            aria-label={t("models.labels.thinkingLevel", "Thinking Level")}
          >
            {hasDefaultThinkingOption && (
              <option value="">{t("modelSelection.thinkingDefault", "Default ({{level}})", { level: defaultThinkingLevel })}</option>
            )}
            {thinkingOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      )}

      <div ref={listRef} className="model-combobox-list">
        {specialOptions.map((option, index) => (
          <div
            key={`${option.type}-${option.value}`}
            data-index={index}
            className={`model-combobox-option ${highlightedIndex === index ? "model-combobox-option--highlighted" : ""} ${value === option.value ? "model-combobox-option--selected" : ""}`}
            onClick={() => handleSelect(option.value)}
            onMouseEnter={() => setHighlightedIndex(index)}
            role="option"
            aria-selected={value === option.value}
          >
            <span className="model-combobox-option-text model-combobox-option-text--default">{option.label}</span>
          </div>
        ))}

        {/* Favorited models as pinned rows */}
        {favoritedModelEntries.length > 0 && (
          <>
            <div className="model-combobox-divider" />
            {favoritedModelEntries.map(({ model, fullId }, idx) => {
              const optionIndex = idx + specialOptions.length;
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
                  <span className="model-combobox-option-main">
                    <span className="model-combobox-option-icon">
                      <ProviderIcon provider={model.provider} size="sm" />
                    </span>
                    <span className="model-combobox-option-text">{model.name}</span>
                  </span>
                  <span className="model-combobox-option-id">{model.id}</span>
                  {onToggleModelFavorite && (
                    <button
                      type="button"
                      className="model-combobox-option-favorite model-combobox-option-favorite--active"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleModelFavorite(fullId);
                      }}
                      title={t("models.removeFromFavorites", "Remove from favorites")}
                      aria-label={t("models.removeFromFavoritesAriaLabel", "Remove {{name}} from favorites", { name: model.name })}
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

        {visibleProviderEntries.map(({ provider, models: providerModels, isCollapsed }) => {
          const groupStartIndex = optionsList.findIndex((opt) => opt.value === `__group_${provider}`);
          const isFavorite = favoriteProviders.includes(provider);
          const isExpanded = !isCollapsed;

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
                    title={isFavorite ? t("models.removeFromFavorites", "Remove from favorites") : t("models.addToFavorites", "Add to favorites")}
                    aria-label={isFavorite ? t("models.removeProviderFromFavoritesAriaLabel", "Remove {{provider}} from favorites", { provider }) : t("models.addProviderToFavoritesAriaLabel", "Add {{provider}} to favorites", { provider })}
                  >
                    ★
                  </button>
                )}
                <button
                  type="button"
                  className={`model-combobox-optgroup-toggle ${isExpanded ? "model-combobox-optgroup-toggle--expanded" : ""}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleToggleCollapsedProvider(provider);
                  }}
                  aria-label={isExpanded
                    ? t("models.collapseProvider", "Collapse {{provider}}", { provider })
                    : t("models.expandProvider", "Expand {{provider}}", { provider })}
                  aria-expanded={isExpanded}
                  data-testid={`model-combobox-provider-toggle-${provider}`}
                >
                  ▼
                </button>
              </div>
              {!isCollapsed && providerModels.map((model) => {
                const optionValue = `${model.provider}/${model.id}`;
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
                    <span className="model-combobox-option-text">{model.name}</span>
                    <span className="model-combobox-option-id">{model.id}</span>
                    {onToggleModelFavorite && (
                      <button
                        type="button"
                        className={`model-combobox-option-favorite ${isFavorited ? "model-combobox-option-favorite--active" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleModelFavorite(optionValue);
                        }}
                        title={isFavorited ? t("models.removeFromFavorites", "Remove from favorites") : t("models.addToFavorites", "Add to favorites")}
                        aria-label={isFavorited ? t("models.removeFromFavoritesAriaLabel", "Remove {{name}} from favorites", { name: model.name }) : t("models.addToFavoritesAriaLabel", "Add {{name}} to favorites", { name: model.name })}
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
          <div className="model-combobox-no-results">{t("models.noResults", "No models match '{{filter}}'", { filter: localFilter })}</div>
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
          {shouldShowThinking && (
            <span className={`model-badge ${normalizedThinkingLevel ? "model-badge-custom" : "model-badge-default"} model-combobox-thinking-badge`} data-testid="custom-model-dropdown-thinking-badge">
              {thinkingBadgeLabel}
            </span>
          )}
          <span className="model-combobox-trigger-arrow">▼</span>
        </button>
      </div>
      {portalRoot && dropdownContent ? createPortal(dropdownContent, portalRoot) : null}
    </>
  );
}
