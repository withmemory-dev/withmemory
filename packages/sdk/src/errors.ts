export class WithMemoryError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "WithMemoryError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
