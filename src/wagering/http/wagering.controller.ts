import { Body, Controller, Get, Inject, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { AuthGuard } from "../../shared/http/auth.guard";
import { currentTrace } from "../../shared/http/correlation.middleware";
import { externalIdSchema, moneySchema, uuidSchema } from "../../shared/http/validation";
import { RequestHeader, ZodPipe } from "../../shared/http/zod.pipe";
import { WagerTransactionStatus, SUBMITTABLE_KINDS } from "../domain/wager-transaction";
import { GetWagerTransaction } from "../application/get-wager-transaction";
import { ProcessWagerTransaction } from "../application/process-wager-transaction";
import type { WagerTransactionResult, WagerTransactionView } from "../application/wager-transaction.views";

/** Shared by HTTP and the SQS message `data` (the latter also carries idempotencyKey). */
export const wagerTransactionPayloadSchema = z.strictObject({
  providerId: externalIdSchema(64),
  externalTransactionId: externalIdSchema(128),
  playerId: externalIdSchema(128),
  walletId: uuidSchema,
  roundId: externalIdSchema(128),
  gameId: externalIdSchema(128),
  kind: z.enum(SUBMITTABLE_KINDS),
  money: moneySchema,
  referenceExternalTransactionId: externalIdSchema(128).optional(),
});
export type WagerTransactionPayload = z.infer<typeof wagerTransactionPayloadSchema>;

export const idempotencyKeySchema = externalIdSchema(256);

/**
 * PROCESSED → 201 (200 on replay) · PENDING_REFERENCE → 202 · REJECTED → 422.
 * The body is always the WagerTransactionResult, so a replay returns exactly the original response.
 */
export function httpStatusFor(result: WagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    default:
      return 500;
  }
}

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(GetWagerTransaction) private readonly getWager: GetWagerTransaction,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @RequestHeader("idempotency-key", new ZodPipe(idempotencyKeySchema, "Idempotency-Key header")) idempotencyKey: string,
    @Body(new ZodPipe(wagerTransactionPayloadSchema)) payload: WagerTransactionPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerTransactionResult> {
    const result = await this.processWager.execute({ ...payload, idempotencyKey }, { ...currentTrace(), source: "http" });
    res.status(httpStatusFor(result));
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  byId(@Param("transactionId", new ZodPipe(uuidSchema, "transactionId")) transactionId: string): Promise<WagerTransactionView> {
    return this.getWager.byId(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  byExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.getWager.byExternalId(providerId, externalTransactionId);
  }
}
