// The error for a call that needs a bot profile when there isn't one yet. Main throws it, the bridge carries its code
// across IPC, and the window shows the shared "finish setup" state instead of the message. Pure: imported by the
// main process, the preload's bridge and the renderer.

export const SETUP_INCOMPLETE = 'setup-incomplete';

/** What the error says where its code is lost (the CLI, a log). Never shown in the window. */
export const SETUP_INCOMPLETE_MESSAGE = 'Serra has no bot profile yet. Finish setup first.';

export class SetupIncomplete extends Error {
  readonly code = SETUP_INCOMPLETE;
  constructor() {
    super(SETUP_INCOMPLETE_MESSAGE);
    this.name = 'SetupIncomplete';
  }
}

/** True for a `SetupIncomplete`, including one rebuilt from IPC, where only the message is sure to survive. */
export const isSetupIncomplete = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'SetupIncomplete' || error.message === SETUP_INCOMPLETE_MESSAGE);
