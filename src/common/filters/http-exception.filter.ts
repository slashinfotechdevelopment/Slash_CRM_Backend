import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { ApiResponse } from '../interfaces/api-response.interface';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'An unexpected error occurred. Please try again later.';
    let errors: any[] = [];

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, any>;
        message = resObj.message || exception.message;

        if (Array.isArray(resObj.message)) {
          // Typically class-validator messages
          errors = resObj.message;
          message = 'Validation failed';
        } else if (resObj.errors && Array.isArray(resObj.errors)) {
          errors = resObj.errors;
        }
      }
    } else if ((exception as any)?.name === 'MulterError') {
      const multerErr = exception as any;
      if (multerErr.code === 'LIMIT_FILE_SIZE') {
        status = HttpStatus.PAYLOAD_TOO_LARGE;
        message = 'File size exceeds the 25 MB limit.';
      } else {
        status = HttpStatus.BAD_REQUEST;
        message = multerErr.message || 'File upload error';
      }
    } else {
      // Unhandled runtime or database exception
      this.logger.error(
        `Unhandled exception on ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
      // Keep internal error details away from client
      message = 'Internal server error';
    }

    const payload: ApiResponse = {
      success: false,
      message,
      errors: errors.length > 0 ? errors : undefined,
    };

    response.status(status).json(payload);
  }
}

