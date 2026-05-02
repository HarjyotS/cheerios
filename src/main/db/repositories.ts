/**
 * Repositories — typed accessors for every entity. Encapsulate JSON
 * (de)serialization and FTS index upkeep so service code stays clean.
 */
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { getDb } from './index';
import type {
  Meeting,
  TranscriptChunk,
  GeneratedNote,
  ActionItem,
  Person,
  Company,
  Project,
  Folder,
  Template,
  AutomationRule,
  ChatThread,
  Integration,
  CalendarEvent,
  ID,
} from '@shared/types/entities';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${nanoid(12)}`;
const toJson = (v: unknown) => JSON.stringify(v ?? null);
const fromJson = <T>(v: string | null | undefined, fallback: T): T => {
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const bool = (v: number | null | undefined) => Boolean(v);

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
export const People = {
  list(): Person[] {
    return (getDb().prepare('SELECT * FROM people ORDER BY name').all() as any[]).map(rowToPerson);
  },
  get(id: ID): Person | null {
    const row = getDb().prepare('SELECT * FROM people WHERE id = ?').get(id) as any | undefined;
    return row ? rowToPerson(row) : null;
  },
  byEmail(email: string): Person | null {
    const row = getDb().prepare('SELECT * FROM people WHERE email = ?').get(email) as any | undefined;
    return row ? rowToPerson(row) : null;
  },
  upsert(input: Partial<Person> & { name: string }): Person {
    const d = getDb();
    if (input.id) {
      const existing = People.get(input.id);
      if (existing) {
        const merged = { ...existing, ...input, updated_at: now() };
        d.prepare(`UPDATE people SET name=@name, email=@email, company_id=@company_id, role=@role, relationship_type=@relationship_type, notes=@notes, ai_profile=@ai_profile, voice_embedding_id=@voice_embedding_id, updated_at=@updated_at WHERE id=@id`).run(merged);
        return merged;
      }
    }
    if (input.email) {
      const existing = People.byEmail(input.email);
      if (existing) {
        return People.upsert({ ...existing, ...input });
      }
    }
    const p: Person = {
      id: input.id ?? newId('per'),
      name: input.name,
      email: input.email,
      company_id: input.company_id ?? null,
      role: input.role,
      relationship_type: input.relationship_type,
      notes: input.notes,
      ai_profile: input.ai_profile,
      voice_embedding_id: input.voice_embedding_id ?? null,
      created_at: now(),
      updated_at: now(),
    };
    d.prepare(`INSERT INTO people (id, name, email, company_id, role, relationship_type, notes, ai_profile, voice_embedding_id, created_at, updated_at) VALUES (@id,@name,@email,@company_id,@role,@relationship_type,@notes,@ai_profile,@voice_embedding_id,@created_at,@updated_at)`).run(p);
    return p;
  },
  delete(id: ID) {
    getDb().prepare('DELETE FROM people WHERE id = ?').run(id);
  },
};

function rowToPerson(r: any): Person {
  return {
    id: r.id,
    name: r.name,
    email: r.email ?? undefined,
    company_id: r.company_id ?? null,
    role: r.role ?? undefined,
    relationship_type: r.relationship_type ?? undefined,
    notes: r.notes ?? undefined,
    ai_profile: r.ai_profile ?? undefined,
    voice_embedding_id: r.voice_embedding_id ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------
export const Companies = {
  list(): Company[] {
    return (getDb().prepare('SELECT * FROM companies ORDER BY name').all() as any[]).map(rowToCompany);
  },
  get(id: ID): Company | null {
    const r = getDb().prepare('SELECT * FROM companies WHERE id = ?').get(id) as any;
    return r ? rowToCompany(r) : null;
  },
  byDomain(domain: string): Company | null {
    const r = getDb().prepare('SELECT * FROM companies WHERE domain = ?').get(domain) as any;
    return r ? rowToCompany(r) : null;
  },
  upsert(input: Partial<Company> & { name: string }): Company {
    const d = getDb();
    if (input.id) {
      const existing = Companies.get(input.id);
      if (existing) {
        const merged = { ...existing, ...input, updated_at: now() };
        d.prepare(`UPDATE companies SET name=@name, domain=@domain, website=@website, notes=@notes, ai_profile=@ai_profile, drive_folder_id=@drive_folder_id, crm_link=@crm_link, updated_at=@updated_at WHERE id=@id`).run(merged);
        return merged;
      }
    }
    if (input.domain) {
      const existing = Companies.byDomain(input.domain);
      if (existing) return Companies.upsert({ ...existing, ...input });
    }
    const c: Company = {
      id: input.id ?? newId('co'),
      name: input.name,
      domain: input.domain,
      website: input.website,
      notes: input.notes,
      ai_profile: input.ai_profile,
      drive_folder_id: input.drive_folder_id ?? null,
      crm_link: input.crm_link ?? null,
      created_at: now(),
      updated_at: now(),
    };
    d.prepare(`INSERT INTO companies (id, name, domain, website, notes, ai_profile, drive_folder_id, crm_link, created_at, updated_at) VALUES (@id,@name,@domain,@website,@notes,@ai_profile,@drive_folder_id,@crm_link,@created_at,@updated_at)`).run(c);
    return c;
  },
  delete(id: ID) {
    getDb().prepare('DELETE FROM companies WHERE id = ?').run(id);
  },
};

function rowToCompany(r: any): Company {
  return {
    id: r.id,
    name: r.name,
    domain: r.domain ?? undefined,
    website: r.website ?? undefined,
    notes: r.notes ?? undefined,
    ai_profile: r.ai_profile ?? undefined,
    drive_folder_id: r.drive_folder_id ?? null,
    crm_link: r.crm_link ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Projects, Folders
// ---------------------------------------------------------------------------
export const Projects = {
  list(): Project[] {
    return (getDb().prepare('SELECT * FROM projects ORDER BY name').all() as any[]).map(rowToProject);
  },
  get(id: ID): Project | null {
    const r = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
    return r ? rowToProject(r) : null;
  },
  upsert(input: Partial<Project> & { name: string }): Project {
    const d = getDb();
    if (input.id) {
      const ex = Projects.get(input.id);
      if (ex) {
        const merged = { ...ex, ...input, updated_at: now() };
        d.prepare(`UPDATE projects SET name=@name, description=@description, drive_folder_id=@drive_folder_id, ai_summary=@ai_summary, updated_at=@updated_at WHERE id=@id`).run(merged);
        return merged;
      }
    }
    const p: Project = {
      id: input.id ?? newId('prj'),
      name: input.name,
      description: input.description,
      drive_folder_id: input.drive_folder_id ?? null,
      ai_summary: input.ai_summary,
      created_at: now(),
      updated_at: now(),
    };
    d.prepare(`INSERT INTO projects (id, name, description, drive_folder_id, ai_summary, created_at, updated_at) VALUES (@id,@name,@description,@drive_folder_id,@ai_summary,@created_at,@updated_at)`).run(p);
    return p;
  },
  delete(id: ID) {
    getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
  },
};

function rowToProject(r: any): Project {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    drive_folder_id: r.drive_folder_id ?? null,
    ai_summary: r.ai_summary ?? undefined,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export const Folders = {
  list(): Folder[] {
    return (getDb().prepare('SELECT * FROM folders ORDER BY name').all() as any[]).map(rowToFolder);
  },
  upsert(input: Partial<Folder> & { name: string }): Folder {
    const d = getDb();
    if (input.id) {
      const ex = (d.prepare('SELECT * FROM folders WHERE id=?').get(input.id) as any | undefined);
      if (ex) {
        const merged: Folder = { ...rowToFolder(ex), ...input, updated_at: now() };
        d.prepare(`UPDATE folders SET name=@name, parent_id=@parent_id, drive_folder_id=@drive_folder_id, updated_at=@updated_at WHERE id=@id`).run(merged);
        return merged;
      }
    }
    const f: Folder = {
      id: input.id ?? newId('fld'),
      name: input.name,
      parent_id: input.parent_id ?? null,
      drive_folder_id: input.drive_folder_id ?? null,
      created_at: now(),
      updated_at: now(),
    };
    d.prepare(`INSERT INTO folders (id, name, parent_id, drive_folder_id, created_at, updated_at) VALUES (@id,@name,@parent_id,@drive_folder_id,@created_at,@updated_at)`).run(f);
    return f;
  },
  delete(id: ID) {
    getDb().prepare('DELETE FROM folders WHERE id = ?').run(id);
  },
};

function rowToFolder(r: any): Folder {
  return {
    id: r.id,
    name: r.name,
    parent_id: r.parent_id ?? null,
    drive_folder_id: r.drive_folder_id ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
export const Templates = {
  list(): Template[] {
    return (getDb().prepare('SELECT * FROM templates ORDER BY builtin DESC, name').all() as any[]).map(rowToTemplate);
  },
  get(id: ID): Template | null {
    const r = getDb().prepare('SELECT * FROM templates WHERE id = ?').get(id) as any;
    return r ? rowToTemplate(r) : null;
  },
  byName(name: string): Template | null {
    const r = getDb().prepare('SELECT * FROM templates WHERE name = ?').get(name) as any;
    return r ? rowToTemplate(r) : null;
  },
  upsert(input: Partial<Template> & { name: string }): Template {
    const d = getDb();
    const existing = input.id ? Templates.get(input.id) : Templates.byName(input.name);
    if (existing) {
      const merged: Template = {
        ...existing,
        ...input,
        required_sections: input.required_sections ?? existing.required_sections,
        optional_sections: input.optional_sections ?? existing.optional_sections,
        auto_apply_rules: input.auto_apply_rules ?? existing.auto_apply_rules,
        updated_at: now(),
      };
      d.prepare(`UPDATE templates SET name=?, description=?, when_to_use=?, required_sections=?, optional_sections=?, formatting_rules=?, action_item_format=?, follow_up_style=?, drive_folder_path=?, auto_apply_rules=?, updated_at=? WHERE id=?`).run(
        merged.name, merged.description, merged.when_to_use,
        toJson(merged.required_sections), toJson(merged.optional_sections),
        merged.formatting_rules, merged.action_item_format, merged.follow_up_style,
        merged.drive_folder_path ?? null, toJson(merged.auto_apply_rules),
        merged.updated_at, merged.id,
      );
      return merged;
    }
    const t: Template = {
      id: input.id ?? newId('tpl'),
      name: input.name,
      description: input.description ?? '',
      when_to_use: input.when_to_use ?? '',
      required_sections: input.required_sections ?? [],
      optional_sections: input.optional_sections ?? [],
      formatting_rules: input.formatting_rules ?? '',
      action_item_format: input.action_item_format ?? '',
      follow_up_style: input.follow_up_style ?? '',
      drive_folder_path: input.drive_folder_path,
      auto_apply_rules: input.auto_apply_rules ?? [],
      builtin: false,
      created_at: now(),
      updated_at: now(),
    };
    d.prepare(`INSERT INTO templates (id, name, description, when_to_use, required_sections, optional_sections, formatting_rules, action_item_format, follow_up_style, drive_folder_path, auto_apply_rules, builtin, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      t.id, t.name, t.description, t.when_to_use,
      toJson(t.required_sections), toJson(t.optional_sections),
      t.formatting_rules, t.action_item_format, t.follow_up_style,
      t.drive_folder_path ?? null, toJson(t.auto_apply_rules),
      0, t.created_at, t.updated_at,
    );
    return t;
  },
  delete(id: ID) {
    getDb().prepare('DELETE FROM templates WHERE id = ? AND builtin = 0').run(id);
  },
};

function rowToTemplate(r: any): Template {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? '',
    when_to_use: r.when_to_use ?? '',
    required_sections: fromJson(r.required_sections, []),
    optional_sections: fromJson(r.optional_sections, []),
    formatting_rules: r.formatting_rules ?? '',
    action_item_format: r.action_item_format ?? '',
    follow_up_style: r.follow_up_style ?? '',
    drive_folder_path: r.drive_folder_path ?? undefined,
    auto_apply_rules: fromJson(r.auto_apply_rules, []),
    builtin: bool(r.builtin),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Calendar events
// ---------------------------------------------------------------------------
export const CalendarEvents = {
  upsert(e: Partial<CalendarEvent> & { provider: CalendarEvent['provider']; external_id: string; title: string; starts_at: string; ends_at: string }): CalendarEvent {
    const d = getDb();
    const existing = d.prepare('SELECT * FROM calendar_events WHERE provider = ? AND external_id = ?').get(e.provider, e.external_id) as any | undefined;
    if (existing) {
      const merged: CalendarEvent = { ...rowToCalendar(existing), ...e, updated_at: now() };
      d.prepare(`UPDATE calendar_events SET title=?, description=?, starts_at=?, ends_at=?, attendees=?, meeting_link=?, meeting_app_hint=?, recurring_id=?, updated_at=? WHERE id=?`).run(
        merged.title, merged.description ?? null, merged.starts_at, merged.ends_at,
        toJson(merged.attendees), merged.meeting_link ?? null, merged.meeting_app_hint ?? null, merged.recurring_id ?? null,
        merged.updated_at, merged.id,
      );
      return merged;
    }
    const ev: CalendarEvent = {
      id: newId('evt'),
      external_id: e.external_id,
      provider: e.provider,
      title: e.title,
      description: e.description,
      starts_at: e.starts_at,
      ends_at: e.ends_at,
      attendees: e.attendees ?? [],
      meeting_link: e.meeting_link,
      meeting_app_hint: e.meeting_app_hint,
      recurring_id: e.recurring_id,
      created_at: now(),
      updated_at: now(),
    };
    d.prepare(`INSERT INTO calendar_events (id, external_id, provider, title, description, starts_at, ends_at, attendees, meeting_link, meeting_app_hint, recurring_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      ev.id, ev.external_id, ev.provider, ev.title, ev.description ?? null, ev.starts_at, ev.ends_at,
      toJson(ev.attendees), ev.meeting_link ?? null, ev.meeting_app_hint ?? null, ev.recurring_id ?? null,
      ev.created_at, ev.updated_at,
    );
    return ev;
  },
  upcoming(limit = 25): CalendarEvent[] {
    const d = getDb();
    return (d.prepare(`SELECT * FROM calendar_events WHERE ends_at >= ? ORDER BY starts_at LIMIT ?`).all(now(), limit) as any[]).map(rowToCalendar);
  },
  forNow(): CalendarEvent | null {
    const t = now();
    const r = getDb().prepare(`SELECT * FROM calendar_events WHERE starts_at <= ? AND ends_at >= ? ORDER BY starts_at DESC LIMIT 1`).get(t, t) as any;
    return r ? rowToCalendar(r) : null;
  },
  byExternalId(provider: string, externalId: string): CalendarEvent | null {
    const r = getDb().prepare('SELECT * FROM calendar_events WHERE provider=? AND external_id=?').get(provider, externalId) as any;
    return r ? rowToCalendar(r) : null;
  },
};

function rowToCalendar(r: any): CalendarEvent {
  return {
    id: r.id,
    external_id: r.external_id,
    provider: r.provider,
    title: r.title,
    description: r.description ?? undefined,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    attendees: fromJson(r.attendees, []),
    meeting_link: r.meeting_link ?? undefined,
    meeting_app_hint: r.meeting_app_hint ?? undefined,
    recurring_id: r.recurring_id ?? undefined,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------
export const Meetings = {
  list(filter: { from?: string; to?: string; project_id?: ID; person_id?: ID; company_id?: ID } = {}): Meeting[] {
    const d = getDb();
    let sql = 'SELECT m.* FROM meetings m';
    const params: any[] = [];
    const where: string[] = [];
    if (filter.project_id) {
      sql += ' JOIN meeting_projects mp ON mp.meeting_id = m.id';
      where.push('mp.project_id = ?');
      params.push(filter.project_id);
    }
    if (filter.person_id) {
      sql += ' JOIN meeting_attendees ma ON ma.meeting_id = m.id';
      where.push('ma.person_id = ?');
      params.push(filter.person_id);
    }
    if (filter.company_id) {
      sql += ' JOIN meeting_companies mc ON mc.meeting_id = m.id';
      where.push('mc.company_id = ?');
      params.push(filter.company_id);
    }
    if (filter.from) { where.push('m.started_at >= ?'); params.push(filter.from); }
    if (filter.to)   { where.push('m.started_at <= ?'); params.push(filter.to); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY m.started_at DESC';
    const rows = d.prepare(sql).all(...params) as any[];
    return rows.map((r) => hydrateMeeting(r));
  },
  get(id: ID): Meeting | null {
    const r = getDb().prepare('SELECT * FROM meetings WHERE id = ?').get(id) as any;
    return r ? hydrateMeeting(r) : null;
  },
  create(input: Partial<Meeting> & { title: string }): Meeting {
    const d = getDb();
    const m: Meeting = {
      id: input.id ?? newId('mtg'),
      title: input.title,
      source_app: input.source_app ?? 'unknown',
      calendar_event_id: input.calendar_event_id ?? null,
      started_at: input.started_at ?? now(),
      ended_at: input.ended_at ?? null,
      attendees: input.attendees ?? [],
      project_ids: input.project_ids ?? [],
      company_ids: input.company_ids ?? [],
      template_id: input.template_id ?? null,
      privacy_mode: input.privacy_mode ?? 'normal',
      drive_sync_status: input.drive_sync_status ?? 'not_synced',
      drive_file_ids: input.drive_file_ids ?? {},
      detection_confidence: input.detection_confidence,
      language: input.language,
      raw_notes: input.raw_notes ?? '',
      title_is_auto: input.title_is_auto ?? true,
      folder_id: input.folder_id ?? null,
      created_at: now(),
      updated_at: now(),
    };
    d.prepare(`INSERT INTO meetings (id, title, source_app, calendar_event_id, started_at, ended_at, template_id, privacy_mode, drive_sync_status, drive_file_ids, detection_confidence, language, raw_notes, title_is_auto, folder_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      m.id, m.title, m.source_app, m.calendar_event_id, m.started_at, m.ended_at,
      m.template_id, m.privacy_mode, m.drive_sync_status, toJson(m.drive_file_ids),
      m.detection_confidence ?? null, m.language ?? null, m.raw_notes ?? '',
      (m.title_is_auto ?? true) ? 1 : 0,
      m.folder_id ?? null,
      m.created_at, m.updated_at,
    );
    Meetings.setAttendees(m.id, m.attendees);
    Meetings.setProjects(m.id, m.project_ids);
    Meetings.setCompanies(m.id, m.company_ids);
    Meetings.indexFts(m);
    return m;
  },
  update(id: ID, patch: Partial<Meeting>): Meeting {
    const d = getDb();
    const existing = Meetings.get(id);
    if (!existing) throw new Error('Meeting not found: ' + id);
    const merged: Meeting = { ...existing, ...patch, updated_at: now() };
    d.prepare(`UPDATE meetings SET title=?, source_app=?, calendar_event_id=?, started_at=?, ended_at=?, template_id=?, privacy_mode=?, drive_sync_status=?, drive_file_ids=?, detection_confidence=?, language=?, raw_notes=?, title_is_auto=?, folder_id=?, updated_at=? WHERE id=?`).run(
      merged.title, merged.source_app, merged.calendar_event_id, merged.started_at, merged.ended_at,
      merged.template_id, merged.privacy_mode, merged.drive_sync_status, toJson(merged.drive_file_ids),
      merged.detection_confidence ?? null, merged.language ?? null, merged.raw_notes ?? '',
      (merged.title_is_auto ?? true) ? 1 : 0,
      merged.folder_id ?? null,
      merged.updated_at, id,
    );
    if (patch.attendees) Meetings.setAttendees(id, patch.attendees);
    if (patch.project_ids) Meetings.setProjects(id, patch.project_ids);
    if (patch.company_ids) Meetings.setCompanies(id, patch.company_ids);
    Meetings.indexFts(merged);
    return merged;
  },
  delete(id: ID) {
    const d = getDb();
    d.prepare('DELETE FROM meetings WHERE id = ?').run(id);
    d.prepare('DELETE FROM meetings_fts WHERE rowid = ?').run(hashStringToInt(id));
  },
  setAttendees(meetingId: ID, personIds: ID[]) {
    const d = getDb();
    const tx = d.transaction(() => {
      d.prepare('DELETE FROM meeting_attendees WHERE meeting_id = ?').run(meetingId);
      const ins = d.prepare('INSERT OR IGNORE INTO meeting_attendees (meeting_id, person_id) VALUES (?,?)');
      for (const pid of personIds) ins.run(meetingId, pid);
    });
    tx();
  },
  setProjects(meetingId: ID, projectIds: ID[]) {
    const d = getDb();
    const tx = d.transaction(() => {
      d.prepare('DELETE FROM meeting_projects WHERE meeting_id = ?').run(meetingId);
      const ins = d.prepare('INSERT OR IGNORE INTO meeting_projects (meeting_id, project_id) VALUES (?,?)');
      for (const pid of projectIds) ins.run(meetingId, pid);
    });
    tx();
  },
  setCompanies(meetingId: ID, companyIds: ID[]) {
    const d = getDb();
    const tx = d.transaction(() => {
      d.prepare('DELETE FROM meeting_companies WHERE meeting_id = ?').run(meetingId);
      const ins = d.prepare('INSERT OR IGNORE INTO meeting_companies (meeting_id, company_id) VALUES (?,?)');
      for (const cid of companyIds) ins.run(meetingId, cid);
    });
    tx();
  },
  indexFts(m: Meeting) {
    const d = getDb();
    const note = GeneratedNotes.get(m.id);
    const summary = note?.summary ?? '';
    const rowid = hashStringToInt(m.id);
    // Replace the existing row by rowid — FTS has no 'id' column to MATCH.
    d.prepare('DELETE FROM meetings_fts WHERE rowid = ?').run(rowid);
    d.prepare(`INSERT INTO meetings_fts(rowid, title, raw_notes, summary) VALUES (?,?,?,?)`).run(
      rowid, m.title, m.raw_notes ?? '', summary,
    );
  },
  search(q: string, limit = 25): Array<{ meeting: Meeting; snippet: string }> {
    const d = getDb();
    const rows = d.prepare(`SELECT rowid, snippet(meetings_fts, -1, '<b>', '</b>', '…', 10) AS snippet FROM meetings_fts WHERE meetings_fts MATCH ? LIMIT ?`).all(q, limit) as any[];
    const out: Array<{ meeting: Meeting; snippet: string }> = [];
    for (const r of rows) {
      // Reverse mapping: scan meetings table by id hash collision is possible but tolerable for personal use.
      // We instead store id in the FTS title field is impractical. Use the meetings table directly:
      const all = d.prepare('SELECT * FROM meetings').all() as any[];
      for (const m of all) {
        if (hashStringToInt(m.id) === r.rowid) {
          out.push({ meeting: hydrateMeeting(m), snippet: r.snippet });
          break;
        }
      }
    }
    return out;
  },
};

function hydrateMeeting(r: any): Meeting {
  const d = getDb();
  const attendees = (d.prepare('SELECT person_id FROM meeting_attendees WHERE meeting_id = ?').all(r.id) as any[]).map((x) => x.person_id);
  const projects = (d.prepare('SELECT project_id FROM meeting_projects WHERE meeting_id = ?').all(r.id) as any[]).map((x) => x.project_id);
  const companies = (d.prepare('SELECT company_id FROM meeting_companies WHERE meeting_id = ?').all(r.id) as any[]).map((x) => x.company_id);
  return {
    id: r.id,
    title: r.title,
    source_app: r.source_app,
    calendar_event_id: r.calendar_event_id ?? null,
    started_at: r.started_at,
    ended_at: r.ended_at ?? null,
    attendees,
    project_ids: projects,
    company_ids: companies,
    template_id: r.template_id ?? null,
    privacy_mode: r.privacy_mode,
    drive_sync_status: r.drive_sync_status,
    drive_file_ids: fromJson(r.drive_file_ids, {}),
    detection_confidence: r.detection_confidence ?? undefined,
    language: r.language ?? undefined,
    raw_notes: r.raw_notes ?? '',
    title_is_auto: r.title_is_auto == null ? true : Boolean(r.title_is_auto),
    folder_id: r.folder_id ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// 32-bit FNV-1a — stable mapping from string id to integer rowid for FTS contentless indices.
function hashStringToInt(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // SQLite rowid is signed 64-bit; we keep it within 31-bit positive range.
  return h & 0x7fffffff;
}

// ---------------------------------------------------------------------------
// Transcript chunks
// ---------------------------------------------------------------------------
export const TranscriptChunks = {
  insert(c: TranscriptChunk): TranscriptChunk {
    const d = getDb();
    d.prepare(`INSERT INTO transcript_chunks (id, meeting_id, provider, deepgram_request_id, channel, speaker_id, speaker_name, start_time, end_time, text, words, confidence, language, is_final, is_deleted, is_highlighted, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      c.id, c.meeting_id, c.provider, c.deepgram_request_id ?? null, c.channel ?? null,
      c.speaker_id ?? null, c.speaker_name ?? null, c.start_time, c.end_time, c.text,
      c.words ? toJson(c.words) : null, c.confidence ?? null, c.language ?? null,
      c.is_final ? 1 : 0, c.is_deleted ? 1 : 0, c.is_highlighted ? 1 : 0,
      c.source, c.created_at,
    );
    if (c.is_final) {
      d.prepare('INSERT INTO chunks_fts(rowid, text, speaker_name) VALUES (?,?,?)').run(
        hashStringToInt(c.id), c.text, c.speaker_name ?? '',
      );
    }
    return c;
  },
  listByMeeting(meetingId: ID): TranscriptChunk[] {
    const rows = getDb().prepare('SELECT * FROM transcript_chunks WHERE meeting_id = ? AND is_deleted = 0 ORDER BY start_time').all(meetingId) as any[];
    return rows.map(rowToChunk);
  },
  setHighlighted(chunkId: ID, on: boolean) {
    getDb().prepare('UPDATE transcript_chunks SET is_highlighted = ? WHERE id = ?').run(on ? 1 : 0, chunkId);
  },
  softDelete(chunkId: ID) {
    getDb().prepare('UPDATE transcript_chunks SET is_deleted = 1 WHERE id = ?').run(chunkId);
  },
  deleteRange(meetingId: ID, fromSec: number, toSec: number) {
    getDb().prepare('UPDATE transcript_chunks SET is_deleted = 1 WHERE meeting_id = ? AND start_time >= ? AND end_time <= ?').run(meetingId, fromSec, toSec);
  },
  renameSpeaker(meetingId: ID, speakerId: string, name: string) {
    getDb().prepare('UPDATE transcript_chunks SET speaker_name = ? WHERE meeting_id = ? AND speaker_id = ?').run(name, meetingId, speakerId);
  },
  /**
   * Hard-delete every transcript chunk for a meeting (used by retention).
   * Returns the number of rows removed.
   */
  deleteByMeeting(meetingId: ID): number {
    const d = getDb();
    const info = d.prepare('DELETE FROM transcript_chunks WHERE meeting_id = ?').run(meetingId);
    return info.changes ?? 0;
  },
};

function rowToChunk(r: any): TranscriptChunk {
  return {
    id: r.id,
    meeting_id: r.meeting_id,
    provider: r.provider,
    deepgram_request_id: r.deepgram_request_id ?? undefined,
    channel: r.channel ?? undefined,
    speaker_id: r.speaker_id ?? undefined,
    speaker_name: r.speaker_name ?? undefined,
    start_time: r.start_time,
    end_time: r.end_time,
    text: r.text,
    words: r.words ? fromJson(r.words, []) : undefined,
    confidence: r.confidence ?? undefined,
    language: r.language ?? undefined,
    is_final: bool(r.is_final),
    is_deleted: bool(r.is_deleted),
    is_highlighted: bool(r.is_highlighted),
    source: r.source ?? 'mixed',
    created_at: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Generated notes
// ---------------------------------------------------------------------------
export const GeneratedNotes = {
  get(meetingId: ID): GeneratedNote | null {
    const r = getDb().prepare('SELECT * FROM generated_notes WHERE meeting_id = ?').get(meetingId) as any;
    return r ? rowToNote(r) : null;
  },
  upsert(note: Omit<GeneratedNote, 'id' | 'created_at' | 'updated_at'> & { id?: ID }): GeneratedNote {
    const d = getDb();
    const ex = GeneratedNotes.get(note.meeting_id);
    if (ex) {
      const merged: GeneratedNote = {
        ...ex,
        ...note,
        updated_at: now(),
      };
      d.prepare(`UPDATE generated_notes SET template_id=?, summary=?, sections=?, decisions=?, action_items=?, open_questions=?, risks=?, quotes=?, follow_up_email=?, personal_reminders=?, updated_at=?, model=?, tone=?, length_preset=?, format_preset=? WHERE meeting_id = ?`).run(
        merged.template_id ?? null, merged.summary,
        toJson(merged.sections), toJson(merged.decisions), toJson(merged.action_items),
        toJson(merged.open_questions), toJson(merged.risks), toJson(merged.quotes),
        merged.follow_up_email ?? null, toJson(merged.personal_reminders),
        merged.updated_at, merged.model, merged.tone ?? null, merged.length_preset ?? null, merged.format_preset ?? null,
        merged.meeting_id,
      );
      return merged;
    }
    const n: GeneratedNote = {
      id: note.id ?? newId('gnt'),
      meeting_id: note.meeting_id,
      template_id: note.template_id ?? null,
      summary: note.summary,
      sections: note.sections ?? [],
      decisions: note.decisions ?? [],
      action_items: note.action_items ?? [],
      open_questions: note.open_questions ?? [],
      risks: note.risks ?? [],
      quotes: note.quotes ?? [],
      follow_up_email: note.follow_up_email,
      personal_reminders: note.personal_reminders ?? [],
      created_at: now(),
      updated_at: now(),
      model: note.model ?? '',
      tone: note.tone,
      length_preset: note.length_preset,
      format_preset: note.format_preset,
    };
    d.prepare(`INSERT INTO generated_notes (id, meeting_id, template_id, summary, sections, decisions, action_items, open_questions, risks, quotes, follow_up_email, personal_reminders, created_at, updated_at, model, tone, length_preset, format_preset) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      n.id, n.meeting_id, n.template_id ?? null, n.summary,
      toJson(n.sections), toJson(n.decisions), toJson(n.action_items),
      toJson(n.open_questions), toJson(n.risks), toJson(n.quotes),
      n.follow_up_email ?? null, toJson(n.personal_reminders),
      n.created_at, n.updated_at, n.model, n.tone ?? null, n.length_preset ?? null, n.format_preset ?? null,
    );
    return n;
  },
};

function rowToNote(r: any): GeneratedNote {
  return {
    id: r.id,
    meeting_id: r.meeting_id,
    template_id: r.template_id ?? null,
    summary: r.summary ?? '',
    sections: fromJson(r.sections, []),
    decisions: fromJson(r.decisions, []),
    action_items: fromJson(r.action_items, []),
    open_questions: fromJson(r.open_questions, []),
    risks: fromJson(r.risks, []),
    quotes: fromJson(r.quotes, []),
    follow_up_email: r.follow_up_email ?? undefined,
    personal_reminders: fromJson(r.personal_reminders, []),
    created_at: r.created_at,
    updated_at: r.updated_at,
    model: r.model ?? '',
    tone: r.tone ?? undefined,
    length_preset: r.length_preset ?? undefined,
    format_preset: r.format_preset ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Action items
// ---------------------------------------------------------------------------
export const ActionItems = {
  list(filter: { status?: string; person_id?: ID; company_id?: ID; project_id?: ID; due_before?: string } = {}): ActionItem[] {
    const d = getDb();
    let sql = 'SELECT a.* FROM action_items a';
    const where: string[] = [];
    const params: any[] = [];
    if (filter.person_id) { where.push('a.owner_person_id = ?'); params.push(filter.person_id); }
    if (filter.company_id) {
      sql += ' JOIN meeting_companies mc ON mc.meeting_id = a.meeting_id';
      where.push('mc.company_id = ?'); params.push(filter.company_id);
    }
    if (filter.project_id) {
      sql += ' JOIN meeting_projects mp ON mp.meeting_id = a.meeting_id';
      where.push('mp.project_id = ?'); params.push(filter.project_id);
    }
    if (filter.status) { where.push('a.status = ?'); params.push(filter.status); }
    if (filter.due_before) { where.push('a.due_date <= ?'); params.push(filter.due_before); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += " ORDER BY CASE a.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, a.due_date";
    const rows = d.prepare(sql).all(...params) as any[];
    return rows.map(rowToAction);
  },
  insert(input: Omit<ActionItem, 'id' | 'created_at' | 'updated_at'> & { id?: ID }): ActionItem {
    const d = getDb();
    const a: ActionItem = {
      id: input.id ?? newId('act'),
      meeting_id: input.meeting_id,
      task: input.task,
      owner: input.owner ?? 'me',
      owner_person_id: input.owner_person_id ?? null,
      due_date: input.due_date ?? null,
      priority: input.priority ?? 'medium',
      status: input.status ?? 'open',
      source_chunk_id: input.source_chunk_id ?? null,
      confidence: input.confidence ?? 0.8,
      external_ids: input.external_ids ?? {},
      created_at: now(),
      updated_at: now(),
    };
    d.prepare(`INSERT INTO action_items (id, meeting_id, task, owner, owner_person_id, due_date, priority, status, source_chunk_id, confidence, external_ids, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      a.id, a.meeting_id, a.task, a.owner, a.owner_person_id ?? null, a.due_date ?? null,
      a.priority, a.status, a.source_chunk_id ?? null, a.confidence, toJson(a.external_ids),
      a.created_at, a.updated_at,
    );
    return a;
  },
  update(id: ID, patch: Partial<ActionItem>): ActionItem {
    const d = getDb();
    const ex = (d.prepare('SELECT * FROM action_items WHERE id = ?').get(id) as any);
    if (!ex) throw new Error('Action item not found: ' + id);
    const merged: ActionItem = { ...rowToAction(ex), ...patch, updated_at: now() };
    d.prepare(`UPDATE action_items SET task=?, owner=?, owner_person_id=?, due_date=?, priority=?, status=?, source_chunk_id=?, confidence=?, external_ids=?, updated_at=? WHERE id=?`).run(
      merged.task, merged.owner, merged.owner_person_id ?? null, merged.due_date ?? null,
      merged.priority, merged.status, merged.source_chunk_id ?? null, merged.confidence,
      toJson(merged.external_ids), merged.updated_at, id,
    );
    return merged;
  },
  delete(id: ID) {
    getDb().prepare('DELETE FROM action_items WHERE id = ?').run(id);
  },
};

function rowToAction(r: any): ActionItem {
  return {
    id: r.id,
    meeting_id: r.meeting_id,
    task: r.task,
    owner: r.owner,
    owner_person_id: r.owner_person_id ?? null,
    due_date: r.due_date ?? null,
    priority: r.priority,
    status: r.status,
    source_chunk_id: r.source_chunk_id ?? null,
    confidence: r.confidence,
    external_ids: fromJson(r.external_ids, {}),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------
export const Automations = {
  list(): AutomationRule[] {
    return (getDb().prepare('SELECT * FROM automation_rules ORDER BY name').all() as any[]).map(rowToAutomation);
  },
  byTrigger(trigger: AutomationRule['trigger']): AutomationRule[] {
    return (getDb().prepare('SELECT * FROM automation_rules WHERE trigger = ? AND enabled = 1').all(trigger) as any[]).map(rowToAutomation);
  },
  upsert(input: Partial<AutomationRule> & { name: string; trigger: AutomationRule['trigger'] }): AutomationRule {
    const d = getDb();
    if (input.id) {
      const ex = (d.prepare('SELECT * FROM automation_rules WHERE id = ?').get(input.id) as any);
      if (ex) {
        const merged: AutomationRule = { ...rowToAutomation(ex), ...input, updated_at: now() };
        d.prepare(`UPDATE automation_rules SET name=?, trigger=?, conditions=?, actions=?, enabled=?, last_run_at=?, updated_at=? WHERE id=?`).run(
          merged.name, merged.trigger, toJson(merged.conditions), toJson(merged.actions),
          merged.enabled ? 1 : 0, merged.last_run_at ?? null, merged.updated_at, merged.id,
        );
        return merged;
      }
    }
    const a: AutomationRule = {
      id: input.id ?? newId('aut'),
      name: input.name,
      trigger: input.trigger,
      conditions: input.conditions ?? [],
      actions: input.actions ?? [],
      enabled: input.enabled ?? true,
      last_run_at: input.last_run_at ?? null,
      created_at: now(),
      updated_at: now(),
    };
    d.prepare(`INSERT INTO automation_rules (id, name, trigger, conditions, actions, enabled, last_run_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      a.id, a.name, a.trigger, toJson(a.conditions), toJson(a.actions),
      a.enabled ? 1 : 0, a.last_run_at ?? null, a.created_at, a.updated_at,
    );
    return a;
  },
  setLastRun(id: ID) {
    getDb().prepare('UPDATE automation_rules SET last_run_at = ? WHERE id = ?').run(now(), id);
  },
  delete(id: ID) {
    getDb().prepare('DELETE FROM automation_rules WHERE id = ?').run(id);
  },
};

function rowToAutomation(r: any): AutomationRule {
  return {
    id: r.id,
    name: r.name,
    trigger: r.trigger,
    conditions: fromJson(r.conditions, []),
    actions: fromJson(r.actions, []),
    enabled: bool(r.enabled),
    last_run_at: r.last_run_at ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
export const ChatThreads = {
  list(): ChatThread[] {
    return (getDb().prepare('SELECT * FROM chat_threads ORDER BY updated_at DESC').all() as any[]).map(rowToThread);
  },
  get(id: ID): ChatThread | null {
    const r = getDb().prepare('SELECT * FROM chat_threads WHERE id = ?').get(id) as any;
    return r ? rowToThread(r) : null;
  },
  upsert(t: Omit<ChatThread, 'id' | 'created_at' | 'updated_at'> & { id?: ID }): ChatThread {
    const d = getDb();
    if (t.id) {
      const ex = ChatThreads.get(t.id);
      if (ex) {
        const merged: ChatThread = { ...ex, ...t, updated_at: now() };
        d.prepare(`UPDATE chat_threads SET title=?, scope=?, messages=?, updated_at=? WHERE id=?`).run(
          merged.title, toJson(merged.scope), toJson(merged.messages), merged.updated_at, merged.id,
        );
        return merged;
      }
    }
    const c: ChatThread = {
      id: t.id ?? newId('cht'),
      title: t.title,
      scope: t.scope,
      messages: t.messages ?? [],
      created_at: now(),
      updated_at: now(),
    };
    d.prepare(`INSERT INTO chat_threads (id, title, scope, messages, created_at, updated_at) VALUES (?,?,?,?,?,?)`).run(
      c.id, c.title, toJson(c.scope), toJson(c.messages), c.created_at, c.updated_at,
    );
    return c;
  },
  delete(id: ID) { getDb().prepare('DELETE FROM chat_threads WHERE id = ?').run(id); },
};

function rowToThread(r: any): ChatThread {
  return {
    id: r.id,
    title: r.title,
    scope: fromJson(r.scope, { kind: 'all' as const }),
    messages: fromJson(r.messages, []),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------
export const Integrations = {
  list(): Integration[] {
    return (getDb().prepare('SELECT * FROM integrations ORDER BY kind').all() as any[]).map(rowToIntegration);
  },
  byKind(kind: Integration['kind']): Integration | null {
    const r = getDb().prepare('SELECT * FROM integrations WHERE kind = ?').get(kind) as any;
    return r ? rowToIntegration(r) : null;
  },
  setStatus(kind: Integration['kind'], patch: Partial<Integration>): Integration {
    const d = getDb();
    const ex = Integrations.byKind(kind);
    if (!ex) throw new Error('Integration not registered: ' + kind);
    const merged: Integration = { ...ex, ...patch, updated_at: now() };
    d.prepare(`UPDATE integrations SET enabled=?, account_email=?, config=?, last_synced_at=?, status=?, error_message=?, updated_at=? WHERE kind=?`).run(
      merged.enabled ? 1 : 0, merged.account_email ?? null, toJson(merged.config),
      merged.last_synced_at ?? null, merged.status, merged.error_message ?? null,
      merged.updated_at, kind,
    );
    return merged;
  },
};

function rowToIntegration(r: any): Integration {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    enabled: bool(r.enabled),
    account_email: r.account_email ?? undefined,
    config: fromJson(r.config, {}),
    last_synced_at: r.last_synced_at ?? null,
    status: r.status,
    error_message: r.error_message ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Detection rules
// ---------------------------------------------------------------------------
export const DetectionRules = {
  ignore: {
    list() {
      return getDb().prepare('SELECT * FROM detection_ignore_rules').all() as any[];
    },
    add(rule: { source_app?: string; domain?: string; person_id?: ID; company_id?: ID; calendar_event_id?: string }) {
      getDb().prepare(`INSERT INTO detection_ignore_rules (id, source_app, domain, person_id, company_id, calendar_event_id, created_at) VALUES (?,?,?,?,?,?,?)`).run(
        newId('ign'), rule.source_app ?? null, rule.domain ?? null,
        rule.person_id ?? null, rule.company_id ?? null, rule.calendar_event_id ?? null, now(),
      );
    },
  },
  alwaysStart: {
    list() {
      return getDb().prepare('SELECT * FROM detection_always_start_rules').all() as any[];
    },
    add(rule: { source_app?: string; domain?: string; calendar_event_id?: string }) {
      getDb().prepare(`INSERT INTO detection_always_start_rules (id, source_app, domain, calendar_event_id, created_at) VALUES (?,?,?,?,?)`).run(
        newId('asr'), rule.source_app ?? null, rule.domain ?? null, rule.calendar_event_id ?? null, now(),
      );
    },
  },
};

// ---------------------------------------------------------------------------
// Usage metering
// ---------------------------------------------------------------------------
export const Usage = {
  record(meetingId: ID | null, provider: string, seconds: number, costUsd: number) {
    getDb().prepare(`INSERT INTO usage_events (id, meeting_id, provider, seconds, estimated_cost_usd, created_at) VALUES (?,?,?,?,?,?)`).run(
      newId('use'), meetingId, provider, seconds, costUsd, now(),
    );
  },
  totalsForMonth(): { seconds: number; costUsd: number } {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const r = getDb().prepare('SELECT COALESCE(SUM(seconds),0) AS s, COALESCE(SUM(estimated_cost_usd),0) AS c FROM usage_events WHERE created_at >= ?').get(start.toISOString()) as any;
    return { seconds: r.s ?? 0, costUsd: r.c ?? 0 };
  },
  totalsForToday(): { seconds: number } {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const r = getDb().prepare('SELECT COALESCE(SUM(seconds),0) AS s FROM usage_events WHERE created_at >= ?').get(start.toISOString()) as any;
    return { seconds: r.s ?? 0 };
  },
};

export { hashStringToInt, newId };
export type Repos = {
  People: typeof People;
  Companies: typeof Companies;
  Projects: typeof Projects;
  Folders: typeof Folders;
  Templates: typeof Templates;
  CalendarEvents: typeof CalendarEvents;
  Meetings: typeof Meetings;
  TranscriptChunks: typeof TranscriptChunks;
  GeneratedNotes: typeof GeneratedNotes;
  ActionItems: typeof ActionItems;
  Automations: typeof Automations;
  ChatThreads: typeof ChatThreads;
  Integrations: typeof Integrations;
  DetectionRules: typeof DetectionRules;
  Usage: typeof Usage;
};

// Re-export Database type for service layer typing.
export type { Database };
