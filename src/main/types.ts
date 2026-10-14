import type { OptionalProviderLoadResult } from "../application/OptionalObservationProviders.js";

export interface RuntimeDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly serve: typeof import("@modelcontextprotocol/server/stdio").serveStdio;
  readonly writeStderr: (text: string) => void;
  readonly setExitCode: (code: number) => void;
  readonly registerShutdown: (handler: () => void) => () => void;
  readonly createServer?: typeof import("../server/createServer.js").createServer;
  readonly loadOptionalProviders?: () => Promise<OptionalProviderLoadResult>;
  /** Receives the connection's idempotent cleanup once serving starts. */
  readonly onShutdownReady?: (shutdown: () => Promise<void>) => void;
}
