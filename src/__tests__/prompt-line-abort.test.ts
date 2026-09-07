import { describe, expect, it } from 'vitest';
import { promptLine } from '../shared/prompt/confirm.js';

describe('promptLine abort handling', () => {
  it('returns without opening a reader when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(promptLine('Permission?', controller.signal)).resolves.toBeNull();
  });
});
