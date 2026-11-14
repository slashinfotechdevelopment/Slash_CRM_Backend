-- CreateIndex
CREATE INDEX `idx_user_sessions_user_created` ON `user_sessions`(`user_id`, `created_at`);

-- CreateIndex
CREATE INDEX `idx_leads_created_status` ON `leads`(`created_at`, `status`);

-- CreateIndex
CREATE INDEX `idx_leads_converted_at` ON `leads`(`converted_at`);

