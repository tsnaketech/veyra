CREATE TABLE `quality_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`base_revision_id` text NOT NULL,
	`batch_id` text,
	`evaluator` text,
	`analysis_mode` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`verdicts` text NOT NULL,
	`findings` text NOT NULL,
	`images_examined` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revision_id`) REFERENCES `video_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`base_revision_id`) REFERENCES `video_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `correction_batches`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "evaluation_status" CHECK("quality_evaluations"."status" in ('pending','awaiting_import','completed','failed','unavailable'))
);
--> statement-breakpoint
CREATE INDEX `evaluations_revision_idx` ON `quality_evaluations` (`revision_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ai_tasks` (
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
	CONSTRAINT "task_kind" CHECK("__new_ai_tasks"."kind" in ('storyboard','plan','evaluation')),
	CONSTRAINT "task_status" CHECK("__new_ai_tasks"."status" in ('awaiting_import','imported','failed'))
);
--> statement-breakpoint
INSERT INTO `__new_ai_tasks`("id", "project_id", "kind", "provider", "status", "batch_id", "input", "dir", "error", "created_at", "updated_at") SELECT "id", "project_id", "kind", "provider", "status", "batch_id", "input", "dir", "error", "created_at", "updated_at" FROM `ai_tasks`;--> statement-breakpoint
DROP TABLE `ai_tasks`;--> statement-breakpoint
ALTER TABLE `__new_ai_tasks` RENAME TO `ai_tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `ai_tasks` (`project_id`);