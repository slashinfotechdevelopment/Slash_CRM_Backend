import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiResponse } from '../interfaces/api-response.interface';

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    return next.handle().pipe(
      map((res) => {
        // If already structured with standard response envelope
        if (
          res &&
          typeof res === 'object' &&
          'success' in res &&
          'message' in res
        ) {
          return res;
        }

        return {
          success: true,
          message: 'Operation completed successfully',
          data: res ?? null,
        };
      }),
    );
  }
}

