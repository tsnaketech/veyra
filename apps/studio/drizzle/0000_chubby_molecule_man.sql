CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`media_type` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assets_project_idx` ON `assets` (`project_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversations_project_idx` ON `conversations` (`project_id`);--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`timestamp_ms` integer NOT NULL,
	`scene_id` text,
	`text` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revision_id`,`project_id`) REFERENCES `video_revisions`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scene_id`,`revision_id`) REFERENCES `scenes`(`id`,`revision_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "feedback_time" CHECK("feedback"."timestamp_ms" >= 0),
	CONSTRAINT "feedback_status" CHECK("feedback"."status" in ('open','planned','applied','resolved','rejected'))
);
--> statement-breakpoint
CREATE INDEX `feedback_revision_idx` ON `feedback` (`revision_id`);--> statement-breakpoint
CREATE INDEX `feedback_project_idx` ON `feedback` (`project_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "message_role" CHECK("messages"."role" in ('user','assistant','system','tool'))
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`resolved_config` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `quality_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`revision_id` text NOT NULL,
	`report` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `video_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reports_revision_idx` ON `quality_reports` (`revision_id`);--> statement-breakpoint
CREATE TABLE `render_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`revision_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`stage` text DEFAULT 'queued' NOT NULL,
	`stderr_tail` text,
	`resolved_config` text DEFAULT '{}' NOT NULL,
	`output_path` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `video_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "job_progress" CHECK("render_jobs"."progress" between 0 and 100),
	CONSTRAINT "job_status" CHECK("render_jobs"."status" in ('queued','running','succeeded','failed','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `jobs_revision_idx` ON `render_jobs` (`revision_id`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `render_jobs` (`status`);--> statement-breakpoint
CREATE TABLE `revision_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`revision_id` text NOT NULL,
	`plan` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `video_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `plans_revision_idx` ON `revision_plans` (`revision_id`);--> statement-breakpoint
CREATE TABLE `scenes` (
	`id` text NOT NULL,
	`revision_id` text NOT NULL,
	`start` integer NOT NULL,
	`duration` integer NOT NULL,
	`text` text NOT NULL,
	`animation` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `video_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "scene_times" CHECK("scenes"."start" >= 0 and "scenes"."duration" > 0)
);
--> statement-breakpoint
CREATE INDEX `scenes_revision_idx` ON `scenes` (`revision_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scene_revision_unique` ON `scenes` (`id`,`revision_id`);--> statement-breakpoint
CREATE TABLE `video_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`parent_revision_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`storyboard` text NOT NULL,
	`resolved_config` text NOT NULL,
	`video_path` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_revision_id`) REFERENCES `video_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "revision_status" CHECK("video_revisions"."status" in ('draft','rendering','qa','awaiting_approval','approved','changes_requested','published','failed'))
);
--> statement-breakpoint
CREATE INDEX `revisions_project_idx` ON `video_revisions` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `revision_project_unique` ON `video_revisions` (`id`,`project_id`);