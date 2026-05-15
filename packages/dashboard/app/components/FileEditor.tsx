import { useState, useCallback, useMemo, useRef, useId, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileEdit, Eye, ListOrdered, WrapText, ChevronDown, ChevronUp } from "lucide-react";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { resolveCodeMirrorLanguage } from "../utils/codemirror-language";

interface FileEditorProps {
  content: string;
  onChange: (content: string) => void;
  readOnly?: boolean;
  filePath?: string;
  showLineNumbers?: boolean;
  onToggleLineNumbers?: () => void;
  canToggleLineNumbers?: boolean;
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
}: FileEditorProps) {
  const [showPreview, setShowPreview] = useState(false);
  const [wordWrap, setWordWrap] = useState(true);
  const [toolbarActionsExpanded, setToolbarActionsExpanded] = useState(false);
  const editorHostRef = useRef<HTMLDivElement>(null);
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
  const toolbarActionsId = useId();
  const [darkThemeActive, setDarkThemeActive] = useState(() => isDarkTheme());

  const effectiveShowPreview = isMarkdown && (readOnly ? true : showPreview);
  const shouldRenderLineNumbers = showLineNumbers && !readOnly && !effectiveShowPreview;
  const shouldShowLineNumbersToggle = Boolean(onToggleLineNumbers) && canToggleLineNumbers && !readOnly && !effectiveShowPreview;
  const hasToolbarActions = isMarkdown || !readOnly || shouldShowLineNumbersToggle;
  const languageExtension = useMemo(() => resolveCodeMirrorLanguage(filePath), [filePath]);

  const handleEditClick = useCallback(() => setShowPreview(false), []);
  const handlePreviewClick = useCallback(() => setShowPreview(true), []);
  const handleWordWrapToggle = useCallback(() => setWordWrap((prev) => !prev), []);
  const handleToolbarActionsToggle = useCallback(() => setToolbarActionsExpanded((prev) => !prev), []);

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
  }, [content, effectiveShowPreview, languageExtension, readOnly, shouldRenderLineNumbers, wordWrap]);

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
      {hasToolbarActions ? (
        <div className={`file-editor-toolbar ${toolbarActionsExpanded ? "file-editor-toolbar--expanded" : ""}`}>
          <button className="btn btn-sm btn-icon file-editor-toolbar-button" onClick={handleToolbarActionsToggle} aria-label="Toggle editor options" title="Toggle editor options" aria-expanded={toolbarActionsExpanded} aria-controls={toolbarActionsId}>
            {toolbarActionsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <div className="file-editor-toolbar-actions" id={toolbarActionsId} hidden={!toolbarActionsExpanded}>
            {isMarkdown ? (
              <>
                {!readOnly && (
                  <button className={`btn btn-sm file-editor-toolbar-button ${!effectiveShowPreview ? "btn-primary" : ""}`} onClick={handleEditClick} disabled={!effectiveShowPreview} aria-label="Edit mode">
                    <FileEdit size={14} />
                    Edit
                  </button>
                )}
                <button className={`btn btn-sm file-editor-toolbar-button ${effectiveShowPreview ? "btn-primary" : ""}`} onClick={handlePreviewClick} disabled={effectiveShowPreview} aria-label="Preview mode">
                  <Eye size={14} />
                  Preview
                </button>
              </>
            ) : null}
            {shouldShowLineNumbersToggle && (
              <button className={`btn btn-sm file-editor-toolbar-button ${showLineNumbers ? "btn-primary" : ""}`} onClick={onToggleLineNumbers} aria-label="Toggle line numbers" aria-pressed={showLineNumbers} title="Toggle line numbers">
                <ListOrdered size={14} />
                <span>Line #</span>
              </button>
            )}
            {!readOnly && (
              <button className={`btn btn-sm file-editor-toolbar-button ${wordWrap ? "btn-primary" : ""}`} onClick={handleWordWrapToggle} aria-label="Toggle word wrap" title="Toggle word wrap">
                <WrapText size={14} />
                <span>Wrap</span>
              </button>
            )}
          </div>
        </div>
      ) : null}

      {effectiveShowPreview ? (
        <div className="file-editor-preview markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : (
        <div className="file-editor-codemirror" ref={editorHostRef} aria-label={filePath ? `Editor for ${filePath}` : "File editor"} />
      )}
    </div>
  );
}
