# Figma Cleanup Plan Performance Design

## Goal

Reduce the initial hierarchy-cleanup PlanReview for a medium Figma selection from the observed 8-14 minute path to a predictable target of under 2 minutes, while keeping the initial turn read-only and preserving the existing explicit approval gate before any Figma mutation.

This design covers the agreed P0/P1/P2 scope only:

1. Capture one compact Figma hierarchy snapshot instead of letting the AI traverse nodes interactively.
2. Require a structured cleanup-plan payload instead of prose as the execution contract.
3. Use a compact PlanReview instruction set instead of loading the full cleanup skill during the initial turn.

Component creation policy, visual grouping rules, and the actual apply pipeline remain unchanged unless required to consume the structured plan.

## Architecture

### Compact hierarchy snapshot

The Figma plugin captures the selected root and its descendants in one read-only request before starting the local AI runner. The snapshot is bounded to the selected subtree and contains only fields needed for grouping decisions:

- node ID, parent ID, type, and current name;
- sibling index and depth;
- x, y, width, and height;
- visible and opacity;
- child count;
- text characters only when the node is text;
- image, nine-slice, component, and PSD-source role flags;
- hidden PSD source metadata needed to preserve incremental-update identity.

The snapshot must not contain image bytes, absolute machine-local paths, Figma access tokens, or unrelated pages. A hard node-count and serialized-size limit prevents oversized prompts. If the subtree exceeds the limit, PlanReview stops with a clear error instead of falling back to interactive traversal.

### Structured plan contract

The PlanReview AI returns exactly one marked JSON payload:

```json
{
  "schemaVersion": 1,
  "rootNodeId": "7114:831",
  "groups": [
    {
      "name": "TopHUD",
      "parentNodeId": "7114:831",
      "sourceNodeIds": ["7114:832", "7114:833"],
      "preserveSiblingOrder": true
    }
  ],
  "componentCandidates": [],
  "warnings": []
}
```

The gateway extracts and validates this payload before presenting it to the UI. Validation requires:

- the root ID matches the captured target;
- every referenced node belongs to the snapshot;
- a node appears in at most one proposed group;
- source-node order matches the original relative sibling order;
- no apply command or mutation result is embedded in the initial response;
- unknown fields are ignored for display but never forwarded as execution authority.

Invalid or missing structured output marks PlanReview as failed and terminates the runner. It does not attempt to repair the plan by starting another autonomous AI turn.

### Compact PlanReview instructions

The initial turn receives a dedicated compact instruction block plus the snapshot and JSON schema. It does not load the full 64KB cleanup skill. The compact block contains only:

- read-only and approval boundaries;
- grouping invariants;
- sibling-order and absolute-position preservation;
- PSD SharedPluginData preservation;
- ComponentSet candidate reporting rules;
- the required JSON output shape;
- the 3-minute target and the prohibition on subagents and interactive tree traversal.

The full cleanup/apply skill remains available only after explicit approval, when the validated structured plan is supplied to the follow-up turn.

## Data Flow

1. User selects exactly one supported Figma root and clicks automatic cleanup.
2. The plugin captures one compact subtree snapshot.
3. The UI sends the snapshot to `/ai-runner/run-cleanup`.
4. The gateway writes a compact PlanReview task containing the snapshot and plan schema.
5. The AI returns a marked structured plan and ends its turn.
6. The gateway validates the plan, stores it under the existing run directory, and exposes a summarized preview.
7. The UI shows `等待确认`; no Figma write has occurred.
8. After explicit user approval, the follow-up turn receives the validated plan and the full apply rules.
9. The deterministic cleanup pipeline applies, verifies, and reports the result.

## Lifecycle and Time Limits

- A Claude `result` event is terminal for the current turn.
- Initial cleanup PlanReview has a 5-minute hard limit and a 90-second no-output limit.
- The target is under 3 minutes; the hard limit is a failure boundary, not a normal duration.
- Failure, invalid plan JSON, timeout, cancellation, or plugin disconnect terminates the entire child-process tree.
- The initial turn can end only as `completed/awaiting-approval`, `failed`, or `cancelled`.
- Apply cannot start from `failed` or `cancelled` and cannot start without an explicit follow-up approval.

## UI

The execution panel reports distinct phases:

1. Capturing hierarchy snapshot.
2. Generating structured plan.
3. Validating plan.
4. Waiting for approval.
5. Applying and verifying after approval.

The plan preview renders group names, source-node counts, ComponentSet candidates, and warnings from validated JSON. Raw AI logs remain available for diagnostics but are not the primary status surface.

## Error Handling

- Snapshot too large: stop before starting AI and report node/byte limits.
- Unknown or duplicate node ID: reject the plan without writes.
- Missing structured marker or malformed JSON: fail PlanReview and terminate the runner.
- AI attempts a write during PlanReview: reject the task and terminate the runner.
- Timeout or stream error: terminate the runner and show the last completed phase.
- Apply validation failure: rollback through the existing deterministic pipeline and retain the validated plan for diagnosis.

## Testing

Automated coverage must prove:

- compact snapshots include descendants once, preserve sibling order, and omit heavy/sensitive fields;
- snapshot node and byte limits block before AI launch;
- structured plan extraction accepts one valid marked payload and rejects malformed, missing, duplicate, foreign-node, and order-changing plans;
- cleanup task construction does not reference the full cleanup `SKILL.md` during PlanReview;
- PlanReview instructions prohibit writes, subagents, and interactive traversal;
- Claude terminal events, timeouts, cancellation, and disconnect all end the process tree;
- the UI distinguishes capture, plan, validation, waiting, apply, and failure states;
- existing PSD incremental metadata remains attached to original nodes after approved grouping.

A live verification uses a disposable 50-100 node Figma subtree. It records snapshot time, AI plan time, validation time, and confirms that no Figma mutation occurs before approval.

## Success Criteria

- One snapshot request replaces per-node AI traversal.
- The initial AI response contains one validated plan JSON payload.
- The initial turn never loads the full cleanup skill or starts a subagent.
- No Figma mutation occurs before explicit approval.
- A 50-100 node PlanReview normally finishes within 2 minutes and always terminates by the configured hard limit.
- Existing cleanup correctness checks and PSD incremental metadata preservation remain intact.
