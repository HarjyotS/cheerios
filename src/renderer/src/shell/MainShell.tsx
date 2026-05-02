/**
 * Main shell — sidebar + content. Boots the store on mount.
 */
import { useEffect } from 'react';
import { useRoute } from '../lib/router';
import { useStore } from '../store/store';
import { attachGlobalTranscriptSubscription } from '../store/transcript-store';
import { Sidebar } from './Sidebar';
import { CommandPalette } from '../components/CommandPalette';
import { Toasts } from '../components/Toasts';
import { LiveBanner } from '../components/LiveBanner';
import { SetupWizard } from '../components/SetupWizard';

import { TodayView } from '../views/TodayView';
import { NotesView } from '../views/NotesView';
import { audioController } from '../audio/AudioController';
import { navigate as navTo } from '../lib/router';
import { UpcomingView } from '../views/UpcomingView';
import { RecentNotesView } from '../views/RecentNotesView';
import { MeetingView } from '../views/MeetingView';
import { ActionItemsView } from '../views/ActionItemsView';
import { PeopleView } from '../views/PeopleView';
import { CompaniesView } from '../views/CompaniesView';
import { ProjectsView } from '../views/ProjectsView';
import { FoldersView } from '../views/FoldersView';
import { TemplatesView } from '../views/TemplatesView';
import { AutomationsView } from '../views/AutomationsView';
import { SearchView } from '../views/SearchView';
import { SettingsView } from '../views/SettingsView';
import { ChatView } from '../views/ChatView';

export function MainShell() {
  const route = useRoute();
  const booted = useStore((s) => s.booted);
  const bootError = useStore((s) => s.bootError);
  const settings = useStore((s) => s.settings);
  const actions = useStore((s) => s.actions);
  const togglePalette = useStore((s) => s.actions.togglePalette);

  useEffect(() => {
    actions.boot();
    const detach = attachGlobalTranscriptSubscription();
    return () => {
      detach();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.shiftKey && e.code === 'Space') {
        e.preventDefault();
        togglePalette();
      } else if (cmd && e.key === 'k') {
        e.preventDefault();
        togglePalette();
      } else if (cmd && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
        // Cmd+Shift+N → start a new quick note from anywhere.
        e.preventDefault();
        startNewQuickNote();
      } else if (e.key === 'Escape') {
        if (useStore.getState().paletteOpen) togglePalette(false);
      }
    };
    window.addEventListener('keydown', onKey);

    // Main process forwards globalShortcut events as IPC commands; the
    // renderer reacts to them too so menubar / tray clicks work.
    const offCmd = (() => {
      const listener = (_evt: unknown, _payload?: unknown) => startNewQuickNote();
      // electron's contextIsolation means we can't talk to ipcRenderer here,
      // so we rely on the keydown handler above for global Cmd+Shift+N.
      return () => undefined;
    })();

    return () => {
      window.removeEventListener('keydown', onKey);
      offCmd();
    };
  }, [togglePalette]);

  if (!booted) {
    return (
      <div className="shell-loading">
        <h1>Cherios</h1>
        <p>Booting...</p>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="shell-loading">
        <h1>Failed to start</h1>
        <p style={{ color: 'var(--danger)' }}>{bootError}</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="content">
        <LiveBanner />
        {settings && !settings.setup_completed
          ? <SetupWizard />
          : renderRoute(route.path, route.params, Boolean(settings?.advanced_labs_enabled))}
      </main>
      <CommandPalette />
      <Toasts />
    </div>
  );
}

/**
 * Create a meeting now and navigate into it. Used by Cmd+Shift+N.
 * The title is auto-generated; the user can rename it inline in the
 * meeting header.
 */
async function startNewQuickNote(): Promise<void> {
  try {
    await audioController.stopAnyActive();
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const date = now.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const m = await window.api.meetings.create({
      title: `Quick note · ${date}, ${time}`,
      source_app: 'unknown',
      privacy_mode: 'normal',
    });
    window.api.meetings.start(m.id).catch(() => undefined);
    audioController.startMicForMeeting(m.id).catch((err) => {
      console.warn('Mic start failed', err);
    });
    navTo('/meeting/' + m.id);
  } catch (err) {
    alert(`Couldn't start a meeting: ${(err as Error).message}`);
  }
}

function renderRoute(path: string, params: Record<string, string>, advanced: boolean) {
  const advancedRoutes = new Set([
    '/chat',
    '/templates',
    '/automations',
    '/people',
    '/people/:id',
    '/companies',
    '/companies/:id',
    '/projects',
    '/projects/:id',
    '/folders',
    '/recent',
  ]);
  if (!advanced && advancedRoutes.has(path)) return <TodayView />;

  switch (path) {
    case '/today':
      return <TodayView />;
    case '/upcoming':
      return <UpcomingView />;
    case '/notes':
      return <NotesView />;
    case '/notes/folder/:folderId':
      return <NotesView />;
    case '/recent':
      return <RecentNotesView />;
    case '/meeting/:id':
      return <MeetingView meetingId={params.id} />;
    case '/actions':
      return <ActionItemsView />;
    case '/people':
      return <PeopleView />;
    case '/people/:id':
      return <PeopleView selectedId={params.id} />;
    case '/companies':
      return <CompaniesView />;
    case '/companies/:id':
      return <CompaniesView selectedId={params.id} />;
    case '/projects':
      return <ProjectsView />;
    case '/projects/:id':
      return <ProjectsView selectedId={params.id} />;
    case '/folders':
      return <FoldersView />;
    case '/templates':
      return <TemplatesView />;
    case '/automations':
      return <AutomationsView />;
    case '/search':
      return <SearchView />;
    case '/chat':
      return <ChatView />;
    case '/settings':
      return <SettingsView />;
    default:
      return <TodayView />;
  }
}
