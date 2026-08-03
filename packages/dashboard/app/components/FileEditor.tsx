import { useState, useCallback, useMemo, useRef, useId, useEffect } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileEdit, Eye, ListOrdered, WrapText, ChevronDown, ChevronUp, Save, Undo2, Redo2 } from "lucide-react";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { history, historyKeymap, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
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
  autoSaveEnabled?: boolean;
  onToggleAutoSave?: () => void;
  canToggleAutoSave?: boolean;
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
  autoSaveEnabled = false,
  onToggleAutoSave,
  canToggleAutoSave = true,
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
  const createEditorStateRef = useRef<((doc: string, selection?: { anchor: number; head: number }) => EditorState) | null>(null);
  const syncingFromPropsRef = useRef(false);
  const localEditVersionRef = useRef(0);
  const contentEditVersionsRef = useRef<Map<string, number>>(new Map([[content, 0]]));
  const lastPropEditVersionRef = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const lineNumbersCompartmentRef = useRef(new Compartment());
  const wordWrapCompartmentRef = useRef(new Compartment());
  const readOnlyCompartmentRef = useRef(new Compartment());
  const languageCompartmentRef = useRef(new Compartment());
  const themeCompartmentRef = useRef(new Compartment());
  const [historyAvailability, setHistoryAvailability] = useState({ undo: false, redo: false });

  const isMarkdown = isMarkdownFile(filePath);
  const generatedToolbarActionsId = useId();
  const toolbarActionsId = externalToolbarActionsId ?? generatedToolbarActionsId;
  const [darkThemeActive, setDarkThemeActive] = useState(() => isDarkTheme());

  const effectiveShowPreview = isMarkdown && (readOnly ? true : showPreview);
  const shouldRenderLineNumbers = showLineNumbers && !readOnly && !effectiveShowPreview;
  const shouldShowLineNumbersToggle = Boolean(onToggleLineNumbers) && canToggleLineNumbers && !readOnly && !effectiveShowPreview;
  const shouldShowAutoSaveToggle = Boolean(onToggleAutoSave) && canToggleAutoSave && !readOnly && !effectiveShowPreview;
  const shouldShowHistoryControls = !readOnly && !effectiveShowPreview;
  const hasToolbarActions = isMarkdown || !readOnly || shouldShowLineNumbersToggle || shouldShowAutoSaveToggle;
  const languageExtension = useMemo(() => resolveCodeMirrorLanguage(filePath), [filePath]);
  const editorStateConfigRef = useRef({ shouldRenderLineNumbers, wordWrap, readOnly, languageExtension, darkThemeActive });
  editorStateConfigRef.current = { shouldRenderLineNumbers, wordWrap, readOnly, languageExtension, darkThemeActive };

  const handleEditClick = useCallback(() => setShowPreview(false), []);
  const handlePreviewClick = useCallback(() => setShowPreview(true), []);
  const handleWordWrapToggle = useCallback(() => setWordWrap((prev) => !prev), []);
  const handleToolbarActionsToggle = useCallback(() => {
    if (!isControlled) {
      setInternalExpanded((prev) => !prev);
    }
  }, [isControlled]);
  const handleHistoryCommand = useCallback((command: typeof undo | typeof redo) => {
    const view = editorViewRef.current;
    if (!view || !command(view)) return;
    view.focus();
  }, []);

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

    const createEditorState = (doc: string, selection?: { anchor: number; head: number }) => {
      const { shouldRenderLineNumbers, wordWrap, readOnly, languageExtension, darkThemeActive } = editorStateConfigRef.current;
      return EditorState.create({
        doc,
        selection,
        extensions: [
          history(),
          keymap.of(historyKeymap),
          lineNumbersCompartmentRef.current.of(shouldRenderLineNumbers ? lineNumbers() : []),
          wordWrapCompartmentRef.current.of(wordWrap ? EditorView.lineWrapping : []),
          readOnlyCompartmentRef.current.of(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
          languageCompartmentRef.current.of(languageExtension ?? []),
          themeCompartmentRef.current.of(buildThemeExtension(darkThemeActive)),
          themeOverlay,
          EditorView.updateListener.of((update) => {
            if (update.docChanged || update.transactions.some((transaction) => transaction.effects.length > 0)) {
              setHistoryAvailability({ undo: undoDepth(update.state) > 0, redo: redoDepth(update.state) > 0 });
            }
            if (!update.docChanged || syncingFromPropsRef.current) return;
            const nextContent = update.state.doc.toString();
            localEditVersionRef.current += 1;
            contentEditVersionsRef.current.set(nextContent, localEditVersionRef.current);
            onChangeRef.current(nextContent);
          }),
        ],
      });
    };

    createEditorStateRef.current = createEditorState;
    const view = new EditorView({ state: createEditorState(content), parent: editorHostRef.current });
    editorViewRef.current = view;
    return () => {
      createEditorStateRef.current = null;
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

  /*
   * FNXC:FileEditor 2026-08-03-06:15:
   * Editable editors expose native CodeMirror undo/redo through localized controls and platform shortcuts, while read-only and markdown preview presentations expose no editing affordances. A stale controlled self-echo preserves its local history, but an accepted external replacement resets the native editor state so it becomes a non-undoable baseline and cannot restore stale content.
   *
   * FNXC:FileEditor 2026-08-03-06:41:
   * External content and read-only mode may change in the same render. Build replacement states from the current render configuration rather than the initial editor mount so the reset never reverses the caller's editability choice.
   */

  /*
   * FNXC:FileViewer 2026-07-10-22:52:
   * FN-7810 found that the bounded self-echo Set could evict a stale value during long sessions, and it could miss end-of-file Enter flows where a trailing header newline raced an older prop. Use monotonic edit versions for every local CodeMirror emission instead: any prop whose known version is older than the live editor or last accepted prop is a stale self-echo at any session length, while never-emitted external reload/save-normalization content still replaces the document with the caret clamped into range.
   */
  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    const currentContent = view.state.doc.toString();
    if (currentContent === content) {
      const acknowledgedVersion = contentEditVersionsRef.current.get(content) ?? localEditVersionRef.current;
      contentEditVersionsRef.current.set(content, acknowledgedVersion);
      lastPropEditVersionRef.current = Math.max(lastPropEditVersionRef.current, acknowledgedVersion);
      return;
    }

    const incomingEditVersion = contentEditVersionsRef.current.get(content);
    const currentEditVersion = contentEditVersionsRef.current.get(currentContent) ?? localEditVersionRef.current;
    const isStaleSelfEcho = incomingEditVersion !== undefined && incomingEditVersion < Math.max(currentEditVersion, lastPropEditVersionRef.current);
    if (isStaleSelfEcho) return;

    const previousSelection = view.state.selection.main;
    const nextLength = content.length;
    const clampPosition = (position: number) => Math.max(0, Math.min(position, nextLength));
    syncingFromPropsRef.current = true;
    try {
      const createEditorState = createEditorStateRef.current;
      if (!createEditorState) return;
      view.setState(createEditorState(content, {
        anchor: clampPosition(previousSelection.anchor),
        head: clampPosition(previousSelection.head),
      }));
      setHistoryAvailability({ undo: false, redo: false });
      const externalContentVersion = localEditVersionRef.current;
      contentEditVersionsRef.current.set(content, externalContentVersion);
      lastPropEditVersionRef.current = Math.max(lastPropEditVersionRef.current, externalContentVersion);
    } finally {
      syncingFromPropsRef.current = false;
    }
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
            {shouldShowHistoryControls && (
              <>
                <button className="btn btn-sm btn-icon file-editor-toolbar-button" onClick={() => handleHistoryCommand(undo)} disabled={!historyAvailability.undo} aria-label={t("fileEditor.undo", "Undo")} title={t("fileEditor.undo", "Undo")}>
                  <Undo2 />
                </button>
                <button className="btn btn-sm btn-icon file-editor-toolbar-button" onClick={() => handleHistoryCommand(redo)} disabled={!historyAvailability.redo} aria-label={t("fileEditor.redo", "Redo")} title={t("fileEditor.redo", "Redo")}>
                  <Redo2 />
                </button>
              </>
            )}
            {shouldShowAutoSaveToggle && (
              <button className={`btn btn-sm file-editor-toolbar-button ${autoSaveEnabled ? "btn-primary" : ""}`} onClick={onToggleAutoSave} aria-label={t("fileEditor.toggleAutoSave", "Toggle auto-save")} aria-pressed={autoSaveEnabled} title={t("fileEditor.toggleAutoSave", "Toggle auto-save")} data-testid="file-editor-auto-save-toggle">
                <Save size={14} />
                <span>{t("fileEditor.autoSave", "Auto-save")}</span>
              </button>
            )}
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
