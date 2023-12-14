ALTER TABLE `keys` ADD CONSTRAINT `slug_idx` UNIQUE(`slug`);--> statement-breakpoint
ALTER TABLE `keys` ADD `slug` varchar(256) NOT NULL;