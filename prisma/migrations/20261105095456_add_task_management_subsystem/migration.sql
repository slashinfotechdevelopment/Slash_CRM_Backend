-- CreateTable
CREATE TABLE `task_code_sequences` (
    `id` VARCHAR(30) NOT NULL,
    `prefix` VARCHAR(10) NOT NULL,
    `last_number` INTEGER NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `task_code_sequences_prefix_key`(`prefix`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tasks` (
    `id` VARCHAR(30) NOT NULL,
    `task_code` VARCHAR(30) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `description` TEXT NOT NULL,
    `priority` ENUM('LOW', 'MEDIUM', 'HIGH', 'URGENT') NOT NULL DEFAULT 'MEDIUM',
    `status` ENUM('TODO', 'IN_PROGRESS', 'ON_HOLD', 'IN_REVIEW', 'REOPENED', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'TODO',
    `category` VARCHAR(50) NOT NULL DEFAULT 'GENERAL',
    `progress` INTEGER NOT NULL DEFAULT 0,
    `start_date` DATE NOT NULL,
    `due_date` DATE NULL,
    `estimated_hours` DECIMAL(6, 2) NULL,
    `created_by_id` VARCHAR(30) NOT NULL,
    `assignee_id` VARCHAR(30) NULL,
    `assigned_by_id` VARCHAR(30) NULL,
    `assigned_at` DATETIME(0) NULL,
    `department_id` VARCHAR(30) NOT NULL,
    `deleted_at` DATETIME(0) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `tasks_task_code_key`(`task_code`),
    INDEX `idx_tasks_status`(`status`),
    INDEX `idx_tasks_assignee`(`assignee_id`),
    INDEX `idx_tasks_department`(`department_id`),
    INDEX `idx_tasks_creator`(`created_by_id`),
    INDEX `idx_tasks_deleted`(`deleted_at`),
    INDEX `idx_tasks_start_date`(`start_date`),
    INDEX `idx_tasks_due_date`(`due_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_assignment_histories` (
    `id` VARCHAR(30) NOT NULL,
    `task_id` VARCHAR(30) NOT NULL,
    `previous_assignee_id` VARCHAR(30) NULL,
    `new_assignee_id` VARCHAR(30) NULL,
    `assigned_by_id` VARCHAR(30) NOT NULL,
    `reason` VARCHAR(500) NULL,
    `assigned_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_assignment_history_task`(`task_id`),
    INDEX `idx_assignment_history_new_assignee`(`new_assignee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_status_histories` (
    `id` VARCHAR(30) NOT NULL,
    `task_id` VARCHAR(30) NOT NULL,
    `previous_status` ENUM('TODO', 'IN_PROGRESS', 'ON_HOLD', 'IN_REVIEW', 'REOPENED', 'COMPLETED', 'CANCELLED') NULL,
    `new_status` ENUM('TODO', 'IN_PROGRESS', 'ON_HOLD', 'IN_REVIEW', 'REOPENED', 'COMPLETED', 'CANCELLED') NOT NULL,
    `changed_by_id` VARCHAR(30) NOT NULL,
    `comment` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_status_history_task`(`task_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_activity_logs` (
    `id` VARCHAR(30) NOT NULL,
    `task_id` VARCHAR(30) NOT NULL,
    `performed_by` VARCHAR(30) NOT NULL,
    `action` VARCHAR(50) NOT NULL,
    `metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_activity_log_task`(`task_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_tags` (
    `id` VARCHAR(30) NOT NULL,
    `name` VARCHAR(50) NOT NULL,
    `color` VARCHAR(20) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `task_tags_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_tag_mappings` (
    `id` VARCHAR(30) NOT NULL,
    `task_id` VARCHAR(30) NOT NULL,
    `tag_id` VARCHAR(30) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_tag_mapping_tag`(`tag_id`),
    UNIQUE INDEX `uq_task_tag_mapping`(`task_id`, `tag_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_assignee_id_fkey` FOREIGN KEY (`assignee_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_assigned_by_id_fkey` FOREIGN KEY (`assigned_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_department_id_fkey` FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_assignment_histories` ADD CONSTRAINT `task_assignment_histories_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_assignment_histories` ADD CONSTRAINT `task_assignment_histories_previous_assignee_id_fkey` FOREIGN KEY (`previous_assignee_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_assignment_histories` ADD CONSTRAINT `task_assignment_histories_new_assignee_id_fkey` FOREIGN KEY (`new_assignee_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_assignment_histories` ADD CONSTRAINT `task_assignment_histories_assigned_by_id_fkey` FOREIGN KEY (`assigned_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_status_histories` ADD CONSTRAINT `task_status_histories_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_status_histories` ADD CONSTRAINT `task_status_histories_changed_by_id_fkey` FOREIGN KEY (`changed_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_activity_logs` ADD CONSTRAINT `task_activity_logs_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_activity_logs` ADD CONSTRAINT `task_activity_logs_performed_by_fkey` FOREIGN KEY (`performed_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_tag_mappings` ADD CONSTRAINT `task_tag_mappings_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_tag_mappings` ADD CONSTRAINT `task_tag_mappings_tag_id_fkey` FOREIGN KEY (`tag_id`) REFERENCES `task_tags`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
