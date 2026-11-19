/**
 * Errors that are safe to show to the caller.
 *
 * Anything thrown that is NOT an AppError is treated as an internal fault:
 * the client receives a generic 500 and the detail goes to the server log.
 */
export class AppError extends Error {
  constructor(message, status = 400, extra = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (message, extra) => new AppError(message, 400, extra);
export const unauthorized = (message = 'Sign in required') => new AppError(message, 401);
export const forbidden = (message = 'You do not have permission to do that') => new AppError(message, 403);
export const notFound = (message = 'Not found') => new AppError(message, 404);
export const conflict = (message, extra) => new AppError(message, 409, extra);
export const tooMany = (message = 'Too many requests. Please wait a minute and try again.') => new AppError(message, 429);
