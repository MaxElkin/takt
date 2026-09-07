/**
 * Confirmation and text input prompts.
 *
 * Provides yes/no confirmation, single-line text input,
 * and multiline text input from readable streams.
 */

import * as readline from 'node:readline';
import chalk from 'chalk';
import { resolveTtyPolicy, assertTtyIfForced } from './tty.js';
import { statusLine } from '../ui/StatusLine.js';

function pauseStdinSafely(): void {
  try {
    if (process.stdin.readable && !process.stdin.destroyed) {
      process.stdin.pause();
    }
  } catch {
    return;
  }
}

/**
 * Prompt user for simple text input
 * @returns User input or null if cancelled
 */
export async function promptInput(message: string): Promise<string | null> {
  statusLine.suspend();
  try {
    const { useTty, forceTouchTty } = resolveTtyPolicy();
    assertTtyIfForced(forceTouchTty);
    if (!useTty) {
      return null;
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const result = await new Promise<string | null>((resolve) => {
      rl.question(chalk.green(message + ': '), (answer) => {
        rl.close();
        pauseStdinSafely();

        const trimmed = answer.trim();
        if (!trimmed) {
          resolve(null);
          return;
        }

        resolve(trimmed);
      });
    });
    return result;
  } finally {
    statusLine.resume();
  }
}

/**
 * Read multiline input from a readable stream.
 * An empty line finishes input. If the first line is empty, returns null.
 * Exported for testing.
 */
export async function readMultilineFromStream(input: NodeJS.ReadableStream): Promise<string | null> {
  statusLine.suspend();
  try {
    const lines: string[] = [];
    const rl = readline.createInterface({ input });

    const result = await new Promise<string | null>((resolve) => {
      let resolved = false;

      rl.on('line', (line) => {
        if (line === '' && lines.length > 0) {
          resolved = true;
          rl.close();
          const result = lines.join('\n').trim();
          resolve(result || null);
          return;
        }

        if (line === '' && lines.length === 0) {
          resolved = true;
          rl.close();
          resolve(null);
          return;
        }

        lines.push(line);
      });

      rl.on('close', () => {
        if (!resolved) {
          resolve(lines.length > 0 ? lines.join('\n').trim() : null);
        }
      });
    });
    return result;
  } finally {
    statusLine.resume();
  }
}

/**
 * Prompt user for yes/no confirmation
 * @returns true for yes, false for no
 */
export async function confirm(message: string, defaultYes = true): Promise<boolean> {
  statusLine.suspend();
  try {
    const { useTty, forceTouchTty } = resolveTtyPolicy();
    assertTtyIfForced(forceTouchTty);
    if (!useTty) {
      // Support piped stdin (e.g. echo "y" | takt repertoire add ...)
      // Once the pipe queue is initialized, stdin may be destroyed but queued lines remain.
      if (canReadPipedStdin()) {
        return await readConfirmFromPipe(defaultYes);
      }
      return defaultYes;
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const hint = defaultYes ? '[Y/n]' : '[y/N]';

    const result = await new Promise<boolean>((resolve) => {
      rl.question(chalk.green(`${message} ${hint}: `), (answer) => {
        rl.close();
        pauseStdinSafely();

        const trimmed = answer.trim().toLowerCase();

        if (!trimmed) {
          resolve(defaultYes);
          return;
        }

        resolve(trimmed === 'y' || trimmed === 'yes');
      });
    });
    return result;
  } finally {
    statusLine.resume();
  }
}

/**
 * Shared stdin line reader for non-TTY runs.
 *
 * `readline.createInterface` buffers stdin internally, so creating one per
 * prompt loses lines the previous interface had already read. One interface is
 * kept for the process and its lines are served in order.
 *
 * Lines are handed out as they arrive rather than after stdin closes: a driver
 * that keeps the pipe open to answer several prompts in turn — an agent running
 * `takt` and replying to what it asks — would otherwise wait forever for an EOF
 * that never comes.
 */
let pipeReader: {
  buffered: string[];
  waiting: PipeLineWaiter[];
  closed: boolean;
} | null = null;

interface PipeLineWaiter {
  resolve: (line: string | null) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

function resolvePipeWaiter(waiter: PipeLineWaiter, line: string | null): void {
  if (waiter.signal !== undefined && waiter.abortHandler !== undefined) {
    waiter.signal.removeEventListener('abort', waiter.abortHandler);
  }
  waiter.resolve(line);
}

/** True once stdin is being read, even if it has since closed. */
export function isPipeReaderStarted(): boolean {
  return pipeReader !== null;
}

function ensurePipeReader(): NonNullable<typeof pipeReader> {
  if (pipeReader) return pipeReader;

  const state = { buffered: [] as string[], waiting: [] as PipeLineWaiter[], closed: false };
  pipeReader = state;

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const next = state.waiting.shift();
    if (next) resolvePipeWaiter(next, line);
    else state.buffered.push(line);
  });
  rl.on('close', () => {
    state.closed = true;
    while (state.waiting.length > 0) resolvePipeWaiter(state.waiting.shift()!, null);
  });

  return state;
}

/** The next line from piped stdin, or null once it is exhausted. */
export async function readPipedLine(signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted === true) return null;
  const state = ensurePipeReader();
  const buffered = state.buffered.shift();
  if (buffered !== undefined) return buffered;
  if (state.closed) return null;
  return new Promise<string | null>((resolve) => {
    const waiter: PipeLineWaiter = { resolve, signal };
    if (signal !== undefined) {
      waiter.abortHandler = () => {
        const index = state.waiting.indexOf(waiter);
        if (index !== -1) state.waiting.splice(index, 1);
        resolvePipeWaiter(waiter, null);
      };
      signal.addEventListener('abort', waiter.abortHandler, { once: true });
    }
    state.waiting.push(waiter);
    if (signal?.aborted === true) waiter.abortHandler?.();
  });
}

/**
 * Prompt for a single line, from a terminal or from piped stdin.
 *
 * Unlike `promptInput`, which gives up without a TTY, this is answerable by a
 * process driving `takt` through a pipe.
 */
export async function promptLine(message: string, signal?: AbortSignal): Promise<string | null> {
  statusLine.suspend();
  try {
    if (signal?.aborted === true) return null;
    const { useTty, forceTouchTty } = resolveTtyPolicy();
    assertTtyIfForced(forceTouchTty);
    if (!useTty) {
      if (canReadPipedStdin()) {
        console.log(chalk.green(`${message}: `));
        return await readPipedLine(signal);
      }
      return null;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abortHandler);
        rl.close();
        pauseStdinSafely();
        resolve(value);
      };
      const abortHandler = (): void => { finish(null); };
      signal?.addEventListener('abort', abortHandler, { once: true });
      rl.question(chalk.green(`${message}: `), (value) => { finish(value); });
      if (signal?.aborted === true) abortHandler();
    });
    if (answer === null) return null;
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : null;
  } finally {
    statusLine.resume();
  }
}

/** Whether stdin can still supply answers when there is no terminal. */
export function canReadPipedStdin(): boolean {
  return isPipeReaderStarted()
    || (!process.stdin.isTTY && process.stdin.readable && !process.stdin.destroyed);
}

async function readConfirmFromPipe(defaultYes: boolean): Promise<boolean> {
  const line = await readPipedLine();
  if (line === null) {
    return defaultYes;
  }
  const trimmed = line.trim().toLowerCase();
  if (!trimmed) {
    return defaultYes;
  }
  return trimmed === 'y' || trimmed === 'yes';
}
