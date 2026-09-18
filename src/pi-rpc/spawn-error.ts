export class PiRpcSpawnError extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code?: string;

  constructor(message: string, options?: { code?: string; cause?: unknown }) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "PiRpcSpawnError";
    this.code = options?.code;
  }
}
