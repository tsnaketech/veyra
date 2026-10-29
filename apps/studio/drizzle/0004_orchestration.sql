CREATE TABLE `production_phases` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`phase` text NOT NULL,
	`agent` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`input_hash` text,
	`result` text,
	`error` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `production_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "phase_status" CHECK("production_phases"."status" in ('pending','running','done','failed','waiting','skipped'))
);
--> statement-breakpoint
CREATE INDEX `phases_run_idx` ON `production_phases` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `phase_run_unique` ON `production_phases` (`run_id`,`phase`);--> statement-breakpoint
CREATE TABLE `production_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`brief` text,
	`plan` text NOT NULL,
	`source_revision_id` text,
	`revision_id` text,
	`ai_calls` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_revision_id`) REFERENCES `video_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revision_id`) REFERENCES `video_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "run_status" CHECK("production_runs"."status" in ('running','waiting','completed','failed','stopped'))
);
--> statement-breakpoint
CREATE INDEX `runs_project_idx` ON `production_runs` (`project_id`);