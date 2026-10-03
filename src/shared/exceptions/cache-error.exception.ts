import { HttpException, HttpStatus } from '@nestjs/common';

export class CacheErrorException extends HttpException {
  constructor(message: string, key?: string) {
    super(
      {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: `Cache Error: ${message}`,
        key,
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
