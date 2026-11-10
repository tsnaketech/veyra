import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('upgrades 0000 data: legacy feedback statuses and provider ids are mapped, nothing lost', () => {
  // A migrations folder that stops at 0000 reproduces a database created before 0001.
  dir = mkdtempSync(join(tmpdir(), 'veyra-mig-'));
  cpSync('drizzle', dir, { recursive: true });
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(0, 1);
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal));

  const client = new Database(':memory:');
  client.pragma('foreign_keys = ON');
  migrate(drizzle(client), { migrationsFolder: dir });
  const storyboard = JSON.stringify({ scenes: [], width: 1920, height: 1080, fps: 30 });
  client.exec(`insert into projects values ('prj_1','P','{}',1,1)`);
  client
    .prepare(
      `insert into video_revisions (id,project_id,status,storyboard,resolved_config,created_at,updated_at) values (?,?,?,?,?,1,1)`
    )
    .run('rev_1', 'prj_1', 'awaiting_approval', storyboard, '{"aiProvider":"fake-test-only"}');
  client
    .prepare(
      `insert into video_revisions (id,project_id,status,storyboard,resolved_config,created_at,updated_at) values (?,?,?,?,?,1,1)`
    )
    .run('rev_2', 'prj_1', 'draft', storyboard, '{"aiProvider":"anthropic"}');
  const legacy = ['open', 'planned', 'applied', 'resolved', 'rejected'];
  legacy.forEach((status, i) =>
    client
      .prepare(
        `insert into feedback (id,project_id,revision_id,timestamp_ms,text,status,author,created_at,updated_at) values (?,?,?,?,?,?,?,1,1)`
      )
      .run(`fdb_${i}`, 'prj_1', 'rev_1', i * 1000, `c${i}`, status, 'u')
  );

  migrate(drizzle(client), { migrationsFolder: 'drizzle' });
  const rows = client
    .prepare('select id, status, text, frame_index from feedback order by id')
    .all();
  expect(rows).toEqual([
    { id: 'fdb_0', status: 'draft', text: 'c0', frame_index: null },
    { id: 'fdb_1', status: 'submitted', text: 'c1', frame_index: null },
    { id: 'fdb_2', status: 'applied', text: 'c2', frame_index: null },
    { id: 'fdb_3', status: 'applied', text: 'c3', frame_index: null },
    { id: 'fdb_4', status: 'rejected', text: 'c4', frame_index: null }
  ]);
  const providers = client
    .prepare(
      `select json_extract(resolved_config,'$.aiProvider') as p from video_revisions order by id`
    )
    .all();
  expect(providers).toEqual([{ p: 'fake' }, { p: 'anthropic-api' }]);
  expect(client.pragma('foreign_key_check')).toEqual([]);
  client.close();
});

it('upgrades 0001 data to 0002: assisted tasks are kept and evaluations become possible', () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-mig-'));
  cpSync('drizzle', dir, { recursive: true });
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(0, 2);
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal));
  const client = new Database(':memory:');
  client.pragma('foreign_keys = ON');
  migrate(drizzle(client), { migrationsFolder: dir });
  client.exec(`insert into projects values ('prj_1','P','{}',1,1)`);
  client.exec(
    `insert into ai_tasks (id,project_id,kind,provider,status,input,dir,created_at,updated_at) values ('tsk_1','prj_1','plan','claude-subscribe','awaiting_import','{}','/x',1,1)`
  );
  expect(() =>
    client.exec(
      `insert into ai_tasks (id,project_id,kind,provider,status,input,dir,created_at,updated_at) values ('tsk_2','prj_1','evaluation','claude-subscribe','awaiting_import','{}','/x',1,1)`
    )
  ).toThrow(/CHECK/);

  migrate(drizzle(client), { migrationsFolder: 'drizzle' });
  expect(client.prepare('select id, kind, status from ai_tasks').all()).toEqual([
    { id: 'tsk_1', kind: 'plan', status: 'awaiting_import' }
  ]);
  client.exec(
    `insert into ai_tasks (id,project_id,kind,provider,status,input,dir,created_at,updated_at) values ('tsk_2','prj_1','evaluation','claude-subscribe','awaiting_import','{}','/x',1,1)`
  );
  expect(client.pragma('foreign_key_check')).toEqual([]);
  client.close();
});

it('upgrades 0002 data to 0003: rows are kept and the audio columns start empty', () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-mig-'));
  cpSync('drizzle', dir, { recursive: true });
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(0, 3);
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal));
  const client = new Database(':memory:');
  client.pragma('foreign_keys = ON');
  migrate(drizzle(client), { migrationsFolder: dir });
  const storyboard = JSON.stringify({ scenes: [], width: 1920, height: 1080, fps: 30 });
  client.exec(`insert into projects values ('prj_1','P','{}',1,1)`);
  client
    .prepare(
      `insert into video_revisions (id,project_id,status,storyboard,resolved_config,created_at,updated_at) values ('rev_1','prj_1','draft',?,'{}',1,1)`
    )
    .run(storyboard);
  client.exec(
    `insert into assets (id,project_id,path,media_type,created_at,updated_at) values ('ast_1','prj_1','/x','image/png',1,1)`
  );
  client.exec(
    `insert into feedback (id,project_id,revision_id,timestamp_ms,text,status,author,created_at,updated_at) values ('fdb_1','prj_1','rev_1',0,'c','draft','u',1,1)`
  );

  migrate(drizzle(client), { migrationsFolder: 'drizzle' });
  expect(client.prepare('select audio, silent_video_path from video_revisions').get()).toEqual({
    audio: null,
    silent_video_path: null
  });
  expect(client.prepare('select audio from assets').get()).toEqual({ audio: null });
  expect(client.prepare('select range_end_ms, audio_track_id, text from feedback').get()).toEqual({
    range_end_ms: null,
    audio_track_id: null,
    text: 'c'
  });
  expect(client.pragma('foreign_key_check')).toEqual([]);
  client.close();
});

it('upgrades 0003 data to 0004: rows are kept and production runs and phases are constrained', () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-mig-'));
  cpSync('drizzle', dir, { recursive: true });
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(0, 4);
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal));
  const client = new Database(':memory:');
  client.pragma('foreign_keys = ON');
  migrate(drizzle(client), { migrationsFolder: dir });
  const tables = () =>
    client
      .prepare(
        `select name from sqlite_master where type='table' and name like 'production_%' order by name`
      )
      .all();
  expect(tables()).toEqual([]);
  const storyboard = JSON.stringify({ scenes: [], width: 1920, height: 1080, fps: 30 });
  const audio = JSON.stringify({ schemaVersion: 1, tracks: [] });
  client.exec(`insert into projects values ('prj_1','P','{}',1,1)`);
  client
    .prepare(
      `insert into video_revisions (id,project_id,status,storyboard,resolved_config,audio,silent_video_path,created_at,updated_at) values ('rev_1','prj_1','awaiting_approval',?,'{}',?,'/v.mp4',1,1)`
    )
    .run(storyboard, audio);
  client.exec(
    `insert into feedback (id,project_id,revision_id,timestamp_ms,range_end_ms,audio_track_id,text,status,author,created_at,updated_at) values ('fdb_1','prj_1','rev_1',8000,12000,'atr_1','c','draft','u',1,1)`
  );
  const before = {
    revisions: client.prepare('select * from video_revisions').all(),
    feedback: client.prepare('select * from feedback').all()
  };

  // Stop at 0004: later migrations add columns that this comparison does not expect.
  journal.entries = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')).entries.slice(
    0,
    5
  );
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal));
  migrate(drizzle(client), { migrationsFolder: dir });
  expect(tables()).toEqual([{ name: 'production_phases' }, { name: 'production_runs' }]);
  expect(client.prepare('select * from video_revisions').all()).toEqual(before.revisions);
  expect(client.prepare('select * from feedback').all()).toEqual(before.feedback);

  const run = (id: string, status: string) =>
    client
      .prepare(
        `insert into production_runs (id,project_id,kind,status,plan,revision_id,created_at,updated_at) values (?,'prj_1','production',?,'{}','rev_1',1,1)`
      )
      .run(id, status);
  const phase = (id: string, runId: string, name: string, status: string) =>
    client
      .prepare(
        `insert into production_phases (id,run_id,phase,agent,status,created_at,updated_at) values (?,?,?,'director',?,1,1)`
      )
      .run(id, runId, name, status);
  run('run_1', 'waiting');
  expect(() => run('run_2', 'paused')).toThrow(/CHECK/);
  phase('phs_1', 'run_1', 'plan', 'done');
  expect(() => phase('phs_2', 'run_1', 'script', 'cancelled')).toThrow(/CHECK/);
  expect(() => phase('phs_3', 'run_1', 'plan', 'pending')).toThrow(/UNIQUE/);
  expect(() => phase('phs_4', 'run_x', 'plan', 'pending')).toThrow(/FOREIGN KEY/);
  expect(client.prepare('select status, ai_calls from production_runs').all()).toEqual([
    { status: 'waiting', ai_calls: 0 }
  ]);
  expect(client.prepare('select status, attempts from production_phases').all()).toEqual([
    { status: 'done', attempts: 0 }
  ]);
  expect(client.pragma('foreign_key_check')).toEqual([]);
  client.close();
});

it('upgrades 0004 data to 0005: rows are kept and the caption columns start empty', () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-mig-'));
  cpSync('drizzle', dir, { recursive: true });
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(0, 5);
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal));
  const client = new Database(':memory:');
  client.pragma('foreign_keys = ON');
  migrate(drizzle(client), { migrationsFolder: dir });
  const storyboard = JSON.stringify({ scenes: [], width: 1920, height: 1080, fps: 30 });
  const audio = JSON.stringify({ schemaVersion: 1, tracks: [] });
  client.exec(`insert into projects values ('prj_1','P','{}',1,1)`);
  client
    .prepare(
      `insert into video_revisions (id,project_id,status,storyboard,resolved_config,audio,created_at,updated_at) values ('rev_1','prj_1','awaiting_approval',?,'{}',?,1,1)`
    )
    .run(storyboard, audio);
  client.exec(
    `insert into feedback (id,project_id,revision_id,timestamp_ms,audio_track_id,text,status,author,created_at,updated_at) values ('fdb_1','prj_1','rev_1',0,'atr_1','c','draft','u',1,1)`
  );
  const before = {
    revisions: client.prepare('select * from video_revisions').all(),
    feedback: client.prepare('select * from feedback').all()
  };

  migrate(drizzle(client), { migrationsFolder: 'drizzle' });
  expect(client.prepare('select * from video_revisions').all()).toEqual(
    (before.revisions as object[]).map((r) => ({ ...r, captions: null }))
  );
  expect(client.prepare('select * from feedback').all()).toEqual(
    (before.feedback as object[]).map((f) => ({ ...f, caption_cue_id: null }))
  );
  expect(client.pragma('foreign_key_check')).toEqual([]);
  client.close();
});

it('upgrades 0005 data to 0006: runs are kept and their spend envelope starts at zero', () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-mig-'));
  cpSync('drizzle', dir, { recursive: true });
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(0, 6);
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal));
  const client = new Database(':memory:');
  client.pragma('foreign_keys = ON');
  migrate(drizzle(client), { migrationsFolder: dir });
  const plan = JSON.stringify({
    phases: [],
    budget: { maxAiCalls: 3, maxRenders: 2 },
    reason: 'R'
  });
  client.exec(`insert into projects values ('prj_1','P','{}',1,1)`);
  client
    .prepare(
      `insert into production_runs (id,project_id,kind,status,plan,ai_calls,created_at,updated_at) values ('run_1','prj_1','production','waiting',?,2,1,1)`
    )
    .run(plan);
  client.exec(
    `insert into production_phases (id,run_id,phase,agent,status,attempts,created_at,updated_at) values ('phs_1','run_1','script','director','done',1,1,1)`
  );
  const before = {
    runs: client.prepare('select * from production_runs').all(),
    phases: client.prepare('select * from production_phases').all()
  };

  migrate(drizzle(client), { migrationsFolder: 'drizzle' });
  expect(client.prepare('select * from production_runs').all()).toEqual(
    (before.runs as object[]).map((r) => ({
      ...r,
      budget_micro_usd: 0,
      spent_micro_usd: 0,
      reserved_micro_usd: 0
    }))
  );
  expect(client.prepare('select * from production_phases').all()).toEqual(before.phases);
  expect(client.pragma('foreign_key_check')).toEqual([]);
  client.close();
});
