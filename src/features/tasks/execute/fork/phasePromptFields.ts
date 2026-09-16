import type { PhasePromptParts } from '../../../../core/workflow/types.js';

type SanitizeText = (text: string) => string;

/**
 * A `phase_start` record carried the step's prompt three times: `instruction`
 * (what `InstructionBuilder` composed), `userInstruction` (what the provider
 * was actually called with) and `systemPrompt`. For a plain agent phase the
 * first two are the same string, and a step declaring no persona resolves an
 * empty system prompt, so a ~4.5 KB instruction was stored twice per phase
 * alongside a field holding nothing.
 *
 * Only the fields that carry information are written now. Nothing downstream
 * loses anything: `traceReportParser` reads
 * `instruction ?? userInstruction ?? prompt?.userInstruction` (and the mirror
 * of that for `userInstruction`), and the NDJSON validator in
 * `infra/fs/session.ts` requires none of the three on a phase record.
 *
 * `instruction` is kept whenever it differs from what was dispatched - the
 * report and judge phases build their own prompt, empty-response recovery
 * retries with a modified one, and the team-leader and arpeggio runners
 * synthesize sub-step prompts. Those are the cases the two fields exist to
 * tell apart.
 */
export function phasePromptFields(
  instruction: string,
  promptParts: PhasePromptParts,
  sanitizeText: SanitizeText,
): Pick<
  { instruction: string; systemPrompt: string; userInstruction: string },
  'userInstruction'
> & { instruction?: string; systemPrompt?: string } {
  const sanitizedInstruction = sanitizeText(instruction);
  const userInstruction = sanitizeText(promptParts.userInstruction);
  const systemPrompt = sanitizeText(promptParts.systemPrompt);
  return {
    ...(sanitizedInstruction === userInstruction ? {} : { instruction: sanitizedInstruction }),
    ...(systemPrompt === '' ? {} : { systemPrompt }),
    userInstruction,
  };
}
