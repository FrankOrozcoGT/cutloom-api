DROP INDEX "subscriptions_recurrente_subscription_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_recurrente_checkout_id_idx" ON "subscriptions" USING btree ("recurrente_checkout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_recurrente_subscription_id_idx" ON "subscriptions" USING btree ("recurrente_subscription_id");