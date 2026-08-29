import { type Extension } from "@codemirror/state";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";

export function resolveCodeMirrorLanguage(filePath: string | undefined): Extension | null {
  if (!filePath) {
    return null;
  }

  const lowerPath = filePath.toLowerCase();

  if (lowerPath.endsWith(".js") || lowerPath.endsWith(".mjs") || lowerPath.endsWith(".cjs") || lowerPath.endsWith(".jsx")) {
    return javascript({ jsx: true });
  }

  if (lowerPath.endsWith(".ts") || lowerPath.endsWith(".tsx")) {
    return javascript({ jsx: true, typescript: true });
  }

  if (lowerPath.endsWith(".css")) {
    return css();
  }

  if (lowerPath.endsWith(".json")) {
    return json();
  }

  if (lowerPath.endsWith(".md") || lowerPath.endsWith(".markdown") || lowerPath.endsWith(".mdx")) {
    return markdown();
  }

  return null;
}
