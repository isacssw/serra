/** An error's message, or the thrown value as text: what logs and events record. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
