/**
 * Fork: the task prompt a run opens with, chosen by whether there is a spec.
 *
 * Upstream's prompt is unconditional and phrased as a scope constraint -
 * "using **only** the files in ...", "**Primary** spec: order.md" - and it
 * lands in the prompt under `## User Request`, above the step's own
 * instruction under `## Work`. A model reads that as the authority, so a
 * task whose order.md holds nothing usable (`takt task add --name kek` used
 * to write the name) drags every step back to interrogating the spec file
 * instead of doing what the workflow authored.
 *
 * An empty order is therefore not an empty request - it is the absence of
 * one, and it hands precedence to the workflow.
 */

/** Order content that carries no instruction: absent, blank, whitespace. */
export function isBlankTaskOrder(orderContent: string): boolean {
  return orderContent.trim().length === 0;
}

export function buildBlankOrderTaskInstruction(): string {
  return [
    'No task specification was supplied for this run.',
    'The workflow step instructions below define the work in full; there is no spec file to consult and nothing to implement from one.',
    'Use report files in Report Directory as primary execution history.',
  ].join('\n');
}
