import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AuthGuard } from "../../shared/http/auth.guard";
import { currentTrace } from "../../shared/http/correlation.middleware";
import { externalIdSchema, moneySchema, uuidSchema } from "../../shared/http/validation";
import { ZodPipe } from "../../shared/http/zod.pipe";
import { OpenWallet } from "../application/open-wallet";
import { LEDGER_PAGE_DEFAULT, WalletQueries, type LedgerPage, type ReconciliationReport } from "../application/wallet-queries";
import type { WalletView } from "../application/wallet.views";

const openWalletSchema = z.strictObject({
  playerId: externalIdSchema(128),
  initialBalance: moneySchema,
});
type OpenWalletBody = z.infer<typeof openWalletSchema>;

const ledgerQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().optional(),
});
type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

const walletIdPipe = new ZodPipe(uuidSchema, "walletId");

@Controller("wallets")
@UseGuards(AuthGuard)
export class WalletController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body(new ZodPipe(openWalletSchema)) body: OpenWalletBody): Promise<WalletView> {
    return this.openWallet.execute(body, currentTrace());
  }

  @Get(":walletId")
  get(@Param("walletId", walletIdPipe) walletId: string): Promise<WalletView> {
    return this.queries.getWallet(walletId);
  }

  @Get(":walletId/ledger")
  ledger(
    @Param("walletId", walletIdPipe) walletId: string,
    @Query(new ZodPipe(ledgerQuerySchema, "query")) query: LedgerQuery,
  ): Promise<LedgerPage> {
    return this.queries.getLedgerPage(walletId, query.cursor, query.limit ?? LEDGER_PAGE_DEFAULT);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  reconcile(@Param("walletId", walletIdPipe) walletId: string): Promise<ReconciliationReport> {
    return this.queries.reconcile(walletId, currentTrace());
  }
}
