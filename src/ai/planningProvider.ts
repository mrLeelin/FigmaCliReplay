export type PlanningProviderId = "codex" | "claude-code";

export interface ProviderAvailability {
  id: PlanningProviderId;
  label: string;
  available: boolean;
  version?: string;
  reason?: string;
}

export interface PlanningProvider {
  readonly id: PlanningProviderId;
  readonly label: string;
  readonly command: string;
  buildArgs(workspace: string, prompt: string): string[];
  extractAssistantText(event: unknown): string;
  isTerminalEvent(event: unknown): "completed" | "failed" | null;
}

