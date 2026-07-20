# Relay-Owned Figma Cleanup Execution

## Goal

Make hierarchy cleanup reliable across Claude, Codex, and future providers. The
model understands the selected Figma hierarchy and returns a compact semantic
plan; the Relay validates and executes that plan. A model never performs, or is
expected to perform, a Figma write.

## Responsibility boundary

| Component | Owns | Must not own |
| --- | --- | --- |
| Figma plugin UI | Selection capture, chat display, progress, user feedback | Planning validation or Figma transaction policy |
| AI provider | Semantic grouping decision and natural-language explanation | Figma commands, Relay lifecycle, variants execution |
| Relay | Plan materialization, validation, transaction dispatch, post-check, logs | Semantic guessing after a valid plan exists |
| Figma plugin executor | Execute one Relay-approved transaction and return its result | Calling AI or interpreting a plan |

## Normal lifecycle

1. The user clicks AI cleanup. The plugin captures one authoritative snapshot
   of the selected root and sends it to Relay.
2. Relay starts the chosen provider with the snapshot. The provider writes only
   `cleanup-plan-decision.json` and explains its grouping decision.
3. Relay materializes `cleanup-plan-for-confirmation.json` from that decision
   and validates exact direct-child coverage, order, boundaries, and grouping
   rules. Invalid plans remain in analysis and are repaired by the provider.
4. A valid safe hierarchy plan is dispatched directly by Relay to the Figma
   cleanup transaction. This is a deterministic Relay action; no second AI
   turn is required for the hierarchy write.
5. Relay records the Figma transaction result, captures verification evidence,
   and reports the cleanup result in the same UI conversation.
6. Relay asks whether the user is satisfied. Adjustment feedback begins a new
   analysis cycle with a fresh snapshot. Only an explicit satisfied reply may
   dispatch the separately validated ComponentSet/variant transaction.

## Safety rules

- Safe hierarchy cleanup is limited to the selected root: create groups,
  reparent existing descendants, preserve sibling order, and create a backup.
- No deletion, recreation, cross-root move, ComponentSet, or variant operation
  is permitted during hierarchy cleanup.
- Duplicate PSD layer names are normal. Node ID, root-child order, type,
  geometry, and hierarchy are authoritative.
- A Figma mutation can only be sent after Relay validates the corresponding
  artifact. The result must be recorded against the owning `runId`.
- A failed transaction leaves the run in a retryable execution state with the
  validated artifact intact; it must not turn an otherwise valid conversation
  into an unrecoverable `failed` chat phase.

## State model

`analysis -> plan_validated -> hierarchy_executing -> awaiting_satisfaction -> variants_executing -> finished`

`analysis` accepts AI plan creation and repair. `plan_validated` is owned by
Relay and immediately schedules the hierarchy transaction. The only component
that enters `hierarchy_executing` is the Relay transaction dispatcher. The
write-evidence gate is checked after the transaction result, not when an AI
text response completes. Transaction failures return to `plan_validated` for
safe retry or to `analysis` for a revised plan.

## Out of scope

- Asking the AI to invoke Skill scripts, MCP write tools, service lifecycle
  commands, or local ports.
- A mandatory plan-confirmation dialog before safe hierarchy cleanup.
- Automatic ComponentSet or variant generation before the user says satisfied.

## Acceptance evidence

1. A provider creates a valid compact plan for a duplicate-name PSD snapshot.
2. Relay independently validates and dispatches the hierarchy transaction
   without a follow-up AI execution turn.
3. A successful transaction produces one recorded hierarchy write result and
   transitions to `awaiting_satisfaction`.
4. A failed transaction remains retryable and does not produce repeated HTTP
   fallback requests or `cleanup follow-up is not allowed in phase failed`.
5. Variants remain blocked until an explicit satisfied response.
