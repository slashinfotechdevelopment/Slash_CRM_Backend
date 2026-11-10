-- CreateTable: lead_code_sequences
CREATE TABLE `lead_code_sequences` (
    `id` VARCHAR(30) NOT NULL,
    `prefix` VARCHAR(10) NOT NULL,
    `last_number` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `lead_code_sequences_prefix_key`(`prefix`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: pipeline_stages
CREATE TABLE `pipeline_stages` (
    `id` VARCHAR(30) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `order` INTEGER NOT NULL DEFAULT 0,
    `color` VARCHAR(20) NULL,
    `is_default` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `pipeline_stages_code_key`(`code`),
    INDEX `pipeline_stages_order_idx`(`order`),
    INDEX `pipeline_stages_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: leads
CREATE TABLE `leads` (
    `id` VARCHAR(30) NOT NULL,
    `lead_code` VARCHAR(20) NOT NULL,
    `lead_date` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lead_name` VARCHAR(150) NOT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `normalized_phone` VARCHAR(20) NOT NULL,
    `active_normalized_phone` VARCHAR(20) GENERATED ALWAYS AS (CASE WHEN `deleted_at` IS NULL THEN `normalized_phone` ELSE NULL END) VIRTUAL,
    `alternate_phone` VARCHAR(20) NULL,
    `email` VARCHAR(150) NULL,
    `company_name` VARCHAR(150) NULL,
    `job_title` VARCHAR(100) NULL,
    `website` VARCHAR(255) NULL,
    `interested_course` VARCHAR(150) NULL,
    `industry` VARCHAR(100) NULL,
    `location` VARCHAR(150) NULL,
    `address` TEXT NULL,
    `city` VARCHAR(100) NULL,
    `state` VARCHAR(100) NULL,
    `country` VARCHAR(100) NULL,
    `pincode` VARCHAR(20) NULL,
    `requirement_description` TEXT NULL,
    `estimated_value` DECIMAL(12, 2) NULL,
    `currency` VARCHAR(10) NULL DEFAULT 'INR',
    `expected_closing_date` DATE NULL,
    `feedback1` TEXT NULL,
    `feedback2` TEXT NULL,
    `feedback3` TEXT NULL,
    `source` ENUM('MANUAL', 'WEBSITE', 'EXCEL_IMPORT', 'CSV_IMPORT') NOT NULL DEFAULT 'MANUAL',
    `source_details` VARCHAR(255) NULL,
    `campaign_name` VARCHAR(150) NULL,
    `created_by_id` VARCHAR(30) NOT NULL,
    `department_id` VARCHAR(30) NULL,
    `assigned_to_id` VARCHAR(30) NULL,
    `assigned_by_id` VARCHAR(30) NULL,
    `assigned_at` DATETIME(3) NULL,
    `priority` ENUM('LOW', 'MEDIUM', 'HIGH', 'URGENT') NOT NULL DEFAULT 'MEDIUM',
    `status` ENUM('NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED', 'LOST') NOT NULL DEFAULT 'NEW',
    `qualification_status` ENUM('PENDING', 'QUALIFIED', 'UNQUALIFIED') NOT NULL DEFAULT 'PENDING',
    `pipeline_stage_id` VARCHAR(30) NULL,
    `unqualified_reason` VARCHAR(255) NULL,
    `lost_reason` VARCHAR(255) NULL,
    `last_contacted_at` DATETIME(3) NULL,
    `last_activity_at` DATETIME(3) NULL,
    `converted_at` DATETIME(3) NULL,
    `converted_by_id` VARCHAR(30) NULL,
    `deleted_by_id` VARCHAR(30) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `leads_lead_code_key`(`lead_code`),
    UNIQUE INDEX `uq_active_lead_normalized_phone`(`active_normalized_phone`),
    INDEX `leads_status_priority_idx`(`status`, `priority`),
    INDEX `leads_created_by_id_idx`(`created_by_id`),
    INDEX `leads_assigned_to_id_idx`(`assigned_to_id`),
    INDEX `leads_department_id_idx`(`department_id`),
    INDEX `leads_normalized_phone_idx`(`normalized_phone`),
    INDEX `leads_deleted_at_idx`(`deleted_at`),
    INDEX `leads_lead_date_idx`(`lead_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: lead_activities
CREATE TABLE `lead_activities` (
    `id` VARCHAR(30) NOT NULL,
    `lead_id` VARCHAR(30) NOT NULL,
    `actor_id` VARCHAR(30) NULL,
    `type` ENUM('NOTE', 'CALL', 'MEETING', 'EMAIL', 'STATUS_CHANGE', 'ASSIGNMENT', 'QUALIFICATION') NOT NULL DEFAULT 'NOTE',
    `title` VARCHAR(150) NOT NULL,
    `description` TEXT NULL,
    `metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `lead_activities_lead_id_created_at_idx`(`lead_id`, `created_at`),
    INDEX `lead_activities_actor_id_idx`(`actor_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: lead_follow_ups
CREATE TABLE `lead_follow_ups` (
    `id` VARCHAR(30) NOT NULL,
    `lead_id` VARCHAR(30) NOT NULL,
    `created_by_id` VARCHAR(30) NOT NULL,
    `assigned_to_id` VARCHAR(30) NOT NULL,
    `scheduled_at` DATETIME(3) NOT NULL,
    `status` ENUM('PENDING', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `note` TEXT NULL,
    `completed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `lead_follow_ups_lead_id_status_idx`(`lead_id`, `status`),
    INDEX `lead_follow_ups_assigned_to_id_scheduled_at_status_idx`(`assigned_to_id`, `scheduled_at`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKeys: leads
ALTER TABLE `leads` ADD CONSTRAINT `leads_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `leads` ADD CONSTRAINT `leads_department_id_fkey` FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `leads` ADD CONSTRAINT `leads_assigned_to_id_fkey` FOREIGN KEY (`assigned_to_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `leads` ADD CONSTRAINT `leads_assigned_by_id_fkey` FOREIGN KEY (`assigned_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `leads` ADD CONSTRAINT `leads_converted_by_id_fkey` FOREIGN KEY (`converted_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `leads` ADD CONSTRAINT `leads_deleted_by_id_fkey` FOREIGN KEY (`deleted_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `leads` ADD CONSTRAINT `leads_pipeline_stage_id_fkey` FOREIGN KEY (`pipeline_stage_id`) REFERENCES `pipeline_stages`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKeys: lead_activities
ALTER TABLE `lead_activities` ADD CONSTRAINT `lead_activities_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `lead_activities` ADD CONSTRAINT `lead_activities_actor_id_fkey` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKeys: lead_follow_ups
ALTER TABLE `lead_follow_ups` ADD CONSTRAINT `lead_follow_ups_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `lead_follow_ups` ADD CONSTRAINT `lead_follow_ups_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `lead_follow_ups` ADD CONSTRAINT `lead_follow_ups_assigned_to_id_fkey` FOREIGN KEY (`assigned_to_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed Default Pipeline Stages (Idempotent)
INSERT INTO `pipeline_stages` (`id`, `code`, `name`, `order`, `color`, `is_default`, `status`, `created_at`, `updated_at`)
VALUES 
('ps_stage_01_new', 'NEW', 'New Lead', 1, '#3B82F6', true, 'ACTIVE', NOW(3), NOW(3)),
('ps_stage_02_contacted', 'CONTACTED', 'Contacted', 2, '#8B5CF6', false, 'ACTIVE', NOW(3), NOW(3)),
('ps_stage_03_qualified', 'QUALIFIED', 'Qualified', 3, '#06B6D4', false, 'ACTIVE', NOW(3), NOW(3)),
('ps_stage_04_proposal', 'PROPOSAL_SENT', 'Proposal Sent', 4, '#F59E0B', false, 'ACTIVE', NOW(3), NOW(3)),
('ps_stage_05_converted', 'CONVERTED', 'Converted', 5, '#10B981', false, 'ACTIVE', NOW(3), NOW(3)),
('ps_stage_06_lost', 'LOST', 'Lost', 6, '#EF4444', false, 'ACTIVE', NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE `updated_at` = NOW(3);

-- Register Missing Permissions (Idempotent)
INSERT INTO `permissions` (`id`, `code`, `name`, `module`, `action`, `description`, `status`, `created_at`, `updated_at`)
SELECT 'cmw0k4pif000ys4uz8restore1', 'leads.restore', 'leads restore', 'leads', 'restore', 'Restore soft-deleted leads', 'ACTIVE', NOW(3), NOW(3)
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `code` = 'leads.restore');

INSERT INTO `permissions` (`id`, `code`, `name`, `module`, `action`, `description`, `status`, `created_at`, `updated_at`)
SELECT 'cmw0k4pif000ys4uz8export1', 'leads.export', 'leads export', 'leads', 'export', 'Export leads data to CSV/Excel', 'ACTIVE', NOW(3), NOW(3)
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `code` = 'leads.export');

INSERT INTO `permissions` (`id`, `code`, `name`, `module`, `action`, `description`, `status`, `created_at`, `updated_at`)
SELECT 'cmw0k4pif000ys4uz8import1', 'leads.import', 'leads import', 'leads', 'import', 'Import leads from CSV/Excel', 'ACTIVE', NOW(3), NOW(3)
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `code` = 'leads.import');

-- Assign Permissions to SUPER_ADMIN (ALL scope)
INSERT INTO `role_permissions` (`role_id`, `permission_id`, `data_scope`, `assigned_at`)
SELECT r.`id`, p.`id`, 'ALL', NOW(3)
FROM `roles` r, `permissions` p
WHERE r.`code` = 'SUPER_ADMIN' AND p.`code` IN ('leads.restore', 'leads.export', 'leads.import')
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp 
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Assign Permissions to ADMIN (ALL scope)
INSERT INTO `role_permissions` (`role_id`, `permission_id`, `data_scope`, `assigned_at`)
SELECT r.`id`, p.`id`, 'ALL', NOW(3)
FROM `roles` r, `permissions` p
WHERE r.`code` = 'ADMIN' AND p.`code` IN ('leads.restore', 'leads.export', 'leads.import')
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp 
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Assign Export / Import to SALES (OWN scope)
INSERT INTO `role_permissions` (`role_id`, `permission_id`, `data_scope`, `assigned_at`)
SELECT r.`id`, p.`id`, 'OWN', NOW(3)
FROM `roles` r, `permissions` p
WHERE r.`code` = 'SALES' AND p.`code` IN ('leads.export', 'leads.import')
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp 
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );
