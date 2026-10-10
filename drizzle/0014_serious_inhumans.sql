CREATE TABLE "bulk_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"series_id" text NOT NULL,
	"time_zone" text NOT NULL,
	"long_video_publish_day" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bulk_upload_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"tus_upload_id" text NOT NULL,
	"status" text NOT NULL,
	"video_size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Backfill: un bulk_upload "legacy" sintético por cada seriesId ya existente en published_videos
-- (preserva el agrupamiento real por serie en vez de crear un bulk por fila), en status
-- 'completed' — nunca van a resumir ninguna subida, ya están publicados. timeZone/longVideoPublishDay
-- no son recuperables del estado viejo: se usan valores placeholder, inocuos porque
-- BulkUploadOrchestrator nunca vuelve a calendarizar un bulk ya completed.
INSERT INTO "bulk_uploads" ("id", "organization_id", "series_id", "time_zone", "long_video_publish_day", "status", "last_activity_at", "created_at")
SELECT
	gen_random_uuid(),
	"organization_id",
	"series_id",
	'UTC',
	min("created_at"),
	'completed',
	min("created_at"),
	min("created_at")
FROM "published_videos"
GROUP BY "organization_id", "series_id";
--> statement-breakpoint
-- Backfill: un source_upload "legacy" sintético por cada (bulk_upload_id, sourceId) ÚNICO ya
-- existente — tusUploadId placeholder ('legacy:<id>'): no hay objeto real en R2 bajo el
-- protocolo tus para estos videos (se subieron por el multipart viejo, nunca a través de tus),
-- así que no hay ningún id real que poner; nunca se va a intentar leer/resumir este tusUploadId
-- porque el status del source_upload ya es 'completed'. DISTINCT ON por (bulk_upload_id,
-- source_id): el mismo sourceId puede tener más de una fila en published_videos si se publicó a
-- más de una plataforma (ej. YouTube + TikTok) — el binario es UNO solo, compartido, nunca uno
-- por plataforma (ver schema).
INSERT INTO "source_uploads" ("id", "bulk_upload_id", "source_id", "tus_upload_id", "status", "video_size_bytes", "created_at")
SELECT DISTINCT ON (bu."id", pv."source_id")
	gen_random_uuid(),
	bu."id",
	pv."source_id",
	'legacy:' || gen_random_uuid()::text,
	'completed',
	0,
	pv."created_at"
FROM "published_videos" pv
JOIN "bulk_uploads" bu ON bu."organization_id" = pv."organization_id" AND bu."series_id" = pv."series_id"
ORDER BY bu."id", pv."source_id", pv."created_at";
--> statement-breakpoint
ALTER TABLE "published_videos" ADD COLUMN "source_upload_id" uuid;--> statement-breakpoint
-- Backfill: cada published_videos apunta al source_upload sintético (único) de su mismo
-- (seriesId, sourceId) — todas las plataformas de un mismo sourceId comparten el mismo
-- source_upload_id, nunca uno distinto por fila.
UPDATE "published_videos" pv
SET "source_upload_id" = su."id"
FROM "source_uploads" su
JOIN "bulk_uploads" bu ON bu."id" = su."bulk_upload_id"
WHERE bu."organization_id" = pv."organization_id" AND bu."series_id" = pv."series_id" AND su."source_id" = pv."source_id";
--> statement-breakpoint
ALTER TABLE "published_videos" ALTER COLUMN "source_upload_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "published_videos" ADD COLUMN "priority" double precision;--> statement-breakpoint
ALTER TABLE "published_videos" ADD COLUMN "long_video_timestamp_sec" integer;--> statement-breakpoint
ALTER TABLE "published_videos" ADD COLUMN "long_video_url" text;--> statement-breakpoint
ALTER TABLE "bulk_uploads" ADD CONSTRAINT "bulk_uploads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_uploads" ADD CONSTRAINT "source_uploads_bulk_upload_id_bulk_uploads_id_fk" FOREIGN KEY ("bulk_upload_id") REFERENCES "public"."bulk_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bulk_uploads_organization_id_idx" ON "bulk_uploads" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "bulk_uploads_status_last_activity_idx" ON "bulk_uploads" USING btree ("status","last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bulk_uploads_active_series_id_idx" ON "bulk_uploads" USING btree ("series_id") WHERE "bulk_uploads"."status" = 'active';--> statement-breakpoint
CREATE INDEX "source_uploads_bulk_upload_id_idx" ON "source_uploads" USING btree ("bulk_upload_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_uploads_bulk_upload_id_source_id_idx" ON "source_uploads" USING btree ("bulk_upload_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_uploads_tus_upload_id_idx" ON "source_uploads" USING btree ("tus_upload_id");--> statement-breakpoint
ALTER TABLE "published_videos" ADD CONSTRAINT "published_videos_source_upload_id_source_uploads_id_fk" FOREIGN KEY ("source_upload_id") REFERENCES "public"."source_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "published_videos_source_upload_id_idx" ON "published_videos" USING btree ("source_upload_id");