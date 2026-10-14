import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import type { ProviderAvailability } from "../application/AnalysisProvider.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import {
  buildCapabilityInventory,
  compactToolAvailability,
} from "../application/CapabilityInventory.js";
import { toolContract } from "../contracts/toolContracts.js";
import type {
  ClientFeatureAvailability,
  ToolAvailability,
} from "../contracts/toolOutputSchemaPrimitives.js";
import { jsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";
import { createServerIdentity } from "../serverIdentity.js";
import { mcpClientMetadata } from "./mcpClientMetadata.js";
import type { AvailabilityPolicy } from "../application/CapabilityInventory.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { err } from "../domain/result.js";
import { CURRENT_ENTRYPOINT_PATH } from "../process/CurrentEntrypointPath.js";

/** Inputs required to register the binary session status tool. */
export interface SessionStatusToolOptions {
  readonly server: EvidenceMcpServer;
  readonly session: BinarySessionPort;
  readonly contract: ReturnType<typeof toolContract<"binary_session">>;
  readonly startedAt: string;
  readonly availabilityPolicy: () => AvailabilityPolicy;
  readonly androidAnalysisAvailability: (
    signal: AbortSignal,
  ) => Promise<ProviderAvailability>;
  readonly adbAnalysisAvailability?: (
    signal: AbortSignal,
  ) => Promise<ProviderAvailability>;
  readonly apktoolAnalysisAvailability?: (
    signal: AbortSignal,
  ) => Promise<ProviderAvailability>;
}

/** Register the read-only provider and target status operation. */
export const registerSessionStatusTool = (
  options: SessionStatusToolOptions,
): void => {
  const {
    server,
    session,
    contract,
    startedAt,
    availabilityPolicy,
    androidAnalysisAvailability,
    adbAnalysisAvailability,
    apktoolAnalysisAvailability,
  } = options;
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const { client, clientFeatures, protocolVersion } = mcpClientMetadata(
        context,
        server.server,
      );
      let androidAvailability: ProviderAvailability;
      let adbAvailability: ProviderAvailability | undefined;
      let apktoolAvailability: ProviderAvailability | undefined;
      try {
        const [android, adb, apktool] = await Promise.all([
          androidAnalysisAvailability(context.mcpReq.signal),
          adbAnalysisAvailability?.(context.mcpReq.signal) ?? undefined,
          apktoolAnalysisAvailability?.(context.mcpReq.signal) ?? undefined,
        ] as const);
        androidAvailability = android;
        adbAvailability = adb;
        apktoolAvailability = apktool;
      } catch (cause) {
        if (!context.mcpReq.signal.aborted) throw cause;
        return server.delivery.toCallToolResult(
          err(new AnalysisCancelledError("binary_session")),
          contract,
        );
      }
      const status = session.status();
      const statusObject = jsonObjectSchema.parse(status);
      const toolAvailability = buildCapabilityInventory(
        status,
        {
          ...availabilityPolicy(),
          androidAnalysisAvailability: androidAvailability,
          ...(adbAvailability === undefined
            ? {}
            : { adbAnalysisAvailability: adbAvailability }),
          ...(apktoolAvailability === undefined
            ? {}
            : { apktoolAnalysisAvailability: apktoolAvailability }),
        },
        clientFeatures,
      );
      const serverIdentity = createServerIdentity({
        startedAt,
        commandPath: CURRENT_ENTRYPOINT_PATH,
        catalog: server.catalogIdentity,
        expected: {
          ...(input.expected_package_version === undefined
            ? {}
            : { package_version: input.expected_package_version }),
          ...(input.expected_catalog_digest === undefined
            ? {}
            : { catalog_digest: input.expected_catalog_digest }),
          ...(input.expected_server_path === undefined
            ? {}
            : { server_path: input.expected_server_path }),
        },
        ...(client === undefined ? {} : { client }),
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
      });
      return server.delivery.toCallToolResult(
        {
          ok: true,
          value: projectSessionStatus({
            status:
              input.detail === "full"
                ? statusObject
                : summarizeProviderCandidates(statusObject),
            toolAvailability,
            serverIdentity,
            clientFeatures,
          }),
        },
        contract,
      );
    },
  );
};

type JsonObject = Readonly<Record<string, JsonValue>>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withoutDiagnostics = (value: JsonValue | undefined): JsonValue =>
  isJsonObject(value) ? { ...value, diagnostics: {} } : (value ?? null);

/**
 * Summary view: an unavailable provider's capability catalog (about 27 KB for
 * Ghidra) cannot be used until the provider is configured, and provider
 * diagnostics matter only when troubleshooting. Status, codes and reasons are
 * kept, so the caller still learns why each provider is unavailable;
 * detail=full restores everything.
 */
const summarizeProviderCandidates = (status: JsonObject): JsonObject => {
  const candidates = status["analysis_provider_candidates"];
  if (!Array.isArray(candidates)) return status;
  return {
    ...status,
    analysis_provider_candidates: candidates.map((candidate) => {
      if (!isJsonObject(candidate)) return candidate;
      const availability = candidate["availability"];
      const available =
        isJsonObject(availability) && availability["status"] === "available";
      return {
        ...candidate,
        availability: withoutDiagnostics(availability),
        target_support: withoutDiagnostics(candidate["target_support"]),
        capabilities: available ? (candidate["capabilities"] ?? []) : [],
      };
    }),
  };
};

const projectSessionStatus = (options: {
  readonly status: JsonObject;
  readonly toolAvailability: readonly ToolAvailability[];
  readonly serverIdentity: ReturnType<typeof createServerIdentity>;
  readonly clientFeatures: ClientFeatureAvailability;
}) =>
  jsonObjectSchema.parse({
    ...options.status,
    tool_availability: compactToolAvailability(options.toolAvailability),
    client_features: options.clientFeatures,
    server_identity: options.serverIdentity,
  });
