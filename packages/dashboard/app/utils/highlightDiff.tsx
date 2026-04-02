import React from "react";

/**
 * Highlights diff output by wrapping each line in a <span> with appropriate CSS classes.
 *
 * - Lines starting with `+` (but not `+++`) → class `diff-add`
 * - Lines starting with `-` (but not `---`) → class `diff-del`
 * - Lines starting with `@@` → class `diff-hunk`
 * - Context lines and other diff headers → no special class
 *
 * @param diff - The raw diff string to highlight
 * @returns An array of React nodes with appropriate span wrappers
 */
export function highlightDiff(diff: string): React.ReactNode[] {
  const lines = diff.split("\n");

  return lines.map((line, index) => {
    // Determine the class for this line based on its prefix
    let className = "";

    if (line.startsWith("+") && !line.startsWith("+++")) {
      className = "diff-add";
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      className = "diff-del";
    } else if (line.startsWith("@@")) {
      className = "diff-hunk";
    }

    // Wrap in a span if we have a class, otherwise return the line as-is
    if (className) {
      return (
        <span key={index} className={className}>
          {`${line}\n`}
        </span>
      );
    }

    // For lines without special classes, we still need to add the newline
    // We use a fragment to avoid unnecessary wrapper elements
    return <React.Fragment key={index}>{`${line}\n`}</React.Fragment>;
  });
}
