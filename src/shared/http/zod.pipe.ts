import { createParamDecorator, type ExecutionContext, type PipeTransform } from "@nestjs/common";
import type { Request } from "express";
import type { z } from "zod";
import { parseOrThrow } from "./validation";

/**
 * Validates and parses a request part with a zod schema. On failure throws ValidationError
 * (→ 400 with per-field issues via HttpErrorFilter). The handler receives `z.infer<typeof schema>`.
 *
 *   @Body(new ZodPipe(schema)) body: z.infer<typeof schema>
 */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(
    private readonly schema: T,
    private readonly what = "payload",
  ) {}

  transform(value: unknown): z.infer<T> {
    return parseOrThrow(this.schema, value, this.what);
  }
}

/** A single request header. Unlike Nest's @Headers(), custom param decorators run pipes. */
export const RequestHeader = createParamDecorator((name: string, ctx: ExecutionContext) =>
  ctx.switchToHttp().getRequest<Request>().header(name),
);
