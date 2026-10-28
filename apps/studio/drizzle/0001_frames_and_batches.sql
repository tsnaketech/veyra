CREATE TABLE `ai_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`status` text DEFAULT 'awaiting_import' NOT NULL,
	`batch_id` text,
	`input` text NOT NULL,
	`dir` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `correction_batches`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_kind" CHECK("ai_tasks"."kind" in ('storyboard','plan')),
	CONSTRAINT "task_status" CHECK("ai_tasks"."status" in ('awaiting_import','imported','failed'))
);
--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `ai_tasks` (`project_id`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `correction_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_revision_id` text NOT NULL,
	`submission_key` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`provider` text NOT NULL,
	`feedback_ids` text NOT NULL,
	`plan_id` text,
	`result_revision_id` text,
	`verification` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_id`) REFERENCES `revision_plans`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_revision_id`) REFERENCES `video_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_revision_id`,`project_id`) REFERENCES `video_revisions`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "batch_status" CHECK("correction_batches"."status" in ('queued','submitted','awaiting_import','planned','applied','rejected','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `correction_batches_submission_key_unique` ON `correction_batches` (`submission_key`);--> statement-breakpoint
CREATE INDEX `batches_revision_idx` ON `correction_batches` (`source_revision_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`timestamp_ms` integer NOT NULL,
	`frame_index` integer,
	`fps_num` integer,
	`fps_den` integer,
	`capture_path` text,
	`batch_id` text,
	`scene_id` text,
	`text` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `correction_batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revision_id`,`project_id`) REFERENCES `video_revisions`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scene_id`,`revision_id`) REFERENCES `scenes`(`id`,`revision_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "feedback_time" CHECK("__new_feedback"."timestamp_ms" >= 0),
	CONSTRAINT "feedback_frame" CHECK("__new_feedback"."frame_index" is null or "__new_feedback"."frame_index" >= 0),
	CONSTRAINT "feedback_status" CHECK("__new_feedback"."status" in ('draft','queued','submitted','applied','rejected','failed'))
);
--> statement-breakpoint
-- Hand-edited: only pre-existing columns are copied; legacy statuses map to the new lifecycle.
INSERT INTO `__new_feedback`("id", "project_id", "revision_id", "timestamp_ms", "scene_id", "text", "status", "author", "created_at", "updated_at") SELECT "id", "project_id", "revision_id", "timestamp_ms", "scene_id", "text", CASE "status" WHEN 'open' THEN 'draft' WHEN 'planned' THEN 'submitted' WHEN 'resolved' THEN 'applied' ELSE "status" END, "author", "created_at", "updated_at" FROM `feedback`;--> statement-breakpoint
DROP TABLE `feedback`;--> statement-breakpoint
ALTER TABLE `__new_feedback` RENAME TO `feedback`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `feedback_revision_idx` ON `feedback` (`revision_id`);--> statement-breakpoint
CREATE INDEX `feedback_project_idx` ON `feedback` (`project_id`);--> statement-breakpoint
CREATE INDEX `feedback_batch_idx` ON `feedback` (`batch_id`);--> statement-breakpoint
ALTER TABLE `video_revisions` ADD `media` text;--> statement-breakpoint
-- Provider ids renamed: fake-test-only -> fake, anthropic -> anthropic-api.
UPDATE `video_revisions` SET `resolved_config` = json_set(`resolved_config`, '$.aiProvider', CASE json_extract(`resolved_config`, '$.aiProvider') WHEN 'fake-test-only' THEN 'fake' ELSE 'anthropic-api' END) WHERE json_extract(`resolved_config`, '$.aiProvider') IN ('fake-test-only', 'anthropic');
