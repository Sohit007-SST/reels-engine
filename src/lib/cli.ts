/** Small CLI helpers shared by entry points. */
import { createLogger } from './logger';
import { serializeError } from './redact';

/** Exit code used by stub commands whose module is not built yet. */
export const EXIT_NOT_IMPLEMENTED = 2;

/** Print a friendly "not implemented yet" message and exit with code 2. */
export function notImplemented(command: string, owner: string, task?: string): never {
  process.stderr.write(
    `"${command}" is not implemented yet (module owner: ${owner}${task ? `, task ${task}` : ''}). See progress/PROGRESS.md.\n`,
  );
  process.exit(EXIT_NOT_IMPLEMENTED);
}

/** Wrap a CLI main(): logs sanitized errors and sets the exit code. */
export function runMain(name: string, main: () => Promise<number | void>): void {
  const logger = createLogger({ stage: name });
  main()
    .then((code) => {
      process.exitCode = typeof code === 'number' ? code : 0;
    })
    .catch((err: unknown) => {
      logger.error(`${name} failed`, { err });
      process.stderr.write(`${name} failed: ${serializeError(err).message}\n`);
      process.exitCode = 1;
    });
}

/** Error thrown by every interface stub until its builder implements it. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`not implemented: ${what}`);
    this.name = 'NotImplementedError';
  }
}
