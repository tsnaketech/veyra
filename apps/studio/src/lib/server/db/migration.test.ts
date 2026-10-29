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
