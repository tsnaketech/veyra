CREATE TABLE `loop_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`phase_id` text NOT NULL,
	`step` integer NOT NULL,
	`origin` text NOT NULL,
	`action` text NOT NULL,
	`request` text NOT NULL,
	`invocation` text,
	`status` text NOT NULL,
	`result` text,
	`error` text,
	`cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `production_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`phase_id`) REFERENCES `production_phases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "loop_step_status" CHECK("loop_steps"."status" in ('awaiting-permission','authorized','denied','running','done','failed','interrupted','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `loop_steps_run_idx` ON `loop_steps` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `loop_step_unique` ON `loop_steps` (`phase_id`,`step`);