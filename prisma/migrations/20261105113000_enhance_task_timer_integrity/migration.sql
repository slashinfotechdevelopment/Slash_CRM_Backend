-- DropForeignKey
ALTER TABLE `task_time_pauses` DROP FOREIGN KEY `task_time_pauses_preceding_time_entry_id_fkey`;

-- DropForeignKey
ALTER TABLE `task_time_pauses` DROP FOREIGN KEY `task_time_pauses_following_time_entry_id_fkey`;

-- CreateIndex
CREATE UNIQUE INDEX `uq_task_time_entry_id_task_user` ON `task_time_entries`(`id`, `task_id`, `user_id`);

-- AddForeignKey (Composite foreign key guaranteeing preceding pause belongs to the same task and employee)
ALTER TABLE `task_time_pauses` ADD CONSTRAINT `task_time_pauses_preceding_time_entry_id_task_id_user_id_fkey` FOREIGN KEY (`preceding_time_entry_id`, `task_id`, `user_id`) REFERENCES `task_time_entries`(`id`, `task_id`, `user_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey (Composite foreign key guaranteeing following pause belongs to the same task and employee)
ALTER TABLE `task_time_pauses` ADD CONSTRAINT `task_time_pauses_following_time_entry_id_task_id_user_id_fkey` FOREIGN KEY (`following_time_entry_id`, `task_id`, `user_id`) REFERENCES `task_time_entries`(`id`, `task_id`, `user_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddCheckConstraints for non-negativity and temporal ordering
ALTER TABLE `task_time_entries` ADD CONSTRAINT `chk_time_entry_dates` CHECK (`ended_at` IS NULL OR `ended_at` >= `started_at`);
ALTER TABLE `task_time_entries` ADD CONSTRAINT `chk_time_entry_duration` CHECK (`duration_seconds` >= 0);

ALTER TABLE `task_time_pauses` ADD CONSTRAINT `chk_pause_dates` CHECK (`resumed_at` IS NULL OR `resumed_at` >= `paused_at`);
ALTER TABLE `task_time_pauses` ADD CONSTRAINT `chk_pause_duration` CHECK (`pause_duration_seconds` >= 0);

-- Trigger: trg_task_time_pause_before_insert
DROP TRIGGER IF EXISTS `trg_task_time_pause_before_insert`;
CREATE TRIGGER `trg_task_time_pause_before_insert`
BEFORE INSERT ON `task_time_pauses`
FOR EACH ROW
BEGIN
  DECLARE prec_ended_at DATETIME;
  
  IF NEW.preceding_time_entry_id IS NOT NULL THEN
    SELECT ended_at INTO prec_ended_at
    FROM task_time_entries
    WHERE id = NEW.preceding_time_entry_id;

    IF prec_ended_at IS NULL THEN
      SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Integrity violation: Preceding work entry must be closed before pause begins';
    END IF;

    IF NEW.paused_at < prec_ended_at THEN
      SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Integrity violation: Pause cannot begin before preceding work entry ended';
    END IF;
  END IF;

  IF NEW.resumed_at IS NOT NULL AND NEW.resumed_at < NEW.paused_at THEN
    SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'Integrity violation: Resume timestamp cannot be earlier than pause timestamp';
  END IF;
END;

-- Trigger: trg_task_time_pause_before_update
DROP TRIGGER IF EXISTS `trg_task_time_pause_before_update`;
CREATE TRIGGER `trg_task_time_pause_before_update`
BEFORE UPDATE ON `task_time_pauses`
FOR EACH ROW
BEGIN
  DECLARE foll_started_at DATETIME;
  
  IF NEW.resumed_at IS NOT NULL AND NEW.resumed_at < NEW.paused_at THEN
    SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'Integrity violation: Resume timestamp cannot be earlier than pause timestamp';
  END IF;

  IF NEW.following_time_entry_id IS NOT NULL THEN
    SELECT started_at INTO foll_started_at
    FROM task_time_entries
    WHERE id = NEW.following_time_entry_id;

    IF foll_started_at IS NOT NULL AND NEW.resumed_at IS NOT NULL AND foll_started_at < NEW.resumed_at THEN
      SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Integrity violation: Following work entry cannot start before pause ended';
    END IF;
  END IF;
END;

