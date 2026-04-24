/**
 * Pi Module Seam
 *
 * Provides a mockable import path for pi functions used by the HermesRuntimeAdapter.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _piModule = require("../../../packages/engine/src/pi.js");
export const createFnAgent = _piModule.createFnAgent;
export const promptWithFallback = _piModule.promptWithFallback;
export const describeModel = _piModule.describeModel;
//# sourceMappingURL=pi-module.js.map