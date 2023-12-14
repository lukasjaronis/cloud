CREATE TABLE `keys` (
	`id` varchar(256) NOT NULL,
	`slug` varchar(256) NOT NULL,
	`hash` varchar(256) NOT NULL,
	`expires` datetime(3),
	`uses` int,
	`metadata` text,
	`max_tokens` int,
	`tokens` int,
	`refill_rate` int,
	`refill_interval` int,
	CONSTRAINT `keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `hash_idx` UNIQUE(`hash`),
	CONSTRAINT `slug_idx` UNIQUE(`slug`)
);
