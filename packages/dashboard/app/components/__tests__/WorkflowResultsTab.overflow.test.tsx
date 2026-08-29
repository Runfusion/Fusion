import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { loadAllAppCss } from "../../test/cssFixture";

describe("WorkflowResultsTab overflow styles (FN-4206)", () => {
  it("applies shrink/wrap rules for long workflow names", () => {
    const style = document.createElement("style");
    style.textContent = loadAllAppCss();
    document.head.appendChild(style);

    const longName = "verylongworkflowstepnamewithoutspaces".repeat(3);
    const { container } = render(
      <div>
        <div className="workflow-result-header">
          <div className="workflow-result-name">{longName}</div>
        </div>
        <div className="workflow-configured-header">
          <div className="workflow-configured-title-row">
            <div className="workflow-configured-name">{longName}</div>
          </div>
        </div>
        <div className="workflow-output-modal-title">
          <span className="workflow-output-modal-name">{longName}</span>
        </div>
      </div>,
    );

    const resultName = container.querySelector(".workflow-result-name");
    const configuredName = container.querySelector(".workflow-configured-name");
    const outputModalName = container.querySelector(".workflow-output-modal-name");
    const configuredHeader = container.querySelector(".workflow-configured-header");

    expect(resultName).toBeTruthy();
    expect(configuredName).toBeTruthy();
    expect(outputModalName).toBeTruthy();
    expect(configuredHeader).toBeTruthy();

    expect(getComputedStyle(resultName as Element).minWidth).toBe("0px");
    expect(getComputedStyle(resultName as Element).wordBreak).toBe("break-word");
    expect(getComputedStyle(configuredName as Element).minWidth).toBe("0px");
    expect(getComputedStyle(configuredName as Element).wordBreak).toBe("break-word");
    expect(getComputedStyle(outputModalName as Element).minWidth).toBe("0px");
    expect(getComputedStyle(outputModalName as Element).wordBreak).toBe("break-word");
    expect(getComputedStyle(configuredHeader as Element).flexWrap).toBe("wrap");

    style.remove();
  });
});
