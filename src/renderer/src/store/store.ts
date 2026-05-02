/**
 * Top-level renderer store. Holds UI-relevant slices of app state and
 * subscribes to main-process push events on boot.
 */
import { create } from 'zustand';
import type {
  Meeting,
  Settings,
  CalendarEvent,
  ActionItem,
  Person,
  Company,
  Project,
  Folder,
  Template,
  AutomationRule,
  DetectedMeeting,
  GeneratedNote,
} from '@shared/types/entities';

export interface ToastMsg {
  id: string;
  kind: string;
  title: string;
  body?: string;
  meetingId?: string;
}

export interface SyncStatusMsg {
  meetingId: string;
  status: string;
  error?: string;
}

interface StoreState {
  booted: boolean;
  bootError: string | null;

  meetings: Meeting[];
  notesByMeeting: Record<string, GeneratedNote | null>;
  activeMeetingId: string | null;
  detection: DetectedMeeting | null;

  settings: Settings | null;
  upcoming: CalendarEvent[];
  actionItems: ActionItem[];
  people: Person[];
  companies: Company[];
  projects: Project[];
  folders: Folder[];
  templates: Template[];
  automations: AutomationRule[];

  toasts: ToastMsg[];
  syncStatuses: Record<string, SyncStatusMsg>;

  paletteOpen: boolean;

  actions: {
    boot(): Promise<void>;
    refreshMeetings(): Promise<void>;
    refreshActionItems(): Promise<void>;
    refreshUpcoming(): Promise<void>;
    refreshSettings(): Promise<void>;
    refreshPeople(): Promise<void>;
    refreshCompanies(): Promise<void>;
    refreshProjects(): Promise<void>;
    refreshFolders(): Promise<void>;
    refreshTemplates(): Promise<void>;
    refreshAutomations(): Promise<void>;
    setActiveMeeting(id: string | null): void;
    upsertMeeting(m: Meeting): void;
    setNote(meetingId: string, n: GeneratedNote | null): void;
    pushToast(t: Omit<ToastMsg, 'id'>): void;
    dismissToast(id: string): void;
    togglePalette(open?: boolean): void;
  };
}

let unsubs: Array<() => void> = [];

export const useStore = create<StoreState>((set, get) => ({
  booted: false,
  bootError: null,

  meetings: [],
  notesByMeeting: {},
  activeMeetingId: null,
  detection: null,

  settings: null,
  upcoming: [],
  actionItems: [],
  people: [],
  companies: [],
  projects: [],
  folders: [],
  templates: [],
  automations: [],

  toasts: [],
  syncStatuses: {},

  paletteOpen: false,

  actions: {
    async boot() {
      try {
        // Tear down any previous subscriptions in case of HMR.
        unsubs.forEach((fn) => fn());
        unsubs = [];

        const api = window.api;
        if (!api) {
          set({ booted: true, bootError: 'window.api unavailable' });
          return;
        }

        await api.app.ready();

        // Initial data — kick off in parallel, tolerate failures.
        const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
          try {
            return await p;
          } catch {
            return fallback;
          }
        };

        const [
          settings,
          meetings,
          actionItems,
          upcoming,
          people,
          companies,
          projects,
          folders,
          templates,
          automations,
          detection,
        ] = await Promise.all([
          safe(api.settings.get(), null as Settings | null),
          safe(api.meetings.list(), [] as Meeting[]),
          safe(api.actionItems.list(), [] as ActionItem[]),
          safe(api.calendar.upcoming(), [] as CalendarEvent[]),
          safe(api.people.list(), [] as Person[]),
          safe(api.companies.list(), [] as Company[]),
          safe(api.projects.list(), [] as Project[]),
          safe(api.folders.list(), [] as Folder[]),
          safe(api.templates.list(), [] as Template[]),
          safe(api.automations.list(), [] as AutomationRule[]),
          safe(api.detection.current(), null as DetectedMeeting | null),
        ]);

        set({
          settings,
          meetings,
          actionItems,
          upcoming,
          people,
          companies,
          projects,
          folders,
          templates,
          automations,
          detection,
          booted: true,
          bootError: null,
        });

        // Subscriptions
        unsubs.push(
          api.events.onMeetingDetected((d) => set({ detection: d })),
          api.events.onMeetingUpdated((m) => {
            const cur = get().meetings;
            const idx = cur.findIndex((x) => x.id === m.id);
            const next = idx === -1 ? [m, ...cur] : cur.map((x) => (x.id === m.id ? m : x));
            set({ meetings: next });
          }),
          api.events.onNoteUpdated((n) => {
            set({ notesByMeeting: { ...get().notesByMeeting, [n.meeting_id]: n } });
          }),
          api.events.onSyncStatus((s) => {
            set({ syncStatuses: { ...get().syncStatuses, [s.meetingId]: s } });
          }),
          api.events.onNotification((n) => {
            const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const toast: ToastMsg = { id, ...n };
            set({ toasts: [...get().toasts, toast] });
            // Auto-dismiss after 5s
            setTimeout(() => {
              set({ toasts: get().toasts.filter((t) => t.id !== id) });
            }, 5000);
          }),
          api.events.onSettingsChanged((s) => set({ settings: s })),
        );
      } catch (err) {
        set({ booted: true, bootError: String(err) });
      }
    },

    async refreshMeetings() {
      try {
        const meetings = await window.api.meetings.list();
        set({ meetings });
      } catch {
        /* noop */
      }
    },

    async refreshActionItems() {
      try {
        const actionItems = await window.api.actionItems.list();
        set({ actionItems });
      } catch {
        /* noop */
      }
    },

    async refreshUpcoming() {
      try {
        const upcoming = await window.api.calendar.upcoming();
        set({ upcoming });
      } catch {
        /* noop */
      }
    },

    async refreshSettings() {
      try {
        const settings = await window.api.settings.get();
        set({ settings });
      } catch {
        /* noop */
      }
    },

    async refreshPeople() {
      try {
        set({ people: await window.api.people.list() });
      } catch {
        /* noop */
      }
    },
    async refreshCompanies() {
      try {
        set({ companies: await window.api.companies.list() });
      } catch {
        /* noop */
      }
    },
    async refreshProjects() {
      try {
        set({ projects: await window.api.projects.list() });
      } catch {
        /* noop */
      }
    },
    async refreshFolders() {
      try {
        set({ folders: await window.api.folders.list() });
      } catch {
        /* noop */
      }
    },
    async refreshTemplates() {
      try {
        set({ templates: await window.api.templates.list() });
      } catch {
        /* noop */
      }
    },
    async refreshAutomations() {
      try {
        set({ automations: await window.api.automations.list() });
      } catch {
        /* noop */
      }
    },

    setActiveMeeting(id) {
      set({ activeMeetingId: id });
    },

    upsertMeeting(m) {
      const cur = get().meetings;
      const idx = cur.findIndex((x) => x.id === m.id);
      const next = idx === -1 ? [m, ...cur] : cur.map((x) => (x.id === m.id ? m : x));
      set({ meetings: next });
    },

    setNote(meetingId, n) {
      set({ notesByMeeting: { ...get().notesByMeeting, [meetingId]: n } });
    },

    pushToast(t) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set({ toasts: [...get().toasts, { id, ...t }] });
      setTimeout(() => {
        set({ toasts: get().toasts.filter((x) => x.id !== id) });
      }, 5000);
    },

    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },

    togglePalette(open) {
      set({ paletteOpen: open ?? !get().paletteOpen });
    },
  },
}));

export function useActions() {
  return useStore((s) => s.actions);
}
