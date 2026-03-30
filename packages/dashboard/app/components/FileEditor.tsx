import { useEffect, useRef, useState } from "react";
import { basicSetup } from "@codemirror/basic-setup";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { oneDark } from "@codemirror/theme-one-dark";

interface FileEditorProps {
  content: string;
  onChange: (content: string) => void;
  readOnly?: boolean;
  filePath?: string;
}

function detectLanguage(filePath?: string) {
  if (!filePath) return null;
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();

  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return javascript({ typescript: ext === ".ts" || ext === ".tsx" });
    case ".json":
    case ".jsonc":
      return json();
    case ".md":
    case ".markdown":
      return markdown();
    case ".css":
    case ".scss":
    case ".sass":
    case ".less":
      return css();
    default:
      return null;
  }
}

export function FileEditor({ content, onChange, readOnly, filePath }: FileEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [isReady, setIsReady] = useState(false);

  // Create editor on mount
  useEffect(() => {
    if (!editorRef.current || viewRef.current) return;

    const language = detectLanguage(filePath);

    const extensions = [
      basicSetup,
      oneDark,
      EditorView.theme({
        "&": {
          fontSize: "13px",
          height: "100%",
        },
        ".cm-content": {
          fontFamily: '"SF Mono", Monaco, Consolas, monospace',
        },
      }),
      EditorState.readOnly.of(readOnly ?? false),
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            // Save is handled by parent component
            return true;
          },
        },
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChange(update.state.doc.toString());
        }
      }),
    ];

    if (language) {
      extensions.push(language);
    }

    const state = EditorState.create({
      doc: content,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;
    setIsReady(true);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []); // Only run once on mount

  // Update content when it changes externally
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !isReady) return;

    const currentContent = view.state.doc.toString();
    if (content !== currentContent) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
      });
    }
  }, [content, isReady]);

  // Update readOnly when it changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !isReady) return;

    view.dispatch({
      effects: EditorState.readOnly.reconfigure(readOnly ?? false),
    });
  }, [readOnly, isReady]);

  return <div ref={editorRef} className="file-editor-container" />;
}
