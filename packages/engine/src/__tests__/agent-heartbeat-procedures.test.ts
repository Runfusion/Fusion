import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_NO_TASK_PROCEDURE_LITE,
  HEARTBEAT_NO_TASK_PROCEDURE_OFF,
  HEARTBEAT_NO_TASK_PROCEDURE_STRICT,
  HEARTBEAT_PROCEDURE_LITE,
  HEARTBEAT_PROCEDURE_OFF,
  HEARTBEAT_PROCEDURE_STRICT,
} from "../agent-heartbeat.js";

describe("agent-heartbeat procedure templates", () => {
  it("keeps strict task procedure stable", () => {
    expect(HEARTBEAT_PROCEDURE_STRICT).toMatchSnapshot();
  });

  it("keeps lite task procedure stable", () => {
    expect(HEARTBEAT_PROCEDURE_LITE).toMatchSnapshot();
  });

  it("keeps off task procedure stable", () => {
    expect(HEARTBEAT_PROCEDURE_OFF).toMatchSnapshot();
  });

  it("keeps strict no-task procedure stable", () => {
    expect(HEARTBEAT_NO_TASK_PROCEDURE_STRICT).toMatchSnapshot();
  });

  it("keeps lite no-task procedure stable", () => {
    expect(HEARTBEAT_NO_TASK_PROCEDURE_LITE).toMatchSnapshot();
  });

  it("keeps off no-task procedure stable", () => {
    expect(HEARTBEAT_NO_TASK_PROCEDURE_OFF).toMatchSnapshot();
  });
});
