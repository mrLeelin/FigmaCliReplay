import { DEFAULT_HOST, DEFAULT_PORT, SERVER_VERSION } from "./config.js";
import { RELAY_CLI_PATH, RelayProtocolError } from "./relayProtocol.js";
import { controlOperations } from "./cliControlCatalog.js";
import { figmaOperations } from "./cliFigmaCatalog.js";
import type { JsonSchema } from "./cliSchema.js";

interface Operation {
  name: string;
  kind: "figma" | "control";
  summary: string;
  payloadSchema: JsonSchema;
  examples: Array<{ payload: Record<string, unknown>; description?: string }>;
  notes?: string[];
  source: string;
}

interface CommandDefinition {
  name: string;
  summary: string;
  usage: string;
  options: string[];
  required?: string[];
  operation?: string;
  examples: string[];
  notes?: string[];
}

const connection = ["url", "timeout"];
const target = ["session-id", "file-key"];
const submission = ["request-id", "detach"];
const payload = ["payload", "payload-file", "assets-file"];
const flags: Record<string, JsonSchema> = {
  url: { type: "string", default: `ws://${DEFAULT_HOST}:${DEFAULT_PORT}${RELAY_CLI_PATH}`, description: "Local Relay WebSocket URL; does not start or stop the service." },
  timeout: { type: "number", default: 15, minimum: 0.1, maximum: 120, description: "Wait timeout in seconds. A timeout does not cancel the submitted task." },
  "session-id": { type: "string", description: "Target plugin session ID from sessions. Required to disambiguate multiple matching sessions." },
  "file-key": { type: "string", description: "Target Figma file key. If combined with session-id, both must match." },
  "request-id": { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$", description: "Stable submission ID. Reuse only for the same request; reconcile uncertain writes before resubmitting." },
  "task-id": { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$", description: "Previously submitted task ID." },
  detach: { type: "boolean", default: false, description: "Return after submission without waiting for completion (selection and figma-command jobs)." },
  "job-type": { type: "string", description: "Operation name from commands; use describe <name> for its payload contract." },
  payload: { type: "string", description: "JSON object. Mutually exclusive with payload-file; PowerShell callers should prefer payload-file." },
  "payload-file": { type: "string", description: "Path to a UTF-8 JSON object file. Supply routing via session-id/file-key, outside the Figma payload." },
  "assets-file": { type: "string", description: "UTF-8 JSON object mapping asset IDs to local paths within Relay-allowed directories." },
  json: { type: "boolean", description: "Return machine-readable JSON for discovery/help queries. Optional for business commands, which always return JSON." },
  kind: { type: "string", enum: ["command", "figma", "control"], description: "Filter the discovery catalog by entry kind." },
  search: { type: "string", description: "Filter the discovery catalog by name or summary (case insensitive)." },
  help: { type: "boolean", description: "Show this command's help without connecting to Relay." },
};

export const commandDefinitions: CommandDefinition[] = [
  { name: "commands", summary: "List commands and available business operations offline", usage: "commands [--kind command|figma|control] [--search text] [--json]", options: ["kind", "search", "json"], examples: ["commands", "commands --kind figma --json", "commands --search unity"] },
  { name: "describe", summary: "Describe one command or operation, including its JSON input contract", usage: "describe <name> [--json]", options: ["json"], examples: ["describe FIGMA_INSPECT_NODES", "describe unity.projects.list --json", "describe selection --json"] },
  { name: "help", summary: "Show general or command-specific help offline", usage: "help [command-or-operation] [--json]", options: ["json"], examples: ["help", "help figma-children", "help FIGMA_INSPECT_NODES"] },
  { name: "sessions", summary: "List connected Figma plugin sessions", usage: "sessions [options]", options: connection, examples: ["sessions"] },
  { name: "selection", summary: "Read selected nodes from the target Figma session", usage: "selection [options]", options: [...target, ...connection, ...submission], operation: "QUERY_SELECTION", examples: ["selection", "selection --session-id <sessionId>"] },
  { name: "figma-status", summary: "Query Figma plugin status", usage: "figma-status [options]", options: [...target, ...connection, ...submission, ...payload], operation: "QUERY_PLUGIN_STATUS", examples: ["figma-status"] },
  { name: "figma-children", summary: "Query children of a node", usage: "figma-children --payload-file request.json [options]", options: [...target, ...connection, ...submission, ...payload], operation: "QUERY_NODE_CHILDREN", examples: ["figma-children --payload-file request.json"] },
  { name: "figma-components", summary: "Query available components", usage: "figma-components [options]", options: [...target, ...connection, ...submission, ...payload], operation: "COLLECT_COMPONENTS", examples: ["figma-components"] },
  { name: "figma-pages", summary: "Query Figma pages", usage: "figma-pages [options]", options: [...target, ...connection, ...submission, ...payload], operation: "QUERY_FIGMA_PAGES", examples: ["figma-pages"] },
  { name: "figma-command", summary: "Submit a Figma business operation over WebSocket", usage: "figma-command --job-type <name> --payload-file request.json [options]", options: ["job-type", ...payload, ...target, ...connection, ...submission], required: ["job-type"], examples: ["figma-command --job-type FIGMA_INSPECT_NODES --payload-file request.json --session-id <sessionId>"], notes: ["Requires --payload or --payload-file. Discover operations with commands --kind figma, then describe <name>."] },
  { name: "control", summary: "Execute Relay, AI, cleanup, Unity and import controls", usage: "control --job-type <name> --payload-file request.json [options]", options: ["job-type", ...payload, ...target, ...connection], required: ["job-type"], examples: ["control --job-type unity.projects.list --payload-file request.json"], notes: ["Requires --payload or --payload-file, including {} for empty payloads. Discover operations with commands --kind control."] },
  ...["status", "wait", "cancel"].map((verb): CommandDefinition => ({
    name: `task-${verb}`, summary: { status: "Read a submitted task's status", wait: "Wait for task completion over WebSocket", cancel: "Request task cancellation; inspect the returned state" }[verb]!,
    usage: `task-${verb} --task-id <id> [options]`, options: ["task-id", ...connection], required: ["task-id"], examples: [`task-${verb} --task-id <taskId>`],
    notes: ["CLI exit or timeout does not cancel a task. Check the original task ID after a disconnect or an uncertain write result."],
  })),
  ...["status", "wait", "cancel"].map((verb): CommandDefinition => ({
    name: `psd-${verb}`, summary: { status: "Read PSD import task status", wait: "Wait for PSD completion or an actionable preview", cancel: "Request PSD cancellation; inspect result.accepted" }[verb]!,
    usage: `psd-${verb} --task-id <id> [options]`, options: ["task-id", ...target, ...connection], required: ["task-id"], examples: [`psd-${verb} --task-id <taskId> --session-id <sessionId>`],
    notes: ["Use the original session and task ID. Cancellation can be refused once Figma submission has started."],
  })),
  { name: "serve", summary: "Process JSON-line requests over one persistent Relay connection", usage: "serve [options]", options: connection, examples: ["serve"], notes: [
    'stdin: one JSON request per line, e.g. {"action":"relay.sessions","payload":{}}.',
    'For controls: {"action":"relay.control","payload":{"controlAction":"unity.projects.list","controlPayload":{}}}.',
    'stdout starts with {"type":"serve.ready",...}, then one response per request. stdin EOF closes the connection.',
    "Supported wire actions: relay.sessions, figma.selection, figma.command, relay.control, task.status, task.wait, task.cancel. See src/relayProtocol.ts for the strict envelope schema.",
  ] },
];

export const executionCommandNames = commandDefinitions.map((entry) => entry.name)
  .filter((name) => !["commands", "describe", "help"].includes(name));

const operations: Operation[] = [...figmaOperations, ...controlOperations];
const schemaVersion = 1;

export function listEntries(kind?: string, search?: string) {
  if (kind && !["command", "figma", "control"].includes(kind)) {
    throw new RelayProtocolError("USAGE", "--kind must be command, figma or control.");
  }
  const matches = (entry: { name: string; summary: string }) => !search || `${entry.name} ${entry.summary}`.toLowerCase().includes(search.toLowerCase());
  return {
    schemaVersion, version: SERVER_VERSION,
    commands: kind && kind !== "command" ? [] : commandDefinitions.filter(matches).map(({ name, summary }) => ({ name, kind: "command", summary, describeCommand: `figma-relay describe ${name}` })),
    operations: operations.filter((entry) => (!kind || kind === entry.kind) && matches(entry)).map(({ name, kind: entryKind, summary }) => ({ name, kind: entryKind, summary, describeCommand: `figma-relay describe ${name}` })),
  };
}

export function describeEntry(name: string): Record<string, unknown> {
  const command = commandDefinitions.find((entry) => entry.name === name);
  if (command) {
    const optionNames = [...command.options, "help", "json"].filter((value, index, all) => all.indexOf(value) === index);
    const operation = operations.find((entry) => entry.name === command.operation);
    return {
      schemaVersion, version: SERVER_VERSION, kind: "command", ...command,
      usage: `figma-relay ${command.usage}`,
      optionsSchema: { type: "object", properties: Object.fromEntries(optionNames.map((flag) => [flag, flags[flag]])), required: command.required ?? [], additionalProperties: false },
      ...(operation ? { payloadSchema: operation.payloadSchema, payloadExamples: operation.examples, notes: [...(command.notes ?? []), ...(operation.notes ?? [])] } : {}),
      examples: command.examples.map((example) => `figma-relay ${example}`),
    };
  }
  const operation = operations.find((entry) => entry.name === name);
  if (!operation) throw new RelayProtocolError("USAGE", `Unknown command or operation '${name}'. Run figma-relay commands or figma-relay commands --search <text>.`);
  const entrypoint = operation.kind === "figma" ? "figma-command" : "control";
  return {
    schemaVersion, version: SERVER_VERSION, ...operation,
    usage: `figma-relay ${entrypoint} --job-type ${operation.name} --payload-file request.json${operation.kind === "figma" ? " --session-id <sessionId>" : ""}`,
    payloadSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", ...operation.payloadSchema },
    examples: operation.examples.map((example) => ({
      ...example,
      command: `figma-relay ${entrypoint} --job-type ${operation.name} --payload-file request.json${operation.kind === "figma" ? " --session-id <sessionId>" : ""}`,
      argv: [entrypoint, "--job-type", operation.name, "--payload", JSON.stringify(example.payload), ...(operation.kind === "figma" ? ["--session-id", "<sessionId>"] : [])],
    })),
    notes: [
      ...(operation.kind === "figma" ? ["Use sessions to choose an online target. Routing uses --session-id/--file-key outside the payload; --job-type supplies the job type."] : []),
      "Examples contain placeholders; replace IDs and paths before execution. For PowerShell, save the example payload as UTF-8 request.json and use --payload-file to avoid JSON quoting issues.",
      ...(operation.notes ?? []),
    ],
  };
}

export function renderCatalog(kind?: string, search?: string): string {
  const catalog = listEntries(kind, search);
  const rows = [...catalog.commands, ...catalog.operations].map((entry) => `  ${entry.name.padEnd(45)} ${entry.summary}`);
  return ["Figma Relay CLI catalog", "", ...rows, "", "Inspect parameters: figma-relay describe <name> [--json]", "This is a local catalog, not proof that a plugin or Unity Editor is connected."].join("\n");
}

export function renderDescription(name: string): string {
  const entry = describeEntry(name);
  const lines = [String(entry.name), String(entry.summary), "", `Usage: ${entry.usage}`];
  const optionsSchema = entry.optionsSchema as { properties: Record<string, JsonSchema>; required: string[] } | undefined;
  if (optionsSchema) {
    lines.push("", "Options:");
    for (const [flag, schema] of Object.entries(optionsSchema.properties)) {
      const constraints = [
        schema.enum ? ` Choices: ${(schema.enum as string[]).join(", ")}.` : "",
        schema.minimum !== undefined ? ` Minimum: ${schema.minimum}.` : "",
        schema.maximum !== undefined ? ` Maximum: ${schema.maximum}.` : "",
        schema.default !== undefined ? ` Default: ${schema.default}.` : "",
      ].join("");
      lines.push(`  --${flag}${schema.type === "boolean" ? "" : " <value>"}${optionsSchema.required.includes(flag) ? " (required)" : ""}  ${schema.description}${constraints}`);
    }
  }
  if (entry.payloadSchema) lines.push("", "Payload JSON Schema:", JSON.stringify(entry.payloadSchema, null, 2));
  if (entry.payloadExamples) lines.push("", "Example payload (request.json):", JSON.stringify((entry.payloadExamples as Operation["examples"])[0]?.payload ?? {}, null, 2));
  lines.push("", "Examples:");
  for (const example of entry.examples as Array<string | { payload: unknown; command: string; description?: string }>) {
    if (typeof example === "string") lines.push(`  ${example}`);
    else lines.push(`  ${example.description ?? "Save as request.json:"}`, JSON.stringify(example.payload, null, 2), `  ${example.command}`);
  }
  for (const note of (entry.notes as string[] | undefined) ?? []) lines.push(`\n${note}`);
  if (entry.source) lines.push(`\nContract source: ${entry.source}`);
  return lines.join("\n") + "\n";
}

export function renderHelp(): string {
  return [
    "Figma Relay CLI", "", "Usage: figma-relay <command> [options]", "",
    ...commandDefinitions.map((entry) => `  ${entry.name.padEnd(20)} ${entry.summary}`), "",
    "Discover: figma-relay commands [--kind figma|control|command] [--search text] [--json]",
    "Parameters: figma-relay describe <command-or-operation> [--json]",
    "Command help: figma-relay <command> --help or figma-relay help <command>",
    "Operation help: figma-relay control --job-type unity.projects.list --help", "",
    "Start with sessions to choose an online Figma target; disambiguate using --session-id or --file-key.",
    "Results are JSON on stdout; diagnostic logs are on stderr. Discovery defaults to text; use --json for automation.",
    "Authentication: FIGMA_RELAY_TOKEN or .local/admin-token.txt (FIGMA_RELAY_TOKEN_FILE overrides the path).",
    "Exit codes: 0 success, 1 connection/business failure, 2 usage error.",
    "Help and discovery work offline. Business commands do not start or stop Relay.",
    "After an uncertain write result, query the original task ID before resubmitting.", "",
  ].join("\n");
}
