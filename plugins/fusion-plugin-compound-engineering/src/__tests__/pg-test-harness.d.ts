declare module "@fusion/test-utils/pg-test-harness" {
  import type { describe } from "vitest";

  export const PG_AVAILABLE: boolean;
  export const pgDescribe: typeof describe;
}
