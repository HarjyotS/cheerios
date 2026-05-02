/**
 * Singletons created at startup. Services that don't need the registry can
 * just import each other directly; this object exists so that domains
 * with circular dependencies (detection ↔ deepgram ↔ meetings) can do
 * late lookups without import cycles.
 */
import type { DeepgramStreamingService } from '../services/deepgram/deepgram-service';
import type { AudioCaptureService } from '../services/audio/audio-capture';
import type { MeetingDetectionService } from '../services/detection/detection-service';
import type { MeetingStateDetector } from '../services/detection/meeting-state';
import type { AINoteEngine } from '../services/ai/note-engine';
import type { GoogleAuthManager } from '../services/google/auth';
import type { DriveSyncService } from '../services/drive/drive-service';
import type { GmailService } from '../services/gmail/gmail-service';
import type { CalendarService } from '../services/calendar/calendar-service';
import type { AutomationsEngine } from '../services/automations/engine';
import type { TemplatesService } from '../services/templates/templates-service';
import type { LocalApiServer } from '../services/api/local-api';
import type { McpServer } from '../services/mcp/mcp-server';
import type { NotificationsService } from '../services/notifications/notifications';
import type { ActionItemSyncService } from '../services/action-items/sync';
import type { RetentionService } from '../services/retention/retention';
import type { AppLockService } from '../services/security/app-lock';
import type { PrivacyModule } from '../services/privacy/privacy-service';

export interface Services {
  audio?: AudioCaptureService;
  deepgram?: DeepgramStreamingService;
  detection?: MeetingDetectionService;
  meetingState?: MeetingStateDetector;
  ai?: AINoteEngine;
  googleAuth?: GoogleAuthManager;
  drive?: DriveSyncService;
  gmail?: GmailService;
  calendar?: CalendarService;
  automations?: AutomationsEngine;
  templates?: TemplatesService;
  localApi?: LocalApiServer;
  mcp?: McpServer;
  notifications?: NotificationsService;
  actionItemSync?: ActionItemSyncService;
  retention?: RetentionService;
  appLock?: AppLockService;
  privacy?: PrivacyModule;
}

export const services: Services = {};
