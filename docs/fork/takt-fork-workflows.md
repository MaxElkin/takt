# TAKT fork workflow extensions

Part of the [TAKT fork overview](takt-fork-spec.md).

## `requires_approval` — a human gate on a transition

A rule may carry `requires_approval: true`. Once the executor has chosen a
transition, TAKT asks whether it may be taken. `"y"` / `"yes"` lets it stand;
anything else goes back to the step as user input and the step runs again;
empty cancels.

The point is that **TAKT asks directly**. No agent stands between the answer
and the branch, so nothing reinterprets a `"y"` on its way to a decision.

A rejection is the opposite case and deliberately does tell the executor what
happened: `buildRejectionFeedback` names the transition that was declined, so
the executor knows the reply is about *where this goes next* rather than about
the work. Without that it reads the answer as ordinary feedback and re-picks
the same route.

Sites: `workflow-schemas.ts` (the rule schema is `.strict()`, so the field must
be declared), `workflowRuleNormalizer.ts`, `transitions.ts` (rule →
transition), and `src/core/workflow/engine/fork/transitionApproval.ts`, which
both transition paths in `WorkflowRunLoop.ts` call.
`validateUserInputRuntime` counts a mandatory approval rule as interactive, so
such a workflow refuses to start unattended rather than silently skipping the
gate. A rule marked `interactive_only` remains optional and is skipped during
a headless run, in line with the rule evaluator.

Known limit: the gate fires after rule resolution, so on a multi-rule step the
conductor may already have run before the user is asked, and a rejection can
waste that call.

## `user_prompt_field` — readable text for structured output

A step that routes on structured output still has to say something readable.
Without this, the prompt shows the whole reply, JSON and all, and the user has
to find the question inside it.

`humanFacingContent` (in `engine/fork/transitionApproval.ts`) takes `structuredOutput[field]`, defaulting the field name
to `message`, and falls back to `response.content` when it is absent or empty.
`structuredOutput` is only populated for a step that declared a schema, so the
default costs a plain prose step nothing. A step whose readable text lives
under another name declares `user_prompt_field`.

This is applied at all three prompting sites in `WorkflowRunLoop.ts` — both
`requires_user_input` paths and the approval gate.

## Interactive input derived from the workflow

`interactiveUserInput` used to default to `false` for queued tasks, which meant
a queued workflow containing a human gate could not clear it. It is now
derived in `src/features/tasks/execute/fork/humanGate.ts`, which
`workflowExecutionBootstrap.ts` calls through `resolveInteractiveChannels`:

```ts
interactiveUserInput: options.interactiveUserInput
  ?? (workflowDeclaresHumanGate(workflowConfig, options) && canPromptForUserInput()),
```

A caller with an opinion still wins — `selectAndExecute.ts` passes the option
through only when it is defined, rather than collapsing `undefined` to
`false`.

`workflowDeclaresHumanGate` walks the root workflow, parallel substeps, and
resolved `workflow_call` children. Active workflow references stop recursion
when calls form a cycle. It counts a step with `requires_user_input` or a
mandatory `requires_approval` rule. An approval marked `interactive_only` does
not count during bootstrap. **Rule-level `requires_user_input` deliberately
does not count**: builtin workflows pair it with `interactive_only` to mean
“ask if someone happens to be watching”, and treating that as a requirement
would make every builtin stop and wait during an unattended `takt run`.

This is the one change that is a default rather than an opt-in capability,
which makes it the most debatable of them.

## Related implementation notes

The terminal permission prompt is documented with the provider extensions in
the [providers spec](takt-fork-providers.md). Command-specific behavior is
documented in the [commands spec](takt-fork-commands.md).
