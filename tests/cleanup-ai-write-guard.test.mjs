import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCleanupAiPhaseWriteEvidence,
  assertCleanupAiJobAllowed,
  beginCleanupAiWriteGuard,
  cleanupAiWriteEvidence,
  endCleanupAiWriteGuard,
  recordCleanupAiJobResult,
  setCleanupAiWritePhase,
} from "../dist/cleanupAiWriteGuard.js";

test("cleanup AI write guard enforces read, hierarchy, satisfaction, and variant phases", () => {
  const sessionId = "figma-session-guard-test";
  const runId = "cleanup-run-guard-test";
  beginCleanupAiWriteGuard(sessionId, runId);

  assert.doesNotThrow(() => assertCleanupAiJobAllowed("QUERY_SELECTION", sessionId));
  assert.throws(
    () => assertCleanupAiJobAllowed("FIGMA_HIERARCHY_CLEANUP_TRANSACTION", sessionId),
    /read-only|只读/i,
  );
  assert.throws(
    () => assertCleanupAiJobAllowed("FIGMA_HIERARCHY_CLEANUP_TRANSACTION", "stale-or-other-session"),
    /outside|target|会话/i,
  );

  setCleanupAiWritePhase(sessionId, runId, "hierarchy");
  assert.doesNotThrow(() => assertCleanupAiJobAllowed("FIGMA_HIERARCHY_CLEANUP_TRANSACTION", sessionId));
  assert.throws(
    () => assertCleanupAiJobAllowed("FIGMA_CREATE_COMPONENT_SET_VARIANTS", sessionId),
    /hierarchy|层级/i,
  );

  setCleanupAiWritePhase(sessionId, runId, "awaiting_satisfaction");
  assert.throws(
    () => assertCleanupAiJobAllowed("FIGMA_HIERARCHY_REORDER_CHILDREN", sessionId),
    /satisfaction|满意/i,
  );

  setCleanupAiWritePhase(sessionId, runId, "variants");
  assert.doesNotThrow(() => assertCleanupAiJobAllowed("FIGMA_CREATE_COMPONENT_SET_VARIANTS", sessionId));
  assert.throws(
    () => assertCleanupAiJobAllowed("DELETE_NODE_BY_ID", sessionId),
    /variant|变体/i,
  );

  endCleanupAiWriteGuard(sessionId, runId);
});

test("cleanup AI phase advancement requires a successful Figma mutation in the current write phase", () => {
  const sessionId = "figma-session-write-evidence";
  const runId = "cleanup-run-write-evidence";
  beginCleanupAiWriteGuard(sessionId, runId);

  setCleanupAiWritePhase(sessionId, runId, "hierarchy");
  assert.throws(
    () => assertCleanupAiPhaseWriteEvidence(sessionId, runId, "hierarchy"),
    /successful|write|写入|证据/i,
  );

  recordCleanupAiJobResult("FIGMA_HIERARCHY_CLEANUP_TRANSACTION", sessionId, false, "failed-hierarchy-job");
  assert.equal(cleanupAiWriteEvidence(sessionId, runId)?.successfulWrites, 0);
  assert.equal(cleanupAiWriteEvidence(sessionId, runId)?.failedWrites, 1);
  assert.throws(
    () => assertCleanupAiPhaseWriteEvidence(sessionId, runId, "hierarchy"),
    /successful|write|写入|证据/i,
  );

  recordCleanupAiJobResult("FIGMA_HIERARCHY_CLEANUP_TRANSACTION", sessionId, true, "successful-hierarchy-job");
  assert.equal(cleanupAiWriteEvidence(sessionId, runId)?.successfulWrites, 1);
  assert.doesNotThrow(() => assertCleanupAiPhaseWriteEvidence(sessionId, runId, "hierarchy"));

  setCleanupAiWritePhase(sessionId, runId, "awaiting_satisfaction");
  setCleanupAiWritePhase(sessionId, runId, "variants");
  assert.equal(cleanupAiWriteEvidence(sessionId, runId)?.successfulWrites, 0);
  assert.throws(
    () => assertCleanupAiPhaseWriteEvidence(sessionId, runId, "variants"),
    /successful|write|写入|证据/i,
  );
  recordCleanupAiJobResult("FIGMA_CREATE_COMPONENT_SET_VARIANTS", sessionId, true, "successful-variant-job");
  assert.doesNotThrow(() => assertCleanupAiPhaseWriteEvidence(sessionId, runId, "variants"));

  endCleanupAiWriteGuard(sessionId, runId);
});
