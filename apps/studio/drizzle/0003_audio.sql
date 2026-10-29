ALTER TABLE `assets` ADD `audio` text;--> statement-breakpoint
ALTER TABLE `feedback` ADD `range_end_ms` integer;--> statement-breakpoint
ALTER TABLE `feedback` ADD `audio_track_id` text;--> statement-breakpoint
ALTER TABLE `video_revisions` ADD `audio` text;--> statement-breakpoint
ALTER TABLE `video_revisions` ADD `silent_video_path` text;