-- CreateTable
CREATE TABLE `task_time_entries` (
    `id` VARCHAR(30) NOT NULL,
    `task_id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `attendance_session_id` VARCHAR(30) NULL,
    `work_date` DATE NOT NULL,
    `started_at` DATETIME(0) NOT NULL,
    `ended_at` DATETIME(0) NULL,
    `duration_seconds` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('RUNNING', 'PAUSED', 'STOPPED', 'COMPLETED') NOT NULL DEFAULT 'RUNNING',
    `device_type` ENUM('WEB', 'MOBILE', 'DESKTOP', 'SYSTEM') NOT NULL DEFAULT 'WEB',
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(255) NULL,
    `is_correction` BOOLEAN NOT NULL DEFAULT false,
    `is_superseded` BOOLEAN NOT NULL DEFAULT false,
    `superseded_by_id` VARCHAR(30) NULL,
    `correction_request_id` VARCHAR(30) NULL,
    `active_user_id` VARCHAR(30) GENERATED ALWAYS AS (CASE WHEN `ended_at` IS NULL THEN `user_id` ELSE NULL END) STORED,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_task_time_entry_correction_request`(`correction_request_id`),
    UNIQUE INDEX `uq_one_running_timer_per_user`(`active_user_id`),
    INDEX `idx_task_time_entries_task_status`(`task_id`, `status`),
    INDEX `idx_task_time_entries_user_date`(`user_id`, `work_date`),
    INDEX `idx_task_time_entries_effective`(`task_id`, `status`, `is_superseded`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_time_pauses` (
    `id` VARCHAR(30) NOT NULL,
    `task_id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `preceding_time_entry_id` VARCHAR(30) NULL,
    `following_time_entry_id` VARCHAR(30) NULL,
    `paused_at` DATETIME(0) NOT NULL,
    `resumed_at` DATETIME(0) NULL,
    `pause_duration_seconds` INTEGER NOT NULL DEFAULT 0,
    `reason` ENUM('TEA_BREAK', 'LUNCH', 'PERSONAL_WORK', 'MEETING', 'WAITING', 'TECHNICAL_ISSUE', 'OTHER', 'TASK_SWITCH', 'LOGOUT') NOT NULL,
    `custom_description` VARCHAR(255) NULL,
    `open_pause_entry_id` VARCHAR(30) GENERATED ALWAYS AS (CASE WHEN `resumed_at` IS NULL THEN `preceding_time_entry_id` ELSE NULL END) STORED,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_one_open_pause_per_entry`(`open_pause_entry_id`),
    INDEX `idx_task_time_pauses_task`(`task_id`),
    INDEX `idx_task_time_pauses_user`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_time_correction_requests` (
    `id` VARCHAR(30) NOT NULL,
    `task_id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `original_entry_id` VARCHAR(30) NOT NULL,
    `requested_started_at` DATETIME(0) NOT NULL,
    `requested_ended_at` DATETIME(0) NOT NULL,
    `requested_duration_seconds` INTEGER NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `reviewed_by_id` VARCHAR(30) NULL,
    `reviewed_at` DATETIME(0) NULL,
    `rejection_reason` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `idx_task_time_corrections_task_status`(`task_id`, `status`),
    INDEX `idx_task_time_corrections_user_status`(`user_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `task_time_entries` ADD CONSTRAINT `task_time_entries_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_time_entries` ADD CONSTRAINT `task_time_entries_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_time_entries` ADD CONSTRAINT `task_time_entries_superseded_by_id_fkey` FOREIGN KEY (`superseded_by_id`) REFERENCES `task_time_entries`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_time_entries` ADD CONSTRAINT `task_time_entries_correction_request_id_fkey` FOREIGN KEY (`correction_request_id`) REFERENCES `task_time_correction_requests`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_time_pauses` ADD CONSTRAINT `task_time_pauses_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_time_pauses` ADD CONSTRAINT `task_time_pauses_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_time_pauses` ADD CONSTRAINT `task_time_pauses_preceding_time_entry_id_fkey` FOREIGN KEY (`preceding_time_entry_id`) REFERENCES `task_time_entries`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_time_pauses` ADD CONSTRAINT `task_time_pauses_following_time_entry_id_fkey` FOREIGN KEY (`following_time_entry_id`) REFERENCES `task_time_entries`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_time_correction_requests` ADD CONSTRAINT `task_time_correction_requests_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_time_correction_requests` ADD CONSTRAINT `task_time_correction_requests_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_time_correction_requests` ADD CONSTRAINT `task_time_correction_requests_reviewed_by_id_fkey` FOREIGN KEY (`reviewed_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_time_correction_requests` ADD CONSTRAINT `task_time_correction_requests_original_entry_id_fkey` FOREIGN KEY (`original_entry_id`) REFERENCES `task_time_entries`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
