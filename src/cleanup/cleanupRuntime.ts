import { CliPlanningTransport } from "../ai/cliPlanningTransport.js";
import { createPlanningProviderRegistry, type PlanningProviderRegistry } from "../ai/providerRegistry.js";
import { PLUGIN_ROOT } from "../config.js";
import { createCleanupController, type CleanupController } from "./cleanupController.js";
import { CleanupExecutor } from "./cleanupExecutor.js";
import { CleanupPlanner } from "./cleanupPlanner.js";

export interface CleanupRuntime {
  providers: PlanningProviderRegistry;
  controller: CleanupController;
}

let defaultRuntime: CleanupRuntime | undefined;

export function getCleanupRuntime(): CleanupRuntime {
  if (defaultRuntime) return defaultRuntime;
  const providers = createPlanningProviderRegistry();
  const planner = new CleanupPlanner(providers, new CliPlanningTransport({ workspace: PLUGIN_ROOT }));
  defaultRuntime = {
    providers,
    controller: createCleanupController({ planner, executor: new CleanupExecutor() }),
  };
  return defaultRuntime;
}
