export abstract class BaseError extends Error {
  public readonly errorCode: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    errorCode: string,
    statusCode: number = 500,
    isOperational: boolean = true,
  ) {
    super(message);
    this.errorCode = errorCode;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      errorCode: this.errorCode,
      message: this.message,
      statusCode: this.statusCode,
      timestamp: new Date().toISOString(),
    };
  }
}
