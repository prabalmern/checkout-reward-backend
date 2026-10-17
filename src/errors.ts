export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  notFound: (code: string, message: string, details?: unknown) =>
    new AppError(404, code, message, details),
  conflict: (code: string, message: string, details?: unknown) =>
    new AppError(409, code, message, details),
  badRequest: (code: string, message: string, details?: unknown) =>
    new AppError(400, code, message, details),
};
