import type { McpInputSchemaProfile } from "./mcpInputSchemaProfile.js";
import type { McpOutputSchemaProfile } from "./mcpOutputSchemaProfile.js";

/**
 * Schema presentation selected by the production `rea mcp` entrypoint when the
 * caller leaves it unset. Every MCP session lists all tools to the model, so
 * production advertises the compact input form and omits output contracts
 * (three quarters of tools/list); REA still validates every result against
 * its canonical contract. `full` restores the complete presentation.
 *
 * Library callers of `createServer` keep the full presentation by default.
 */
export const PRODUCTION_SCHEMA_PROFILE_DEFAULTS = {
  REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
  REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
} as const satisfies {
  readonly REA_MCP_INPUT_SCHEMA_PROFILE: McpInputSchemaProfile;
  readonly REA_MCP_OUTPUT_SCHEMA_PROFILE: McpOutputSchemaProfile;
};

/** Fill unset schema profiles with the production defaults. */
export const withProductionSchemaProfiles = <
  Environment extends Readonly<Record<string, string | undefined>>,
>(
  environment: Environment,
): Environment => {
  const missing = Object.entries(PRODUCTION_SCHEMA_PROFILE_DEFAULTS).filter(
    ([name]) => environment[name] === undefined,
  );
  return missing.length === 0
    ? environment
    : Object.freeze({ ...environment, ...Object.fromEntries(missing) });
};
