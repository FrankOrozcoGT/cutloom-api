CREATE TABLE "credit_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_ledger_expirations" (
	"ledger_entry_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_ledger_plan_grants" (
	"ledger_entry_id" uuid PRIMARY KEY NOT NULL,
	"subscription_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_ledger_topups" (
	"ledger_entry_id" uuid PRIMARY KEY NOT NULL,
	"recurrente_checkout_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_ledger_usages" (
	"ledger_entry_id" uuid PRIMARY KEY NOT NULL,
	"feature" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_account" ADD CONSTRAINT "credit_account_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_expirations" ADD CONSTRAINT "credit_ledger_expirations_ledger_entry_id_credit_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."credit_ledger_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_expirations" ADD CONSTRAINT "credit_ledger_expirations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_plan_grants" ADD CONSTRAINT "credit_ledger_plan_grants_ledger_entry_id_credit_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."credit_ledger_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_plan_grants" ADD CONSTRAINT "credit_ledger_plan_grants_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_topups" ADD CONSTRAINT "credit_ledger_topups_ledger_entry_id_credit_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."credit_ledger_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_usages" ADD CONSTRAINT "credit_ledger_usages_ledger_entry_id_credit_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."credit_ledger_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_usages" ADD CONSTRAINT "credit_ledger_usages_feature_features_id_fk" FOREIGN KEY ("feature") REFERENCES "public"."features"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_account_organization_id_idx" ON "credit_account" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "credit_ledger_entries_organization_id_idx" ON "credit_ledger_entries" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_expirations_organization_id_period_start_idx" ON "credit_ledger_expirations" USING btree ("organization_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_plan_grants_subscription_id_period_start_idx" ON "credit_ledger_plan_grants" USING btree ("subscription_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_topups_recurrente_checkout_id_idx" ON "credit_ledger_topups" USING btree ("recurrente_checkout_id");--> statement-breakpoint

-- === BACKFILL: preservar datos reales antes de dropear las tablas viejas ===
-- plans: no existe creditsPerCycle todavía — se agrega nullable, se calcula desde la suma de
-- plan_features.usage_limit existentes (3 features x plan, 300+300+100=700 en ambos planes
-- reales de dev/prod), y recién después se pone NOT NULL.
ALTER TABLE "plans" ADD COLUMN "credits_per_cycle" integer;--> statement-breakpoint
UPDATE "plans" SET "credits_per_cycle" = sub.total
FROM (SELECT "plan_id", SUM("usage_limit") AS total FROM "plan_features" GROUP BY "plan_id") sub
WHERE "plans"."id" = sub."plan_id";--> statement-breakpoint
ALTER TABLE "plans" ALTER COLUMN "credits_per_cycle" SET NOT NULL;--> statement-breakpoint

-- Premium Anual: nuevo precio $100.00 USD/año (antes $90.00) — nuevo producto/precio real creado
-- en Recurrente LIVE (prod_nmnrlnmi / price_gj5365cv) antes de esta migración. amount_in_cents y
-- recurrente_price_id deben coincidir exactamente con lo que Recurrente va a cobrar.
UPDATE "plans" SET "amount_in_cents" = 10000, "recurrente_price_id" = 'price_gj5365cv' WHERE "name" = 'Premium Anual';--> statement-breakpoint

-- usage_events: feature ya se renombra a action (rename real abajo, preserva el dato) —
-- feature_id es nueva, se deriva de action vía el mapeo FEATURE_BY_USAGE_EVENT_ACTION
-- (shorts_ai para detect_shorts/score_shorts/analyze_emotion, advanced_subtitles para
-- improve_subtitles, youtube_ai para generate_youtube_metadata). Dato corrupto real en dev: 33
-- filas quedaron con feature='youtube_ai' (el nombre del paquete de billing, no una acción
-- granular válida) por un bug ya corregido en GenerateYouTubeMetadataUseCase/server.ts en esta
-- misma sesión — no son eventos válidos bajo ningún valor del enum real, se eliminan en vez de
-- forzarlos a encajar en el modelo nuevo.
DELETE FROM "usage_events" WHERE "feature" = 'youtube_ai';--> statement-breakpoint
ALTER TABLE "usage_events" RENAME COLUMN "feature" TO "action";--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "feature_id" text;--> statement-breakpoint
UPDATE "usage_events" SET "feature_id" = CASE "action"
	WHEN 'detect_shorts' THEN 'shorts_ai'
	WHEN 'score_shorts' THEN 'shorts_ai'
	WHEN 'analyze_emotion' THEN 'shorts_ai'
	WHEN 'improve_subtitles' THEN 'advanced_subtitles'
	WHEN 'generate_youtube_metadata' THEN 'youtube_ai'
END;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "feature_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- credit_account: migrar filas reales de credit_accounts (mismo shape, solo cambia el nombre de tabla).
INSERT INTO "credit_account" ("id", "organization_id", "balance", "created_at", "updated_at")
SELECT "id", "organization_id", "balance", "created_at", "updated_at" FROM "credit_accounts";--> statement-breakpoint

-- credit_ledger_entries + credit_ledger_topups: reconstruir el ledger histórico de topups desde
-- credit_transactions (reason='topup', amount positivo, recurrente_checkout_id no nulo).
INSERT INTO "credit_ledger_entries" ("id", "organization_id", "amount", "type", "created_at")
SELECT "id", "organization_id", "amount", 'topup', "created_at"
FROM "credit_transactions"
WHERE "reason" = 'topup' AND "recurrente_checkout_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "credit_ledger_topups" ("ledger_entry_id", "recurrente_checkout_id")
SELECT "id", "recurrente_checkout_id"
FROM "credit_transactions"
WHERE "reason" = 'topup' AND "recurrente_checkout_id" IS NOT NULL;--> statement-breakpoint

-- entitlements: no tiene historial de movimientos (solo guardaba el balance actual por
-- feature, sin ledger) — no hay de dónde reconstruir plan_grant/usage históricos reales. El
-- balance actual de entitlements se suma al pozo único de credit_account como un plan_grant de
-- migración puntual (type='plan_grant', sin fila en credit_ledger_plan_grants porque no hay
-- subscriptionId+periodStart real que atarle — es un ajuste de migración, no un ciclo real).
INSERT INTO "credit_ledger_entries" ("organization_id", "amount", "type", "created_at")
SELECT "organization_id", SUM("balance"), 'plan_grant', now()
FROM "entitlements"
WHERE "balance" > 0
GROUP BY "organization_id";--> statement-breakpoint
UPDATE "credit_account" ca
SET "balance" = ca."balance" + sub.total, "updated_at" = now()
FROM (SELECT "organization_id", SUM("balance") AS total FROM "entitlements" WHERE "balance" > 0 GROUP BY "organization_id") sub
WHERE ca."organization_id" = sub."organization_id";--> statement-breakpoint
-- Organizaciones con balance de entitlements pero sin fila previa en credit_accounts.
INSERT INTO "credit_account" ("organization_id", "balance")
SELECT sub."organization_id", sub.total
FROM (SELECT "organization_id", SUM("balance") AS total FROM "entitlements" WHERE "balance" > 0 GROUP BY "organization_id") sub
WHERE NOT EXISTS (SELECT 1 FROM "credit_account" ca WHERE ca."organization_id" = sub."organization_id");--> statement-breakpoint

ALTER TABLE "credit_accounts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_transactions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "entitlements" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "credit_accounts" CASCADE;--> statement-breakpoint
DROP TABLE "credit_transactions" CASCADE;--> statement-breakpoint
DROP TABLE "entitlements" CASCADE;--> statement-breakpoint
ALTER TABLE "plan_features" DROP COLUMN "usage_limit";
