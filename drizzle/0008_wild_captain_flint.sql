CREATE TYPE "public"."youtube_video_status" AS ENUM('uploading', 'uploaded', 'scheduled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."youtube_video_type" AS ENUM('long', 'short');--> statement-breakpoint
CREATE TABLE "content_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"version" integer NOT NULL,
	"prompt" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "youtube_oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "youtube_videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"series_id" text NOT NULL,
	"source_id" text NOT NULL,
	"video_type" "youtube_video_type" NOT NULL,
	"metadata_revision_id" uuid NOT NULL,
	"youtube_video_id" text,
	"status" "youtube_video_status" NOT NULL,
	"publish_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_oauth_tokens" ADD CONSTRAINT "youtube_oauth_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_videos" ADD CONSTRAINT "youtube_videos_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_videos" ADD CONSTRAINT "youtube_videos_metadata_revision_id_content_revisions_id_fk" FOREIGN KEY ("metadata_revision_id") REFERENCES "public"."content_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_revisions_org_id_source_id_version_idx" ON "content_revisions" USING btree ("organization_id","source_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "youtube_oauth_tokens_organization_id_idx" ON "youtube_oauth_tokens" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "youtube_videos_organization_id_idx" ON "youtube_videos" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "youtube_videos_series_id_idx" ON "youtube_videos" USING btree ("series_id");--> statement-breakpoint
CREATE UNIQUE INDEX "youtube_videos_active_source_id_idx" ON "youtube_videos" USING btree ("organization_id","source_id") WHERE "youtube_videos"."status" != 'failed';