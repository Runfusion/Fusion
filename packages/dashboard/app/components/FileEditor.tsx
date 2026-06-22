import { useState, useCallback, useMemo, useRef, useId, useEffect } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileEdit, Eye, ListOrdered, WrapText, ChevronDown, ChevronUp } from "lucide-react";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { useSelectionComment } from "../hooks/useSelectionComment";
import { SelectionCommentPopover } from "./SelectionCommentPopover";
import { resolveCodeMirrorLanguage } from "../utils/codemirror-language";

interface FileEditorProps {
  content: string;
  onChange: (content: string) => void;
  readOnly?: boolean;
  filePath?: string;
  showLineNumbers?: boolean;
  onToggleLineNumbers?: () => void;
  canToggleLineNumbers?: boolean;
  toolbarExpanded?: boolean;
  forceToolbarActionsVisible?: boolean;
  toolbarActionsId?: string;
  onSendSelectionToTask?: (description: string) => void;
}

const FILE_EDITOR_MARKDOWN_PREVIEW_STORAGE_KEY = "fn-file-editor-markdown-preview";

function readBooleanPref(key: string, defaultValue: boolean): boolean {
  if (typeof window === "undefined") return defaultValue;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return raw === "true";
  } catch {
    return defaultValue;
  }
}

function writeBooleanPref(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "true" : "false");
  } catch {
    // ignore storage failures (quota, private mode, etc.)
  }
}

function isMarkdownFile(filePath?: string): boolean {
  if (!filePath) return false;
  const lowerPath = filePath.toLowerCase();
  return lowerPath.endsWith(".md") || lowerPath.endsWith(".markdown") || lowerPath.endsWith(".mdx");
}

function isDarkTheme(): boolean {
  return document.documentElement.dataset.theme !== "light";
}

function buildThemeExtension(isDark: boolean): Extension[] {
  return isDark ? [oneDark] : [syntaxHighlighting(defaultHighlightStyle)];
}

export function FileEditor({
  content,
  onChange,
  readOnly,
  filePath,
  showLineNumbers = false,
  onToggleLineNumbers,
  canToggleLineNumbers = true,
  toolbarExpanded,
  forceToolbarActionsVisible = false,
  toolbarActionsId: externalToolbarActionsId,
  onSendSelectionToTask,
}: FileEditorProps) {
  const { t } = useTranslation("app");
  /*
   * FNXC:FileViewer 2026-06-17-01:22:
   * The editable markdown file viewer must remember the user's Edit/Preview choice across file opens and browser sessions via localStorage, while first load still defaults to Edit and readOnly force-preview must not mutate the stored editable preference.
   */
  const [showPreview, setShowPreview] = useState<boolean>(() => readBooleanPref(FILE_EDITOR_MARKDOWN_PREVIEW_STORAGE_KEY, false));
  const [wordWrap, setWordWrap] = useState(true);
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isControlled = toolbarExpanded !== undefined;
  /*
   * FNXC:FileBrowser 2026-06-22-15:16:
   * Narrow modal file views must keep the editor controls visible instead of showing only an expand/collapse chevron. The standalone full file view keeps its collapsible toolbar behavior.
   */
  const expanded = forceToolbarActionsVisible ? true : isControlled ? toolbarExpanded : internalExpanded;
  const showToolbarDisclosure = !forceToolbarActionsVisible && !isControlled;

  const editorHostRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const syncingFromPropsRef = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const lineNumbersCompartmentRef = useRef(new Compartment());
  const wordWrapCompartmentRef = useRef(new Compartment());
  const readOnlyCompartmentRef = useRef(new Compartment());
  const languageCompartmentRef = useRef(new Compartment());
  const themeCompartmentRef = useRef(new Compartment());

  const isMarkdown = isMarkdownFile(filePath);
  const generatedToolbarActionsId = useId();
  const toolbarActionsId = externalToolbarActionsId ?? generatedToolbarActionsId;
  const [darkThemeActive, setDarkThemeActive] = useState(() => isDarkTheme());

  const effectiveShowPreview = isMarkdown && (readOnly ? true : showPreview);
  const shouldRenderLineNumbers = showLineNumbers && !readOnly && !effectiveShowPreview;
  const shouldShowLineNumbersToggle = Boolean(onToggleLineNumbers) && canToggleLineNumbers && !readOnly && !effectiveShowPreview;
  const hasToolbarActions = isMarkdown || !readOnly || shouldShowLineNumbersToggle;
  const languageExtension = useMemo(() => resolveCodeMirrorLanguage(filePath), [filePath]);

  const handleEditClick = useCallback(() => setShowPreview(false), []);
  const handlePreviewClick = useCallback(() => setShowPreview(true), []);
  const handleWordWrapToggle = useCallback(() => setWordWrap((prev) => !prev), []);
  const handleToolbarActionsToggle = useCallback(() => {
    if (!isControlled) {
      setInternalExpanded((prev) => !prev);
    }
  }, [isControlled]);

  const [selectionCommentOpen, setSelectionCommentOpen] = useState(false);
  const getCodeMirrorLineRange = useCallback(() => {
    const view = editorViewRef.current;
    if (!view) return undefined;
    const range = view.state.selection.main;
    if (range.empty) return undefined;
    const fromLine = view.state.doc.lineAt(Math.min(range.from, range.to)).number;
    const toLine = view.state.doc.lineAt(Math.max(range.from, range.to)).number;
    return { start: fromLine, end: toLine };
  }, []);
  const editorSelection = useSelectionComment(editorHostRef, {
    locked: selectionCommentOpen,
    getLineRange: getCodeMirrorLineRange,
  });
  const previewSelection = useSelectionComment(previewRef, { locked: selectionCommentOpen });
  const activeSelection = effectiveShowPreview ? previewSelection : editorSelection;
  const selectionPopover = onSendSelectionToTask && activeSelection ? (
    <SelectionCommentPopover
      selectedText={activeSelection.selectedText}
      anchorRect={activeSelection.anchorRect}
      filePath={filePath}
      lineRange={activeSelection.lineRange}
      onSubmit={onSendSelectionToTask}
      onOpenChange={setSelectionCommentOpen}
    />
  ) : null;

  useEffect(() => {
    writeBooleanPref(FILE_EDITOR_MARKDOWN_PREVIEW_STORAGE_KEY, showPreview);
  }, [showPreview]);

  useEffect(() => {
    if (!editorHostRef.current || effectiveShowPreview) {
      return;
    }

    const themeOverlay = EditorView.theme({
      "&": { height: "100%", fontFamily: "var(--font-mono)", backgroundColor: "var(--bg)", color: "var(--text)" },
      ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--text-muted)", borderRight: "calc(var(--space-xs) * 0.25) solid var(--border)" },
      "&.cm-focused": { outline: "none" },
    });

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbersCompartmentRef.current.of(shouldRenderLineNumbers ? lineNumbers() : []),
        wordWrapCompartmentRef.current.of(wordWrap ? EditorView.lineWrapping : []),
        readOnlyCompartmentRef.current.of(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
        languageCompartmentRef.current.of(languageExtension ?? []),
        themeCompartmentRef.current.of(buildThemeExtension(darkThemeActive)),
        themeOverlay,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || syncingFromPropsRef.current) return;
          onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });

    const view = new EditorView({ state, parent: editorHostRef.current });
    editorViewRef.current = view;
    return () => {
      editorViewRef.current = null;
      view.destroy();
    };
  }, [effectiveShowPreview]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDarkThemeActive(isDarkTheme());
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    view.dispatch({
      effects: lineNumbersCompartmentRef.current.reconfigure(shouldRenderLineNumbers ? lineNumbers() : []),
    });
  }, [shouldRenderLineNumbers]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wordWrapCompartmentRef.current.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    });
  }, [wordWrap]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    });
  }, [readOnly]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    view.dispatch({
      effects: languageCompartmentRef.current.reconfigure(languageExtension ?? []),
    });
  }, [languageExtension]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(buildThemeExtension(darkThemeActive)),
    });
  }, [darkThemeActive]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    const currentContent = view.state.doc.toString();
    if (currentContent === content) return;
    syncingFromPropsRef.current = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
    syncingFromPropsRef.current = false;
  }, [content]);

  return (
    <div className="file-editor-container">
      {hasToolbarActions && (expanded || !isControlled) ? (
        <div className={`file-editor-toolbar ${expanded ? "file-editor-toolbar--expanded" : ""}`}>
          {showToolbarDisclosure && (
            <button className="btn btn-sm btn-icon file-editor-toolbar-button" onClick={handleToolbarActionsToggle} aria-label={t("fileEditor.toggleOptions", "Toggle editor options")} title={t("fileEditor.toggleOptions", "Toggle editor options")} aria-expanded={expanded} aria-controls={toolbarActionsId}>
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          )}
          <div className="file-editor-toolbar-actions" id={toolbarActionsId} hidden={!expanded}>
            {isMarkdown ? (
              <>
                {!readOnly && (
                  <button className={`btn btn-sm file-editor-toolbar-button ${!effectiveShowPreview ? "btn-primary" : ""}`} onClick={handleEditClick} disabled={!effectiveShowPreview} aria-label={t("fileEditor.editMode", "Edit mode")}>
                    <FileEdit size={14} />
                    {t("fileEditor.edit", "Edit")}
                  </button>
                )}
                <button className={`btn btn-sm file-editor-toolbar-button ${effectiveShowPreview ? "btn-primary" : ""}`} onClick={handlePreviewClick} disabled={effectiveShowPreview} aria-label={t("fileEditor.previewMode", "Preview mode")}>
                  <Eye size={14} />
                  {t("fileEditor.preview", "Preview")}
                </button>
              </>
            ) : null}
            {shouldShowLineNumbersToggle && (
              <button className={`btn btn-sm file-editor-toolbar-button ${showLineNumbers ? "btn-primary" : ""}`} onClick={onToggleLineNumbers} aria-label={t("fileEditor.toggleLineNumbers", "Toggle line numbers")} aria-pressed={showLineNumbers} title={t("fileEditor.toggleLineNumbers", "Toggle line numbers")}>
                <ListOrdered size={14} />
                <span>{t("fileEditor.lineNumber", "Line #")}</span>
              </button>
            )}
            {!readOnly && (
              <button className={`btn btn-sm file-editor-toolbar-button ${wordWrap ? "btn-primary" : ""}`} onClick={handleWordWrapToggle} aria-label={t("fileEditor.toggleWordWrap", "Toggle word wrap")} title={t("fileEditor.toggleWordWrap", "Toggle word wrap")}>
                <WrapText size={14} />
                <span>{t("fileEditor.wrap", "Wrap")}</span>
              </button>
            )}
          </div>
        </div>
      ) : null}

      {effectiveShowPreview ? (
        <div ref={previewRef} className="file-editor-preview markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : (
        <div className="file-editor-codemirror" ref={editorHostRef} aria-label={filePath ? t("fileEditor.editorFor", `Editor for ${filePath}`) : t("fileEditor.fileEditor", "File editor")} />
      )}
      {selectionPopover}
    </div>
  );
}
