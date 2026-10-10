CREATE TABLE "platform_oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"expires_at" timestamp with time zone NOT NULL,
	"refresh_expires_at" timestamp with time zone,
	"platform_account_info" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"series_id" text NOT NULL,
	"source_id" text NOT NULL,
	"video_type" text NOT NULL,
	"metadata_revision_id" uuid NOT NULL,
	"platform_video_id" text,
	"publish_id" text,
	"status" text NOT NULL,
	"publish_at" timestamp with time zone,
	"platform_options" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Migra datos existentes de youtube_oauth_tokens antes de dropearla: mismo id (preserva FKs
-- externas si las hubiera), platform fijo 'youtube' porque esa tabla vieja solo existía para
-- esa plataforma, google_email/channel_title se combinan en el jsonb nuevo platform_account_info.
INSERT INTO "platform_oauth_tokens" (
	"id", "organization_id", "platform", "encrypted_access_token", "encrypted_refresh_token",
	"expires_at", "platform_account_info", "created_at", "updated_at"
)
SELECT
	"id", "organization_id", 'youtube', "encrypted_access_token", "encrypted_refresh_token",
	"expires_at",
	CASE WHEN "google_email" IS NOT NULL OR "channel_title" IS NOT NULL
		THEN jsonb_build_object('googleEmail', "google_email", 'channelTitle', "channel_title")
		ELSE NULL
	END,
	"created_at", "updated_at"
FROM "youtube_oauth_tokens";
--> statement-breakpoint
-- Migra datos existentes de youtube_videos antes de dropearla: mismo id, platform fijo
-- 'youtube', youtube_video_id -> platform_video_id (mismo dato, nuevo nombre genérico).
INSERT INTO "published_videos" (
	"id", "organization_id", "platform", "series_id", "source_id", "video_type",
	"metadata_revision_id", "platform_video_id", "status", "publish_at", "created_at"
)
SELECT
	"id", "organization_id", 'youtube', "series_id", "source_id", "video_type"::text,
	"metadata_revision_id", "youtube_video_id", "status"::text, "publish_at", "created_at"
FROM "youtube_videos";
--> statement-breakpoint
DROP TABLE "youtube_oauth_tokens" CASCADE;--> statement-breakpoint
DROP TABLE "youtube_videos" CASCADE;--> statement-breakpoint
ALTER TABLE "platform_oauth_tokens" ADD CONSTRAINT "platform_oauth_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_videos" ADD CONSTRAINT "published_videos_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_videos" ADD CONSTRAINT "published_videos_metadata_revision_id_content_revisions_id_fk" FOREIGN KEY ("metadata_revision_id") REFERENCES "public"."content_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_oauth_tokens_organization_id_platform_idx" ON "platform_oauth_tokens" USING btree ("organization_id","platform");--> statement-breakpoint
CREATE INDEX "published_videos_organization_id_idx" ON "published_videos" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "published_videos_series_id_idx" ON "published_videos" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "published_videos_publish_id_idx" ON "published_videos" USING btree ("publish_id");--> statement-breakpoint
CREATE INDEX "published_videos_due_scheduled_idx" ON "published_videos" USING btree ("platform","status","publish_at");--> statement-breakpoint
CREATE UNIQUE INDEX "published_videos_active_source_id_idx" ON "published_videos" USING btree ("organization_id","platform","source_id") WHERE "published_videos"."status" != 'failed';--> statement-breakpoint
CREATE INDEX "notifications_organization_id_created_at_idx" ON "notifications" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_organization_id_read_idx" ON "notifications" USING btree ("organization_id","read");--> statement-breakpoint
DROP TYPE "public"."youtube_video_status";--> statement-breakpoint
DROP TYPE "public"."youtube_video_type";
