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

/**
 * Sanitizes technical database identifiers (CUIDs, UUIDs) and formats friendly messages for non-technical users.
 */
function humanizeErrorMessage(msg: string): string {
  if (!msg || typeof msg !== 'string') return msg;

  let cleaned = msg;

  // Replace technical "with ID 'cmw...'" or "with ID 'uuid...'" phrases
  cleaned = cleaned.replace(/with ID\s+['"][a-zA-Z0-9_-]{20,40}['"]/gi, '');
  cleaned = cleaned.replace(/with ID\s+['"][0-9a-fA-F-]{36}['"]/gi, '');

  // Strip standalone CUID / UUID tokens from prose
  cleaned = cleaned.replace(/\bcmw[a-z0-9]{20,30}\b/gi, 'specified record');
  cleaned = cleaned.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    'specified record',
  );

  // Clean double spaces and awkward punctuation
  cleaned = cleaned.replace(/\s{2,}/g, ' ').replace(/\s+([.,!])/g, '$1').trim();

  return cleaned;
}

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
        message = humanizeErrorMessage(res);
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, any>;
        const rawMsg = resObj.message || exception.message;

        if (Array.isArray(resObj.message)) {
          // Class-validator messages
          errors = resObj.message.map((e: any) =>
            typeof e === 'string' ? humanizeErrorMessage(e) : e,
          );
          message = 'Validation failed. Please verify the submitted information.';
        } else if (resObj.errors && Array.isArray(resObj.errors)) {
          errors = resObj.errors.map((e: any) =>
            typeof e === 'string' ? humanizeErrorMessage(e) : e,
          );
          message = humanizeErrorMessage(rawMsg);
        } else {
          message = humanizeErrorMessage(String(rawMsg));
        }
      }
    } else if ((exception as any)?.name === 'MulterError') {
      const multerErr = exception as any;
      if (multerErr.code === 'LIMIT_FILE_SIZE') {
        status = HttpStatus.PAYLOAD_TOO_LARGE;
        message = 'The uploaded file exceeds the 25 MB size limit.';
      } else {
        status = HttpStatus.BAD_REQUEST;
        message = multerErr.message || 'File upload error occurred.';
      }
    } else if (
      (exception as any)?.name === 'PrismaClientKnownRequestError' ||
      (exception as any)?.code?.startsWith?.('P')
    ) {
      const prismaErr = exception as any;
      if (prismaErr.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        const target = Array.isArray(prismaErr.meta?.target)
          ? prismaErr.meta.target.join(', ')
          : prismaErr.meta?.target || 'field';
        message = `An entry with this ${target} already exists. Please provide unique information.`;
      } else if (prismaErr.code === 'P2003') {
        status = HttpStatus.BAD_REQUEST;
        message =
          'Cannot complete this action because other active records depend on this item. Please reassign or update dependent records first.';
      } else if (prismaErr.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        message =
          'The requested item could not be found or has already been removed.';
      } else {
        status = HttpStatus.BAD_REQUEST;
        message =
          'A database validation error occurred while processing this request.';
      }
    } else {
      // Unhandled runtime exception
      message = 'An internal system error occurred. Please contact technical support if this continues.';
    }

    // Log detailed diagnostics for engineering
    const errorDetails = errors.length > 0 ? JSON.stringify(errors) : message;
    if (status >= 500) {
      this.logger.error(
        `[${request.method}] ${request.url} - Status ${status} - ${message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.error(
        `[${request.method}] ${request.url} - Status ${status} - ${errorDetails}`,
      );
    }

    const payload: ApiResponse = {
      success: false,
      message,
      errors: errors.length > 0 ? errors : undefined,
    };

    response.status(status).json(payload);
  }
}
