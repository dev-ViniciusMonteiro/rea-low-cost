import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { PACKAGE_METADATA } from "../generatedPackageMetadata.js";
import type { JavaScriptModuleSemanticIr } from "../domain/javascript/javascriptModuleSemanticIr.js";
import type { JavaScriptSemanticFileProjection } from "../domain/javascript/javascriptSemanticFileProjection.js";
import type { JavaScriptStaticAnalysis } from "../domain/javascript/javascriptStaticAnalysisTypes.js";
import {
  createJavaScriptAnalysisCache,
  javaScriptAnalyzerBuildIdentity,
} from "../javascript/analysis/JavaScriptAnalysisCache.js";
import { moduleResolutionModeForJavaScriptReference } from "../domain/javascript/javascriptModuleResolutionMode.js";
import { parseJavaScriptSource } from "../domain/javascript/javascriptSourceParser.js";
import { analyzeParsedJavaScriptStaticSourceSteps } from "../domain/javascript/javascriptStaticAnalysis.js";
import {
  analyzeParsedJavaScriptSemanticsSteps,
  classifyParsedJavaScriptOpenReceiversSteps,
} from "../domain/javascript/javascriptSemanticAnalysis.js";
import { failedJavaScriptStaticAnalysis } from "../domain/javascript/javascriptStaticAnalysisHelpers.js";
import { projectJavaScriptModuleSemantics } from "../domain/javascript/javascriptModuleSemanticIr.js";
import {
  javaScriptTransferByteBudget,
  measureJavaScriptModuleTransfer,
} from "../javascript/analysis/JavaScriptAnalysisTransfer.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { projectJavaScriptSemanticFileSteps } from "../application/javascript/JavaScriptSemanticGraphBuilder.js";
import { completeJavaScriptAnalysisSteps } from "../application/javascript/JavaScriptAnalysisControl.js";
import {
  serveJavaScriptAnalysisWorker,
  type JavaScriptSourceWorkerAnalyzer,
} from "../javascript/analysis/JavaScriptAnalysisWorkerServer.js";

const cache = createJavaScriptAnalysisCache(
  process.env,
  javaScriptAnalyzerBuildIdentity(
    fileURLToPath(import.meta.url),
    PACKAGE_METADATA.version,
  ),
);

type SemanticResult = {
  readonly module: JavaScriptModuleSemanticIr;
  readonly projection: JavaScriptSemanticFileProjection;
};

const startSemantics = (resultBudgetBytes: number, path: string): void => {
  if (resultBudgetBytes === 0)
    throw new AnalysisResourceConstraintError(
      "analyze_javascript_application",
      "memory",
      `The parent reserved its remaining result capacity for static observations; semantic analysis of ${path} was not started`,
      { semantic_result_budget_bytes: 0 },
    );
};

const admitModule = (
  module: JavaScriptModuleSemanticIr,
  resultBudgetBytes: number,
  path: string,
): void => {
  const measured = measureJavaScriptModuleTransfer(
    module,
    javaScriptTransferByteBudget(resultBudgetBytes),
  );
  if (measured.retentionBytes > resultBudgetBytes)
    throw new AnalysisResourceConstraintError(
      "analyze_javascript_application",
      "memory",
      `Completed module facts for ${path} exceed the parent's offered result budget; static facts were retained`,
      {
        semantic_result_budget_bytes: resultBudgetBytes,
        module_transfer_bytes: measured.bytes,
      },
    );
};

const analyze: JavaScriptSourceWorkerAnalyzer = async (
  file,
  nodeBudget,
  callbacks,
) => {
  if (!file.text.included)
    throw new TypeError("JavaScript worker requires decoded source text");
  const { text } = file;
  const textSha256 = createHash("sha256").update(text.value).digest("hex");
  // Static facts depend on the text and its path. The semantic projection also
  // reads the file's own digest and is bounded by the node budget; it does not
  // read the container digest or inventory id, which change whenever any other
  // file of the application changes and would defeat reuse across versions.
  const staticKey = { text_sha256: textSha256, path: file.path };
  const semanticKey = {
    ...staticKey,
    sha256: file.sha256,
    bytes: file.bytes,
    node_budget: nodeBudget,
  };
  await callbacks.phase("parse");
  const cachedFacts = await cache?.read<JavaScriptStaticAnalysis>(
    "static",
    staticKey,
  );
  const cachedSemantics =
    cachedFacts === undefined || cachedFacts.parse_status === "failed"
      ? undefined
      : await cache?.read<SemanticResult>("semantic", semanticKey);
  if (cachedFacts !== undefined && cachedSemantics !== undefined) {
    // Same protocol as a fresh run: checkpoint, admission, budget checks.
    await callbacks.phase("static");
    const resultBudgetBytes = await callbacks.checkpoint(cachedFacts);
    startSemantics(resultBudgetBytes, file.path);
    await callbacks.phase("semantic");
    admitModule(cachedSemantics.module, resultBudgetBytes, file.path);
    await callbacks.phase("projection");
    return cachedSemantics;
  }
  let parsed = parseJavaScriptSource(text.value, file.path);
  if (parsed === null) {
    await callbacks.checkpoint(failedJavaScriptStaticAnalysis());
    return null;
  }
  await callbacks.phase("static");
  const receivers = await completeJavaScriptAnalysisSteps(
    classifyParsedJavaScriptOpenReceiversSteps(parsed),
  );
  const facts = await completeJavaScriptAnalysisSteps(
    analyzeParsedJavaScriptStaticSourceSteps(text.value, parsed, receivers),
  );
  const resultBudgetBytes = await callbacks.checkpoint(facts);
  if (facts.parse_status === "failed") return null;
  startSemantics(resultBudgetBytes, file.path);
  await callbacks.phase("semantic");
  const ir = await completeJavaScriptAnalysisSteps(
    analyzeParsedJavaScriptSemanticsSteps(
      parsed,
      moduleResolutionModeForJavaScriptReference(file.path, "static-import"),
    ),
  );
  parsed = null;
  const module = projectJavaScriptModuleSemantics(ir);
  admitModule(module, resultBudgetBytes, file.path);
  await callbacks.phase("projection");
  const projection = await completeJavaScriptAnalysisSteps(
    projectJavaScriptSemanticFileSteps(
      file,
      ir,
      nodeBudget,
      facts.electron.call_paths,
    ),
  );
  // Only completed, admitted computations are stored.
  await cache?.write("static", staticKey, facts);
  await cache?.write("semantic", semanticKey, { module, projection });
  return { module, projection };
};

try {
  await serveJavaScriptAnalysisWorker(analyze);
} catch (cause: unknown) {
  process.stderr.write(
    `${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exitCode = 1;
}
