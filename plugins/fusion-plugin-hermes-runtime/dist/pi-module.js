/**
 * Pi Module Seam
 *
 * Provides a mockable import path for pi functions used by the HermesRuntimeAdapter.
 * Tests intercept this module via `vi.mock("../pi-module.js", ...)`. The runtime
 * implementations come from @fusion/engine; the local types provide a loose
 * surface so the adapter doesn't have to depend on @fusion/engine's full types.
 */
import { createFnAgent as _createFnAgent, promptWithFallback as _promptWithFallback, describeModel as _describeModel, } from "@fusion/engine";
export const createFnAgent = _createFnAgent;
export const promptWithFallback = _promptWithFallback;
export const describeModel = _describeModel;
//# sourceMappingURL=pi-module.js.map