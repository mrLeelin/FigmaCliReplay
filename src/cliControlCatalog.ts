/** Offline documentation for the control actions accepted by relayControl.ts.
 * These schemas describe inputs; the existing controllers remain the execution validators.
 */
export interface ControlOperationDescription {
  name: string;
  kind: "control";
  summary: string;
  payloadSchema: Record<string, unknown>;
  examples: Array<{ payload: Record<string, unknown>; description?: string }>;
  notes?: string[];
  source: string;
}

type Schema = Record<string, unknown>;
const text = (description: string, extra: Schema = {}): Schema => ({ type: "string", description, ...extra });
const nonempty = (description: string, extra: Schema = {}): Schema => text(description, { minLength: 1, ...extra });
const object = (properties: Record<string, Schema> = {}, required: string[] = []): Schema => ({
  type: "object", properties, required, additionalProperties: true,
});
const array = (items: Schema, extra: Schema = {}): Schema => ({ type: "array", items, ...extra });
const bool = (description: string): Schema => ({ type: "boolean", description });
const integer = (description: string, extra: Schema = {}): Schema => ({ type: "integer", description, ...extra });
const stableId = nonempty("Stable caller-generated ID; reuse only with identical parameters.", { pattern: "^[A-Za-z0-9_-]{1,128}$" });
const session = {
  sessionId: nonempty("Target live Figma session. Prefer the CLI --session-id option."),
  fileKey: nonempty("Target Figma file. Must match the selected session."),
};
const liveNotes = ["Requires exactly one matching authenticated live Figma session. Select it with --session-id or --file-key; the Relay supplies the resolved sessionId/fileKey."];
const run = {
  runId: nonempty("Run ID returned by the start operation."),
  capabilityToken: nonempty("Capability token returned by start; keep it private."),
};
const runExample = { runId: "<runId>", capabilityToken: "<capabilityToken>" };
const projectId = nonempty("Registered Unity project ID from unity.projects.list.");
const taskId = nonempty("Existing task ID returned by the start operation.");
const snapshot = object({
  schemaVersion: { const: 1 }, rootNodeId: nonempty("Root node present in nodes."),
  nodes: array(object({
    id: nonempty("Unique node ID."), parentId: text("Parent ID."), type: text("Figma node type."), name: text("Node name."),
    siblingIndex: integer("Sibling index."), depth: integer("Depth in the snapshot."),
  }, ["id", "siblingIndex", "depth"])),
}, ["schemaVersion", "rootNodeId", "nodes"]);
const snapshotExample = { schemaVersion: 1, rootNodeId: "1:2", nodes: [{ id: "1:2", parentId: "", type: "FRAME", name: "Panel", siblingIndex: 0, depth: 0 }] };
const uncertainWrite = "When the result is unknown, query the original task/request ID before retrying; a Relay restart does not recover in-memory task state.";

function op(name: string, summary: string, payloadSchema: Schema, payload: Record<string, unknown> = {}, notes: string[] = [], source = "src/relayControl.ts"): ControlOperationDescription {
  return { name, kind: "control", summary, payloadSchema, examples: [{ payload }], ...(notes.length ? { notes } : {}), source };
}

const operations: ControlOperationDescription[] = [
  op("relay.status", "Read Relay health, plugin sessions, and runtime paths.", object()),
  op("relay.update.status", "Read fixed-install update progress and publisher configuration.", object(), {}, ["Works without a live Figma session, including version mismatch recovery."], "src/updateService.ts"),
  op("relay.update.check", "Check the publisher-pinned signed release feed.", object(), {}, [], "src/updateService.ts"),
  op("relay.update.settings", "Save automatic update-check preference; installation remains explicit.", object({ autoCheck: bool("Check on plugin startup.") }, ["autoCheck"]), { autoCheck: true }, [], "src/updateService.ts"),
  op("relay.update.install", "Start the independent updater; reconcile status after an uncertain response.", object({ updateBridge: bool("Also update only the currently selected Unity project Bridge."), projectId }, []), { updateBridge: false }, ["Requires a managed installation and a signed newer release. Waits for active work before switching. Reopen the Figma plugin when prompted."], "src/updateService.ts"),
  op("relay.update.activity", "Read current process identity and whether work prevents a safe update.", object(), {}, [], "src/updateService.ts"),
  op("relay.update.shutdown", "Updater-only graceful stop matching the durable approved plan.", object({ planId: nonempty("Approved plan ID from the local updater record.") }, ["planId"]), { planId: "<planId>" }, ["Rejects mismatched plans and active work. Used by the independent updater."], "src/updateService.ts"),
  op("logs.query", "Query structured logs with filters and pagination.", object({ query: object({
    from: text("Inclusive start timestamp parseable by Date.parse."), to: text("End timestamp; must not precede from."),
    level: { type: "string", enum: ["trace", "debug", "info", "warn", "error", "fatal"] },
    source: { type: "string", enum: ["ui", "plugin", "relay", "python", "unity"] },
    status: { type: "string", enum: ["started", "progress", "succeeded", "failed", "cancelled"] },
    module: text("Module filter.", { maxLength: 2000 }), operationId: text("Operation ID filter.", { maxLength: 2000 }),
    keyword: text("Keyword filter.", { maxLength: 2000 }), cursor: integer("Pagination cursor.", { minimum: 0 }),
    limit: integer("Maximum events.", { minimum: 1, maximum: 1000, default: 200 }),
  }) }), { query: { source: "relay", limit: 100 } }),
  op("unity.projects.list", "List registered Unity projects and their IDs.", object()),
  op("unity.projects.add", "Register an existing Unity project directory.", object({ path: nonempty("Absolute Unity project directory containing Assets and ProjectSettings.") }, ["path"]), { path: "E:/Projects/MyGame" }, [], "src/unityProjectRegistry.ts"),
  op("unity.projects.select", "Set the explicitly identified project as last selected.", object({ id: projectId }, ["id"]), { id: "<projectId>" }),
  op("unity.projects.remove", "Remove a project registration without deleting project files.", object({ id: projectId }, ["id"]), { id: "<projectId>" }),
  op("unity.bridge.install", "Install/update Unity Bridge in the explicitly identified project.", object({ id: projectId }, ["id"]), { id: "<projectId>" }, ["Writes Bridge files and settings in the target project. Installation is not proof that the Editor compiled or connected."]),
  op("unity.gateway.get", "Read the live outbound Unity Bridge connection for a registered project.", object({ id: projectId }, ["id"]), { id: "<projectId>" }, ["Returns found:false when offline; does not return Bridge credentials."]),
  op("unity.command", "Submit a Unity Bridge business command with a stable request ID.", object({
    id: projectId, requestId: stableId, action: nonempty("Unity Bridge action, for example unity.health."),
    body: { type: "object", additionalProperties: true, description: "Action-specific JSON body; see Unity Bridge action contract." },
    query: text("Optional action query string."), timeoutMs: { type: "number", minimum: 100, maximum: 120000, default: 30000 },
  }, ["id", "requestId", "action"]), { id: "<projectId>", requestId: "health-001", action: "unity.health" }, ["Schema covers the Relay envelope only; body is action-specific, not a complete Unity action schema.", uncertainWrite]),
  op("unity.command-status", "Read the status of the original Unity request without replaying it.", object({
    id: projectId, requestId: stableId, timeoutMs: { type: "number", minimum: 100, maximum: 120000, default: 30000 },
  }, ["id", "requestId"]), { id: "<projectId>", requestId: "health-001" }),
  op("prefab.resolve-dropped", "Resolve dropped Prefab names against one registered Unity project.", object({
    projectId, files: array(object({ fileName: nonempty("Prefab file name ending in .prefab."), text: text("Optional serialized Prefab text.") }, ["fileName"]), { minItems: 1 }),
  }, ["projectId", "files"]), { projectId: "<projectId>", files: [{ fileName: "Panel.prefab" }] }, ["Multiple matches are returned as conflicts; do not select an arbitrary match."], "src/prefabDropResolver.ts"),
];

const psdTarget = object({ ...session, targetNodeId: text("Required for incremental-preview."), targetName: text("Target display name."), targetType: { type: "string", enum: ["FRAME", "COMPONENT"] } });
operations.push(
  op("psd.import.start", "Start an initial PSD import or incremental preview in Figma.", object({
    ...session, clientRequestId: stableId, fileName: text("PSD file name.", { pattern: "\\.[pP][sS][dD]$", default: "source.psd" }),
    fileBase64: nonempty("Base64-encoded PSD bytes."), mode: { type: "string", enum: ["initial", "incremental-preview"], default: "initial" },
    target: psdTarget, sourceFile: object({ lastModified: { type: "number", minimum: 0 } }),
  }, ["clientRequestId", "fileBase64"]), { clientRequestId: "psd-001", fileName: "Panel.psd", fileBase64: "<PSD_BASE64>", mode: "initial", target: {} },
  [...liveNotes, "incremental-preview requires target.targetNodeId and target.targetType FRAME or COMPONENT. Nested target session/file fields must match the resolved session.", uncertainWrite], "src/psdImportTask.ts"),
  op("psd.import.get", "Read the original PSD import task.", object({ ...session, taskId }, ["taskId"]), { taskId: "psd-001" }),
  op("psd.import.cancel", "Request cancellation of a PSD import; inspect accepted and actual task status.", object({ ...session, taskId }, ["taskId"]), { taskId: "psd-001" }, ["A task already submitting to Figma may reject cancellation; CLI success does not prove it was cancelled."]),
  ...["apply", "adopt-baseline"].map((action) => op(`psd.import.${action}`, action === "apply" ? "Apply an existing incremental PSD preview." : "Adopt the baseline from an existing PSD preview.", object({
    ...session, taskId, baselineFingerprint: nonempty("Exact fingerprint returned by the preview."),
  }, ["taskId", "baselineFingerprint"]), { taskId: "psd-001", baselineFingerprint: "<previewFingerprint>" }, [...liveNotes, uncertainWrite], "src/psdImportTask.ts")),
  op("plugin.open-folder", "Open the Relay plugin directory in the desktop file manager.", object()),
  op("psd.export.open-folder", "Open/create the PSD output directory in the desktop file manager.", object()),
);

const exportProperties = {
  nodes: array({ type: "object", additionalProperties: true, description: "PSD node manifest from the Figma export job; see server/psd_export.py _validate_nodes/build_psd." }, { minItems: 1, maxItems: 5000 }),
  size: object({ width: { type: "number", exclusiveMinimum: 0, description: "Canvas width." }, height: { type: "number", exclusiveMinimum: 0, description: "Canvas height." } }, ["width", "height"]),
  scale: { type: "number", minimum: 0.1, maximum: 8, default: 1 },
  outputDir: text("Optional absolute output directory beneath the Relay .tmp/exports directory."),
  baseName: text("Output file base name.", { default: "export" }), imagesPrestretched: bool("Images and coordinates already reflect the export scale."),
  warnings: array(text("Export warning.")),
};
const exportNotes = ["Partial nested schema: node manifest rendering, clipping, images, and hierarchy rules are implemented in server/psd_export.py; use the Figma export manifest rather than inventing nodes.", "PSD dimensions after scaling must not exceed 30000 pixels. Requests must fit the 16 MiB transport limit."];
operations.push(
  op("psd.export", "Assemble a PSD from an inline Figma node manifest and PNG layers.", object(exportProperties, ["nodes", "size"]), { nodes: [{ id: "1:2", name: "Panel", synthetic: true }], size: { width: 1080, height: 1920 }, scale: 1 }, exportNotes, "server/psd_export.py"),
  op("psd.export.stage-meta", "Stage PSD node metadata before sending image chunks.", object({ ...exportProperties, taskId: stableId }, ["taskId", "nodes", "size"]), { taskId: "psd-export-001", nodes: [{ id: "1:2", name: "Panel", synthetic: true }], size: { width: 1080, height: 1920 } }, exportNotes, "server/psd_export.py"),
  op("psd.export.stage-chunk", "Stage PNG layers/fragments for an existing PSD export manifest.", object({
    taskId: stableId, outputDir: exportProperties.outputDir,
    layers: array(object({ id: nonempty("Node ID registered by stage-meta."), pngBase64: nonempty("PNG bytes, or aligned base64 fragment."), partIndex: integer("Zero-based fragment index.", { minimum: 0 }), partCount: integer("Total fragments; must exceed partIndex.", { minimum: 1 }) }, ["id", "pngBase64"]), { minItems: 1, maxItems: 500 }),
  }, ["taskId", "layers"]), { taskId: "psd-export-001", layers: [{ id: "1:2", pngBase64: "<PNG_BASE64>" }] }, ["stage-meta must exist first. Fragment index/count must be supplied together; fragments must be base64-aligned and agree with previous chunks."], "server/psd_export.py"),
  op("psd.export.assemble", "Assemble a PSD from a previously staged manifest and image chunks.", object({ taskId: stableId, outputDir: exportProperties.outputDir }, ["taskId"]), { taskId: "psd-export-001" }, ["Required image chunks must all be present before assembly."], "server/psd_export.py"),
  op("image.crop", "Crop/import image bytes and nine-slice metadata into a Unity project.", object({
    ...session, unityProjectPath: nonempty("Absolute Unity project root."), unityProjectRoot: text("Legacy alias for unityProjectPath."), targetDir: nonempty("Existing destination directory beneath Unity Assets."),
    targetMode: text("Use replaceImage to replace one existing image."), replaceAssetPath: text("Existing Unity image asset path when replacing."),
    images: array(object({ base64: nonempty("Source image bytes in base64."), fileName: text("Output file name.", { default: "image.png" }), imageType: text("Use Sliced to apply nine-slice cropping."),
      borderLeft: { type: "number" }, borderRight: { type: "number" }, borderTop: { type: "number" }, borderBottom: { type: "number" },
    }, ["base64"]), { minItems: 1 }),
  }, ["targetDir", "images"]), { unityProjectPath: "E:/Projects/MyGame", targetDir: "Assets/UI", images: [{ fileName: "Panel.png", base64: "<PNG_BASE64>" }] },
  [...liveNotes, "Supply unityProjectPath, legacy unityProjectRoot, or the FIGMA_UNITY_PROJECT environment variable. Replacement requires exactly one image and a valid replaceAssetPath. Schema documents the supported fields; binary validity, path containment, and crop geometry are checked at runtime."], "server/crop_jiugong.py"),
  op("prefab.import.start", "Start importing existing Unity Prefabs into Figma.", object({
    ...session, clientRequestId: stableId, unityProjectPath: nonempty("Absolute Unity project root."), unityProjectRoot: text("Legacy project path alias."),
    prefabPaths: array(nonempty("Existing project .prefab path beneath Assets."), { minItems: 1 }), canvas: text("Canvas selection.", { default: "auto" }),
    canvasByPrefabPath: { type: "object", additionalProperties: { type: "string" } }, componentMode: { type: "string", enum: ["component", "frame"], default: "component" },
    nestedPrefabComponentMode: { type: "string", enum: ["all", "commonOnly", "none"], default: "all" }, figmaUrl: text("Optional Figma target URL."), targetNodeId: text("Optional target node ID."),
  }, ["clientRequestId", "prefabPaths"]), { clientRequestId: "prefab-import-001", unityProjectPath: "E:/Projects/MyGame", prefabPaths: ["Assets/UI/Panel.prefab"] },
  [...liveNotes, "Supply unityProjectPath, legacy unityProjectRoot, or FIGMA_UNITY_PROJECT. Partial nested contract: Prefab serialization, canvas mapping and nested component behavior are validated by the import pipeline.", uncertainWrite], "server/prefab_import_pipeline.py"),
  op("prefab.import.get", "Read the original Unity-to-Figma import task for its session.", object({ sessionId: session.sessionId, taskId }, ["sessionId", "taskId"]), { sessionId: "<sessionId>", taskId: "prefab-import-001" }, [], "src/pythonAlgorithms.ts"),
  op("figma.prefab.start", "Start exporting one Figma root to a new Unity Prefab.", object({
    ...session, clientRequestId: stableId, projectId, gatewayProjectPath: nonempty("Absolute path matching the registered Unity project."), targetFolder: nonempty("Selected Unity Assets directory."),
    nodeId: nonempty("Figma root node ID."), nodeName: nonempty("Expected root node name."), nodeWidth: integer("Optional expected width.", { minimum: 1 }), nodeHeight: integer("Optional expected height.", { minimum: 1 }),
    outputMode: { type: "string", enum: ["direct-import", "named-export"], default: "direct-import" },
  }, ["clientRequestId", "projectId", "gatewayProjectPath", "targetFolder", "nodeId", "nodeName"]), { clientRequestId: "figma-prefab-001", projectId: "<projectId>", gatewayProjectPath: "E:/Projects/MyGame", targetFolder: "Assets/UI", nodeId: "1:2", nodeName: "Panel" },
  [...liveNotes, "Creates new output; existing artifacts/output conflicts are rejected. named-export supports the selected Assets root and exports without an atlas.", uncertainWrite], "src/figmaPrefabImportTask.ts"),
  op("figma.prefab.get", "Read the original Figma-to-Unity export task.", object({ ...session, taskId }, ["taskId"]), { taskId: "figma-prefab-001" }),
);

const dxxProperties = {
  apiBase: text("HTTPS origin only, with no path, credentials, query, or fragment."),
  apiKey: text("Optional API key; never put a real key in shared examples or logs.", { maxLength: 8192, writeOnly: true }),
};
operations.push(
  op("dxx.config.get", "Read DXX configuration metadata without exposing the stored key.", object(), {}, [], "src/dxxConfig.ts"),
  op("dxx.config.read", "Read DXX settings including the effective API key for explicit settings display.", object(), {}, ["Sensitive response: includes the stored/effective API key. Use dxx.config.get for routine status; do not log this response."], "src/dxxConfig.ts"),
  op("dxx.config.set", "Save project-local DXX API settings.", object({ ...dxxProperties, clearKey: bool("Clear the stored key; cannot be combined with a nonempty apiKey.") }), { apiBase: "https://canvas.dxx.cn" }, ["Omitted/empty apiKey preserves the existing effective key unless clearKey is true."], "src/dxxConfig.ts"),
  op("dxx.config.test", "Test DXX authentication and layer decomposition availability without creating a job.", object(dxxProperties), {}, ["Uses saved/environment credentials when no apiKey override is supplied; does not save overrides."], "src/dxxConfig.ts"),
  op("ai.providers", "List available AI planning providers.", object()),
  op("ai.skill.status", "Check installed Figma Relay Skill files for Codex and Claude Code.", { type: "object", properties: { target: { type: "string", enum: ["all", "codex", "claude"], default: "all" } }, additionalProperties: false }, {}, ["Read-only. Checks all required files and the current Relay path; distinguishes installed, missing, outdated, modified and error. Does not prove that an AI session loaded or invoked the Skill."], "src/aiSkillManager.ts"),
  op("ai.skill.install", "Write or update the Figma Relay Skill in the current user's agent directories.", { type: "object", properties: { target: { type: "string", enum: ["all", "codex", "claude"], default: "all" } }, additionalProperties: false }, { target: "all" }, ["Writes only the selected Skill files. Keeps agent settings and locally edited files; preflights all selected clients before writing. Returns a fresh file-status check. Destination paths are determined by Relay, not payload input."], "src/aiSkillManager.ts"),
  op("ai.status", "Read the selected local AI runner and command availability.", object()),
  op("ai.config", "Save the local AI runner preset.", object({ ...session, runner: { type: "string", enum: ["codex", "claude"], default: "codex" } }), { runner: "codex" }, liveNotes, "src/localAiRunner.ts"),
);

const promptProperties = {
  ...session, runner: { type: "string", enum: ["codex", "claude"], default: "codex" },
  template: { type: "string", enum: ["cleanup", "unity", "componentVariants"] }, prompt: nonempty("User task prompt."),
  unityProject: object({ id: projectId }, ["id"]), cleanupSnapshot: snapshot, clientRequestId: nonempty("Stable request ID required for cleanup runs."),
};
operations.push(
  op("ai.open-terminal", "Open an interactive local AI terminal for a Figma task.", object(promptProperties, ["template", "prompt"]), { runner: "codex", template: "componentVariants", prompt: "Inspect the selected component variants." },
  [...liveNotes, "Opens a visible interactive terminal and does not create a trackable AiRun. template unity requires unityProject.id."], "src/localAiRunner.ts"),
  op("ai.run.start", "Start a tracked local AI task.", object(promptProperties, ["template", "prompt"]), { template: "componentVariants", prompt: "Inspect the selected component variants." },
  [...liveNotes, "template unity requires unityProject.id. template cleanup requires cleanupSnapshot and clientRequestId; use an actual fresh snapshot.", uncertainWrite], "src/localAiRunner.ts"),
  op("ai.run.get", "Read AI run output after a sequence number.", object({ ...run, afterSequence: integer("Output cursor.", { minimum: 0, default: 0 }) }, ["runId", "capabilityToken"]), { ...runExample, afterSequence: 0 }),
  op("ai.run.followup", "Continue an AI run after its current turn has stopped.", object({ ...run, text: nonempty("Follow-up user instruction."), clientRequestId: nonempty("Stable follow-up request ID."), cleanupSnapshot: snapshot }, ["runId", "capabilityToken", "text", "clientRequestId"]),
  { ...runExample, text: "Inspect the result.", clientRequestId: "followup-001" }, ["Cleanup follow-ups can require a fresh cleanupSnapshot depending on the requested phase. Reusing clientRequestId with different text is rejected."], "src/localAiRunner.ts"),
  op("ai.run.stop", "Request that the current local AI run stop.", object(run, ["runId", "capabilityToken"]), runExample),
  op("cleanup.run.start", "Start a hierarchy cleanup plan from an actual Figma snapshot.", object({
    ...session, providerId: { type: "string", enum: ["codex", "claude-code"] }, snapshot,
    autoApprove: { type: "boolean", default: false, description: "Record direct cleanup authorization and execute a validated plan automatically." },
  }, ["providerId", "snapshot"]), { providerId: "codex", snapshot: snapshotExample, autoApprove: false },
  [...liveNotes, "Use the actual current snapshot; placeholder nodes are illustrative only. Snapshot geometry and hierarchy invariants are checked by the cleanup planner."], "src/cleanup/cleanupController.ts"),
  op("cleanup.run.get", "Read cleanup run state and output after a sequence number.", object({ ...run, afterSequence: integer("Output cursor.", { minimum: 0, default: 0 }) }, ["runId", "capabilityToken"]), { ...runExample, afterSequence: 0 }),
  op("cleanup.run.approve", "Approve an existing validated cleanup plan with its exact snapshot hash.", object({ ...run, approval: { const: true }, snapshotHash: nonempty("Exact snapshot hash from the reviewed run.") }, ["runId", "capabilityToken", "approval", "snapshotHash"]),
  { ...runExample, approval: true, snapshotHash: "<snapshotHash>" }, ["Requires a reviewable validated plan. The controller rejects stale hashes."], "src/cleanup/cleanupController.ts"),
  op("cleanup.run.cancel", "Request cancellation of a cleanup run.", object(run, ["runId", "capabilityToken"]), runExample),
  op("cleanup.run.confirm-component-sets", "Record cleanup satisfaction before component-set creation.", object({ ...run, satisfied: bool("Whether the verified hierarchy is satisfactory."), feedback: text("Optional feedback.") }, ["runId", "capabilityToken", "satisfied"]),
  { ...runExample, satisfied: true }, ["The controller enforces the expected phase before continuing."], "src/cleanup/cleanupController.ts"),
);

export const controlOperations: ControlOperationDescription[] = operations.sort((left, right) => left.name.localeCompare(right.name));
