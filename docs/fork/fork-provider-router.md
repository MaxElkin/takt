# Fork provider router for TAKT auto routing

Status: **proposal**, nothing implemented. Written 2026-09-07 against TAKT
0.64.1.

Would land in the [provider extensions spec](takt-fork-providers.md) within the
fork; nothing here is built yet.

## Why it exists

TAKT can pick a provider per step, but only by asking a model. `auto_routing`
declares candidates carrying a `routing_tier` of `low` / `medium` / `high`, and
before each agent step a *router model* reads a snapshot of the work and
answers with the tier it thinks the step requires. That is the only automatic
input to the choice.

Some of the inputs that should drive the choice are not in the work at all.
Remaining quota on a plan is the clear one: whether Codex has an hour of budget
left is a fact a local command knows and a language model cannot. Today the
only way to act on it is a wrapper script that exports `TAKT_PROVIDER` /
`TAKT_MODEL` before launching `takt`, which decides once for the whole run and,
because environment overrides sit at priority 1, silently disables
`provider_routing` for every step in it.

This proposes letting `auto_routing.router` be a **command** instead of a
model.

## Why it is small

The estimator is already an interface with one method, and it is already
injectable — the engine takes `autoRoutingEstimator` as an option and only
falls back to building the model-backed one:

```ts
// src/core/workflow/auto-routing/contracts.ts
export interface WorkRequirementEstimator {
  estimate(input: RoutingModelInput, options?: {
    abortSignal?: AbortSignal;
    onStream?: StreamCallback;
    onActivity?: ProviderActivityCallback;
  }): Promise<WorkRequirementEstimate>;
}

export interface WorkRequirementEstimate {
  requiredTier: RoutingTier;
  reasonCodes: string[];
  confidence?: number;
}
```

`RoutingRuntime` consumes that interface and nothing else about the router
(`auto-routing/runtime.ts:25`). So a second implementation changes no
selection logic: pools, `strategy`, the estimate cache, escalation on retry,
the estimator-failure fallback and the telemetry all keep working unchanged.

Two construction sites build the model-backed estimator today, both from
`router.provider` / `router.model`:

| Site | Line |
| --- | --- |
| `src/core/workflow/engine/WorkflowEngine.ts` | 195 |
| `src/core/workflow/engine/WorkflowCallExecutor.ts` | 211 |

## Config surface

`router` becomes a union. The model form is unchanged:

```yaml
auto_routing:
  strategy: cost
  router:
    provider: codex
    model: gpt-5.6-luna
```

The new form names a command:

```yaml
auto_routing:
  strategy: cost
  router:
    command: ./scripts/route-by-quota.sh
```

Schema change is one union member on `AutoRoutingSchemaBase.router`
(`src/core/models/schema-base.ts:310`), with a refinement rejecting a router
that sets both shapes.

## Command contract

The command is spawned with the project as its working directory. The routing
snapshot is written to **stdin as JSON** — the same `RoutingModelInput` the
model router receives, already normalised and redacted by
`normalizeRoutingWorkSnapshot`:

```json
{
  "version": "…",
  "goal": "…",
  "step": { "name": "ask", "tags": [], "stepType": "normal", "edit": true },
  "remainingWork": [{ "source": "task", "description": "…" }],
  "progress": { "previousAttemptFailed": false, "noProgress": false, "retryingSameWork": false }
}
```

It answers on **stdout** with the same object the model's structured output
schema already defines (`src/agents/auto-routing-usecase.ts:15`):

```json
{ "required_tier": "medium", "reason_codes": ["complex-work"], "confidence": null }
```

`reason_codes` is validated against the closed set in
`ROUTING_REASON_CODE_VALUES` — `api-change`, `complex-work`, `focused-change`,
`formatting`, `initial-complexity`, `local-change` — at most four of them
(`validateRoutingReasonCodes`, `contracts.ts:60`). A quota-driven router has no
honest code in that list, so either the set gains one (`budget-constrained` is
the obvious name) or the field is allowed to be empty for command routers.
**This is the one open design question.** Reason codes are not decorative; they
reach analytics through `analyticsEmitter.ts`.

A non-zero exit, unparseable stdout, or a tier outside the enum is an
**estimator failure**, which is an outcome `RoutingRuntime` already handles: it
falls back to the pool's declared `fallback` candidate and records
`fallbackReason: 'estimator-failure'` (`runtime.ts:122`). Nothing new needs
inventing for the error path.

Timeout matches the model router's 30s (`WORK_REQUIREMENT_ESTIMATOR_TIMEOUT_MS`),
and the same abort signal must kill the child.

## What this does not change

- **The command does not pick a provider.** It answers with a tier; the pool
  and `strategy` still choose the candidate. A router that wants to say "not
  Codex, it is out of budget" has to express that as a tier, which it can only
  do if the pool is arranged so tiers and providers line up. Letting the
  command name a candidate directly is a larger change and is deliberately out
  of scope here.
- **Call frequency.** The estimate cache is keyed on the work fingerprint plus
  a digest of the model input (`runtime.ts:39`), so the command runs once per
  distinct piece of work, not once per step. Quota moves during a run and a
  cached answer will go stale; whether that matters is worth measuring before
  adding a cache bypass.
- **`provider_routing` still wins.** It resolves at priority 5, auto routing at
  7. A step pinned by tag never reaches the router at all.

## Security note

The command runs with the user's own privileges and receives the task text on
stdin. It is configured in the project's checked-in
`.takt/config.yaml`, so this is a code-execution surface
that arrives through a pull request. TAKT
already gates comparable surfaces behind explicit opt-in flags —
`workflow_runtime_prepare.custom_scripts`, `workflow_command_gates.custom_scripts`,
`workflow_arpeggio.custom_merge_inline_js` — and a command router belongs
behind the same kind of switch rather than being enabled by its presence alone.

## Work

1. Schema union + refinement on `auto_routing.router`, and the normaliser in
   `configNormalizers.ts` (which currently validates `router.model` as a full
   model id at line 157).
2. `createCommandWorkRequirementEstimator` beside the model one, spawning the
   command, writing stdin, parsing stdout, honouring the timeout and abort.
3. Wire both construction sites to choose by router shape.
4. Decide the `reason_codes` question above.
5. Opt-in config flag, matching the existing custom-script gates.
6. `autoRoutingEstimatorSource` gains a value — it is currently
   `'injected' | 'absent' | 'engine-default'` (`WorkflowEngine.ts:186`) and
   feeds telemetry.
7. Tests. The estimator is pure enough to test against a fixture script; the
   error path deserves one case per failure shape, since all of them funnel
   into the same fallback and would otherwise be indistinguishable.

## Estimating note

Items 1 through 3 are the actual feature and are small — one file, one schema
union, two call sites. Items 4 through 7 are most of the work, which is the
usual shape: the seam is cheap because someone already built it, and the cost
is in the contract around it.
