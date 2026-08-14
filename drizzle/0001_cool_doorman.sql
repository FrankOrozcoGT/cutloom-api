ALTER TABLE "users" DROP CONSTRAINT "users_organization_id_organizations_id_fk";
--> statement-breakpoint
DROP INDEX "memberships_user_id_idx";--> statement-breakpoint
DROP INDEX "users_organization_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_id_organization_id_idx" ON "memberships" USING btree ("user_id","organization_id");--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "organization_id";