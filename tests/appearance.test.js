import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { getAppearance } from '../src/appearance.js';
import { service } from '../src/service.js';
import { fixture, user } from './helpers.js';
import { roles } from '../src/policy.js';

test('appearance defaults work for existing databases without a new migration',()=>{const f=fixture();assert.equal(getAppearance(f.db).theme,'mechlin');assert.equal(getAppearance(f.db).productName,'Orbit');assert.equal(getAppearance(f.db).themes.length,3);assert.equal(f.db.prepare("SELECT value FROM settings WHERE key='appearance'").get(),undefined);f.db.close();});
test('admin can save every allowlisted theme and audit before/after',()=>{const f=fixture();for(const theme of ['midnight','ocean','mechlin']){assert.equal(service(f.db,f.admin,'PUT','admin/appearance',{theme}).theme,theme);assert.equal(service(f.db,f.recruiter,'GET','appearance').theme,theme);}const events=f.db.prepare("SELECT * FROM audit WHERE event='admin.appearance_updated'").all();assert.equal(events.length,3);assert.deepEqual(JSON.parse(events[0].detail),{before:'mechlin',after:'midnight'});f.db.close();});
test('all non-admin roles are denied theme writes without mutation or success audit',()=>{const f=fixture();for(const role of roles.filter(r=>r!=='System Admin'))assert.throws(()=>service(f.db,user(f.db,role),'PUT','admin/appearance',{theme:'midnight'}),e=>e.status===403);assert.equal(getAppearance(f.db).theme,'mechlin');assert.equal(f.db.prepare("SELECT count(*) n FROM audit WHERE event='admin.appearance_updated'").get().n,0);f.db.close();});
test('disabled administrators cannot update organization appearance',()=>{const f=fixture();assert.throws(()=>service(f.db,user(f.db,'System Admin','Engineering','disabled'),'PUT','admin/appearance',{theme:'midnight'}),e=>e.status===403);f.db.close();});
test('untrusted themes and additional style fields are rejected',()=>{const f=fixture();for(const body of [{theme:'unknown'},{theme:'midnight" onload="alert(1)'},{theme:'mechlin',css:'body{display:none}'},{theme:null},{}])assert.throws(()=>service(f.db,f.admin,'PUT','admin/appearance',body),e=>e.status===400);assert.equal(getAppearance(f.db).theme,'mechlin');f.db.close();});
test('malformed stored appearance falls back to a safe default',()=>{const f=fixture();for(const value of ['invalid','null','{"theme":"unknown"}','{"theme":"midnight\\\" onclick=bad"}']){f.db.prepare("INSERT OR REPLACE INTO settings VALUES('appearance',?)").run(value);assert.equal(getAppearance(f.db).theme,'mechlin');}f.db.close();});
test('saved theme survives database close/reopen and startup does not reset it',()=>{const folder=mkdtempSync(join(tmpdir(),'orbit-theme-'));try{const path=join(folder,'data.sqlite');let db=openDb(path);const admin=user(db,'System Admin');service(db,admin,'PUT','admin/appearance',{theme:'midnight'});db.close();db=openDb(path);assert.equal(getAppearance(db).theme,'midnight');assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE event='admin.appearance_updated'").get().n,1);db.close();}finally{rmSync(folder,{recursive:true,force:true});}});
