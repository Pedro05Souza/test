import { Module } from "@nestjs/common";
import { AuthGuard } from "../shared/http/auth.guard";
import { OpenWallet } from "./application/open-wallet";
import { WalletQueries } from "./application/wallet-queries";
import { WalletController } from "./http/wallet.controller";

@Module({
  providers: [OpenWallet, WalletQueries, AuthGuard],
  controllers: [WalletController],
})
export class WalletModule {}
