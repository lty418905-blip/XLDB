import type {BackupExtension} from '../../../shared/src/scene/backup.ts';
import {ensureUserModelSchema} from '../user-model/schema.ts';
import {CompanionStore,driveMarkerId} from './store.ts';
import {RelationshipAssessmentStore} from './relationship-assessment.ts';

/**
 * The companion tables of an Agent database for backup restore: their schema (created and migrated in the restored
 * copy) and the drive-marker occurrence id. The capture and merge of their user controls stay generic in
 * shared/src/scene/backup.ts. tools/backup.mjs loads this file only when the package contains it.
 */
export const companionBackupExtension:BackupExtension={
  ensureSchema(db){
    ensureUserModelSchema(db);
    new CompanionStore(db);
    new RelationshipAssessmentStore(db);
  },
  driveMarkerId,
};
