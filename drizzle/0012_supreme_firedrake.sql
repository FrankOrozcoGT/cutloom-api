CREATE TABLE "features" (
	"id" text PRIMARY KEY NOT NULL,
	"credit_eligible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_cost_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cores" integer NOT NULL,
	"cost_per_month" numeric NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Backfill del catálogo de features con los valores que ya circulan en código/datos hoy —
-- debe insertarse antes de las FK de abajo, para no romper filas existentes de
-- plan_features/entitlements que ya referencian estos strings.
INSERT INTO "features" ("id") VALUES ('shorts_ai'), ('youtube_ai'), ('advanced_subtitles');
--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "balance" integer;--> statement-breakpoint
-- Balance restante = tope del plan vigente menos lo ya consumido este ciclo (no 0 ni una copia
-- de usage_count: eso perdería el consumo ya hecho). usage_limit null (sin tope) -> balance
-- null, igual semántica que antes.
UPDATE "entitlements" e
SET "balance" = GREATEST(pf."usage_limit" - e."usage_count", 0)
FROM "plan_features" pf
JOIN "subscriptions" s ON s."plan_id" = pf."plan_id"
WHERE pf."feature" = e."feature" AND s."organization_id" = e."organization_id" AND pf."usage_limit" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "cpu_time_micros" integer;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "peak_memory_bytes" integer;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_feature_features_id_fk" FOREIGN KEY ("feature") REFERENCES "public"."features"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_feature_features_id_fk" FOREIGN KEY ("feature") REFERENCES "public"."features"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" DROP COLUMN "usage_count";
