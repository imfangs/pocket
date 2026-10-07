import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { creationLocations } from '../server/lifecycle.mjs';

const projectA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const projectB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture(t) {
  const home=mkdtempSync(join(tmpdir(),'pocket-locations-'));
  const directory=join(home,'project'),alias=join(home,'alias');
  mkdirSync(directory);symlinkSync(directory,alias);
  const db=new DatabaseSync(join(home,'state_5.sqlite'));
  db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE project_roots(project_id TEXT,path TEXT,position INTEGER)');
  db.prepare('INSERT INTO projects VALUES(?,?)').run(projectA,'Project');
  db.prepare('INSERT INTO project_roots VALUES(?,?,0)').run(projectA,directory);
  t.after(()=>{db.close();rmSync(home,{recursive:true,force:true});});
  const store={catalog:()=>({projects:[{name:'Legacy project',paths:[directory+'/',alias]}],
    threads:[{cwd:alias,updatedAt:1,missing:false}]})};
  return{home,directory,alias,db,store};
}

test('legacy and recent path aliases do not add a duplicate unassigned location',t=>{
  const f=fixture(t),locations=creationLocations(f.store,f.home);
  assert.equal(locations.length,1);
  assert.equal(locations[0].cwd,realpathSync(f.directory));
  assert.equal(locations[0].projectId,projectA);
});

test('different real projects sharing a canonical directory remain distinct submission targets',t=>{
  const f=fixture(t);
  f.db.prepare('INSERT INTO projects VALUES(?,?)').run(projectB,'Another project');
  f.db.prepare('INSERT INTO project_roots VALUES(?,?,0)').run(projectB,f.alias);
  const locations=creationLocations(f.store,f.home);
  assert.equal(locations.length,2);
  assert.deepEqual(new Set(locations.map(x=>x.projectId)),new Set([projectA,projectB]));
  assert.equal(new Set(locations.map(x=>x.cwd)).size,1);
  assert.equal(new Set(locations.map(x=>x.id)).size,2);
});
