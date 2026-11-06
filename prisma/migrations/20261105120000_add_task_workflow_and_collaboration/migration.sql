-- CreateTable
CREATE TABLE `task_reviews` (
    `id` VARCHAR(30) NOT NULL,
    `task_id` VARCHAR(30) NOT NULL,
    `round_number` INTEGER NOT NULL DEFAULT 1,
    `reviewer_id` VARCHAR(30) NULL,
    `submitter_id` VARCHAR(30) NOT NULL,
    `outcome` ENUM('PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `feedback` TEXT NULL,
    `rating` SMALLINT NULL,
    `submission_notes` TEXT NULL,
    `submitted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reviewed_at` DATETIME(3) NULL,

    INDEX `idx_task_reviews_task_outcome`(`task_id`, `outcome`),
    INDEX `idx_task_reviews_reviewer_outcome`(`reviewer_id`, `outcome`),
    UNIQUE INDEX `uq_task_review_round`(`task_id`, `round_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_comments` (
    `id` VARCHAR(30) NOT NULL,
    `task_id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `parent_id` VARCHAR(30) NULL,
    `content` TEXT NOT NULL,
    `original_content` TEXT NULL,
    `is_edited` BOOLEAN NOT NULL DEFAULT false,
    `edited_at` DATETIME(3) NULL,
    `is_internal` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `deleted_by_id` VARCHAR(30) NULL,

    INDEX `idx_task_comments_task_created`(`task_id`, `created_at`),
    INDEX `idx_task_comments_parent`(`parent_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `task_reviews` ADD CONSTRAINT `task_reviews_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_reviews` ADD CONSTRAINT `task_reviews_reviewer_id_fkey` FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_reviews` ADD CONSTRAINT `task_reviews_submitter_id_fkey` FOREIGN KEY (`submitter_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_comments` ADD CONSTRAINT `task_comments_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_comments` ADD CONSTRAINT `task_comments_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_comments` ADD CONSTRAINT `task_comments_deleted_by_id_fkey` FOREIGN KEY (`deleted_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_comments` ADD CONSTRAINT `task_comments_parent_id_fkey` FOREIGN KEY (`parent_id`) REFERENCES `task_comments`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

