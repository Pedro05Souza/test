import { z } from "zod";
import { ValidationError } from "../application/errors";
import { isUuid } from "../uuid";

export function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown, what = "payload"): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationError(
    `invalid ${what}`,
    result.error.issues.map((issue) => ({ path: issue.path.join(".") || "(root)", message: issue.message })),
  );
}

/** Money contract: decimal strings only. Detailed format rules are enforced by Money.from. */
export const moneySchema = z.strictObject({
  amount: z.string({ error: "amount must be a decimal string" }),
  currency: z.string({ error: "currency must be a string" }),
});

export const uuidSchema = z.string().refine(isUuid, { message: "must be a UUID" });

/** External identifiers: non-empty, bounded, printable, no surrounding whitespace. */
export const externalIdSchema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/, { message: "must be printable ASCII without leading/trailing spaces" });
