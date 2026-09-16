import { describe, it, expect } from 'vitest';

import { phasePromptFields } from '../features/tasks/execute/fork/phasePromptFields.js';

const identity = (text: string): string => text;

describe('phasePromptFields (fork)', () => {
  it('omits instruction when it is what was dispatched', () => {
    const fields = phasePromptFields(
      'built instruction',
      { systemPrompt: 'persona', userInstruction: 'built instruction' },
      identity,
    );

    expect(fields).toEqual({ systemPrompt: 'persona', userInstruction: 'built instruction' });
    expect('instruction' in fields).toBe(false);
  });

  it('keeps instruction when the dispatched prompt differs', () => {
    const fields = phasePromptFields(
      'built instruction',
      { systemPrompt: 'persona', userInstruction: 'report phase prompt' },
      identity,
    );

    expect(fields).toEqual({
      instruction: 'built instruction',
      systemPrompt: 'persona',
      userInstruction: 'report phase prompt',
    });
  });

  it('omits an empty system prompt, as a step without a persona resolves', () => {
    const fields = phasePromptFields(
      'built instruction',
      { systemPrompt: '', userInstruction: 'built instruction' },
      identity,
    );

    expect(fields).toEqual({ userInstruction: 'built instruction' });
  });

  it('compares the sanitized texts, not the raw ones', () => {
    const mask = (text: string): string => text.replace(/secret-\w+/g, '•••');
    const fields = phasePromptFields(
      'token secret-aaa',
      { systemPrompt: '', userInstruction: 'token secret-bbb' },
      mask,
    );

    expect(fields).toEqual({ userInstruction: 'token •••' });
  });
});
