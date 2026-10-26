import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { ApplicationError, ValidationError, type ErrorCategory } from "../application/errors";
import type { Logger } from "../application/ports";
import { DomainError } from "../domain/errors";

const STATUS_BY_CATEGORY: Record<ErrorCategory, number> = {
  validation: 400,
  not_found: 404,
  conflict: 409,
  transient: 503,
};

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    /** Whether resending the identical request may succeed. */
    retryable: boolean;
    issues?: readonly { path: string; message: string }[];
  };
}

/**
 * Single mapping from errors to HTTP for every endpoint (see ApplicationError for the table).
 * Business rejections never reach this filter: they are successful calls with status 422.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.map(exception);
    if (status === 503) res.setHeader("Retry-After", "1");
    if (status >= 500) {
      this.logger.error("request failed", {
        status,
        code: body.error.code,
        err: exception instanceof Error ? { name: exception.name, message: exception.message, stack: exception.stack } : String(exception),
      });
    }
    res.status(status).json(body);
  }

  private map(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof ApplicationError) {
      return {
        status: STATUS_BY_CATEGORY[exception.category],
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            retryable: exception.category === "transient",
            ...(exception instanceof ValidationError && exception.issues.length ? { issues: exception.issues } : {}),
          },
        },
      };
    }
    // Domain rules refusing the *shape* of a request (bad money, missing reference, OPENING kind…).
    if (exception instanceof DomainError) {
      return { status: 400, body: { error: { code: exception.code, message: exception.message, retryable: false } } };
    }
    // Framework-level errors: malformed JSON (body-parser → BadRequestException), unknown route, …
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = status === 400 ? "INVALID_PAYLOAD" : status === 404 ? "NOT_FOUND" : "HTTP_ERROR";
      return { status, body: { error: { code, message: exception.message, retryable: status >= 500 } } };
    }
    return { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "internal error", retryable: false } } };
  }
}
