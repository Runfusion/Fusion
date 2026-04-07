/**
 * Re-export companies.sh parser from @fusion/core.
 *
 * The parser implementation lives in @fusion/core so it can be shared
 * between CLI and dashboard. This file re-exports for backward compatibility.
 *
 * @module companies-sh-parser
 */

export {
  parseCompaniesShManifest,
  companiesShAgentToAgentCreateInput,
  convertCompaniesShAgents,
  mapRoleToCapability,
  CompaniesShParseError,
} from "@fusion/core";
