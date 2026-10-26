import { Module } from "@nestjs/common";
import { AuthGuard } from "../shared/http/auth.guard";
import { GetWagerTransaction } from "./application/get-wager-transaction";
import { ProcessWagerTransaction } from "./application/process-wager-transaction";
import { ResolvePendingReferences } from "./application/resolve-pending-references";
import { WageringController } from "./http/wagering.controller";
import { PendingReferenceWorker } from "./infrastructure/pending-reference.worker";

@Module({
  providers: [ProcessWagerTransaction, GetWagerTransaction, ResolvePendingReferences, PendingReferenceWorker, AuthGuard],
  controllers: [WageringController],
  exports: [ProcessWagerTransaction, ResolvePendingReferences],
})
export class WageringModule {}
