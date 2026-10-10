CREATE TABLE "active_platform_accounts" (
	"organization_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"platform_account_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_account_id" text NOT NULL,
	"platform_account_info" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Backfill: una fila de platform_accounts por cada platform_oauth_tokens existente, antes de
-- dropear organization_id/platform/platform_account_info de esa tabla. externalAccountId usa el
-- id real de la plataforma cuando ya estaba capturado (TikTok: openId); YouTube todavía no
-- capturaba channelId antes de este cambio, así que se backfillea con un id sintético estable
-- (legacy-youtube-<organization_id>) solo para preservar el historial de esta cuenta ya
-- conectada — la próxima reconexión real de YouTube capturará el channelId verdadero y creará
-- su propia PlatformAccount correcta, sin perder los published_videos ya asociados a esta.
INSERT INTO "platform_accounts" ("id", "organization_id", "platform", "external_account_id", "platform_account_info", "created_at", "updated_at")
SELECT
	gen_random_uuid(),
	"organization_id",
	"platform",
	COALESCE("platform_account_info"->>'openId', 'legacy-' || "platform" || '-' || "organization_id"::text),
	"platform_account_info",
	"created_at",
	"updated_at"
FROM "platform_oauth_tokens";
--> statement-breakpoint
-- Marca cada cuenta recién creada como la activa de su organización+plataforma — hasta ahora
-- solo podía existir una cuenta conectada por organización+plataforma, así que esto preserva
-- exactamente el estado "conectado como X" que ya tenía cada organización.
INSERT INTO "active_platform_accounts" ("organization_id", "platform", "platform_account_id", "updated_at")
SELECT "organization_id", "platform", "id", "updated_at"
FROM "platform_accounts";
--> statement-breakpoint
ALTER TABLE "platform_oauth_tokens" DROP CONSTRAINT "platform_oauth_tokens_organization_id_organizations_id_fk";
--> statement-breakpoint
DROP INDEX "platform_oauth_tokens_organization_id_platform_idx";--> statement-breakpoint
DROP INDEX "published_videos_active_source_id_idx";--> statement-breakpoint
ALTER TABLE "platform_oauth_tokens" ADD COLUMN "platform_account_id" uuid;--> statement-breakpoint
-- Backfill del token: cada platform_oauth_tokens apunta a la platform_accounts que se creó para
-- su mismo organization_id+platform en el INSERT de arriba (hay exactamente una, por eso el
-- join no duplica filas).
UPDATE "platform_oauth_tokens" AS t
SET "platform_account_id" = pa."id"
FROM "platform_accounts" AS pa
WHERE pa."organization_id" = t."organization_id" AND pa."platform" = t."platform";
--> statement-breakpoint
ALTER TABLE "platform_oauth_tokens" ALTER COLUMN "platform_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "published_videos" ADD COLUMN "platform_account_id" uuid;--> statement-breakpoint
-- Backfill de published_videos: todo video ya subido se asocia a la (única) cuenta que existía
-- para su organization_id+platform hasta ahora — preserva el historial completo sin perder
-- ningún registro de los videos ya publicados.
UPDATE "published_videos" AS pv
SET "platform_account_id" = pa."id"
FROM "platform_accounts" AS pa
WHERE pa."organization_id" = pv."organization_id" AND pa."platform" = pv."platform";
--> statement-breakpoint
ALTER TABLE "published_videos" ALTER COLUMN "platform_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "active_platform_accounts" ADD CONSTRAINT "active_platform_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_platform_accounts" ADD CONSTRAINT "active_platform_accounts_platform_account_id_platform_accounts_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."platform_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "active_platform_accounts_org_platform_idx" ON "active_platform_accounts" USING btree ("organization_id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_accounts_org_platform_external_id_idx" ON "platform_accounts" USING btree ("organization_id","platform","external_account_id");--> statement-breakpoint
ALTER TABLE "platform_oauth_tokens" ADD CONSTRAINT "platform_oauth_tokens_platform_account_id_platform_accounts_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."platform_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_videos" ADD CONSTRAINT "published_videos_platform_account_id_platform_accounts_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."platform_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_oauth_tokens_platform_account_id_idx" ON "platform_oauth_tokens" USING btree ("platform_account_id");--> statement-breakpoint
CREATE INDEX "published_videos_platform_account_id_idx" ON "published_videos" USING btree ("platform_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "published_videos_active_source_id_idx" ON "published_videos" USING btree ("platform_account_id","source_id") WHERE "published_videos"."status" != 'failed';--> statement-breakpoint
ALTER TABLE "platform_oauth_tokens" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "platform_oauth_tokens" DROP COLUMN "platform";--> statement-breakpoint
ALTER TABLE "platform_oauth_tokens" DROP COLUMN "platform_account_info";
