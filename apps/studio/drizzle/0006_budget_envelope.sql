ALTER TABLE `production_runs` ADD `budget_micro_usd` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `production_runs` ADD `spent_micro_usd` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `production_runs` ADD `reserved_micro_usd` integer DEFAULT 0 NOT NULL;