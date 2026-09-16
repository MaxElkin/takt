/**
 * Fork: reading the result passed to `takt task instruction --complete`.
 *
 * A finished step's response is routinely larger than a shell argument wants
 * to be, so the value is taken three ways: inline, `-` for stdin, or `@path`
 * for a file. The two indirections are spelled with sigils rather than guessed
 * at, since a result that happens to read like a filename must not be mistaken
 * for one.
 */

import * as fs from 'node:fs';
import { error } from '../../../shared/ui/index.js';
import { getErrorMessage } from '../../../shared/utils/error.js';
import { sanitizeTerminalText } from '../../../shared/utils/index.js';

/** Returns undefined when the result could not be read; the reason is printed. */
export function readCompletionResult(value: string): string | undefined {
  try {
    if (value === '-') {
      return fs.readFileSync(0, 'utf-8');
    }
    if (value.startsWith('@')) {
      return fs.readFileSync(value.slice(1), 'utf-8');
    }
    return value;
  } catch (err) {
    error(`Could not read the result: ${sanitizeTerminalText(getErrorMessage(err))}`);
    process.exitCode = 1;
    return undefined;
  }
}
