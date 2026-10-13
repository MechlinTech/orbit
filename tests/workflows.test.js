import test from 'node:test';
import assert from 'node:assert/strict';
import { service,matchSkills } from '../src/service.js';
import { can,roles } from '../src/policy.js';
import { audit } from '../src/db.js';
import { fixture,user,reqBody,candidateBody } from './helpers.js';
const call=(f,u,m,p,b)=>service(f.db,u,m,p,b);
function hiringFixture(){const f=fixture();f.req=call(f,f.recruiter,'POST','requisitions',reqBody);call(f,f.recruiter,'POST',`requisitions/${f.req.id}/submit`);call(f,f.manager,'POST',`requisitions/${f.req.id}/approve`,{});call(f,f.finance,'POST',`requisitions/${f.req.id}/approve`,{});f.candidate=call(f,f.recruiter,'POST','candidates',candidateBody);f.app=call(f,f.recruiter,'POST','applications',{candidate_id:f.candidate.id,requisition_id:f.req.id});return f;}
test('requester, manager and finance approval sequence opens headcount',()=>{const f=fixture();const req=call(f,f.recruiter,'POST','requisitions',reqBody);assert.equal(req.status,'draft');assert.throws(()=>call(f,f.recruiter,'POST',`requisitions/${req.id}/approve`));call(f,f.recruiter,'POST',`requisitions/${req.id}/submit`);assert.throws(()=>call(f,f.finance,'POST',`requisitions/${req.id}/approve`,{}));assert.equal(call(f,f.manager,'POST',`requisitions/${req.id}/approve`,{}).status,'pending_finance');assert.equal(call(f,f.finance,'POST',`requisitions/${req.id}/approve`,{}).status,'open');assert.equal(f.db.prepare('SELECT count(*) n FROM approvals').get().n,2);f.db.close();});
test('self approval and same person at both steps are forbidden even for admin',()=>{const f=fixture();const r=call(f,f.admin,'POST','requisitions',reqBody);call(f,f.admin,'POST',`requisitions/${r.id}/submit`);assert.throws(()=>call(f,f.admin,'POST',`requisitions/${r.id}/approve`,{}));const r2=call(f,f.recruiter,'POST','requisitions',reqBody);call(f,f.recruiter,'POST',`requisitions/${r2.id}/submit`);call(f,f.admin,'POST',`requisitions/${r2.id}/approve`,{});assert.throws(()=>call(f,f.admin,'POST',`requisitions/${r2.id}/approve`,{}));f.db.close();});
test('rejected requisition cannot receive applications',()=>{const f=fixture();const r=call(f,f.recruiter,'POST','requisitions',reqBody);call(f,f.recruiter,'POST',`requisitions/${r.id}/submit`);call(f,f.manager,'POST',`requisitions/${r.id}/reject`,{note:'Budget unavailable'});const c=call(f,f.recruiter,'POST','candidates',candidateBody);assert.throws(()=>call(f,f.recruiter,'POST','applications',{candidate_id:c.id,requisition_id:r.id}));f.db.close();});
test('candidate duplicates are case insensitive and safe against SQL injection',()=>{const f=fixture();call(f,f.recruiter,'POST','candidates',candidateBody);assert.throws(()=>call(f,f.recruiter,'POST','candidates',{...candidateBody,email:'AVERY@EXAMPLE.COM'}));const c=call(f,f.recruiter,'POST','candidates',{...candidateBody,email:'second@example.com',name:"Robert'); DROP TABLE users;--"});assert.ok(c.id);assert.ok(f.db.prepare('SELECT count(*) n FROM users').get().n>0);f.db.close();});
test('team isolation protects reads, writes and record IDs',()=>{const f=hiringFixture(),other=user(f.db,'Recruiter','Sales');assert.equal(call(f,other,'GET','candidates').length,0);assert.equal(call(f,other,'GET','applications').length,0);assert.throws(()=>call(f,other,'POST',`applications/${f.app.id}/stage`,{stage:'Screening'}));assert.throws(()=>call(f,other,'POST','candidates',candidateBody));f.db.close();});
test('roles deny admin access, financial approval and candidate access by default',()=>{const f=fixture();for(const role of roles.filter(r=>r!=='System Admin')){const u=user(f.db,role);assert.throws(()=>call(f,u,'GET','admin/users'));}for(const role of ['Employee/Referral','Interviewer','Finance Approver','Agency']){const u=user(f.db,role);assert.throws(()=>call(f,u,'GET','candidates'));}assert.equal(can(user(f.db,'Agency'),'jobs'),false);f.db.close();});
test('manual user provisioning requires Entra IDs and rejects optional agency role',()=>{const f=fixture();assert.throws(()=>call(f,f.admin,'POST','admin/users',{email:'new@example.com',name:'New',role:'Recruiter',team:'Engineering'}));assert.throws(()=>call(f,f.admin,'POST','admin/users',{email:'new@example.com',name:'New',role:'Agency'}));assert.equal(call(f,f.admin,'POST','admin/users',{email:'new@example.com',name:'New',role:'Recruiter',team:'Engineering',oid:'44444444-4444-4444-4444-444444444444',tenant:'11111111-1111-1111-1111-111111111111'}).status,'active');f.db.close();});
test('pipeline records transitions, prevents skipping and enforces terminal stages/headcount',()=>{const f=hiringFixture();assert.throws(()=>call(f,f.recruiter,'POST',`applications/${f.app.id}/stage`,{stage:'Hired'}));for(const stage of ['Screening','Interview','Offer','Hired'])call(f,f.recruiter,'POST',`applications/${f.app.id}/stage`,{stage});assert.throws(()=>call(f,f.recruiter,'POST',`applications/${f.app.id}/stage`,{stage:'Rejected'}));const c=call(f,f.recruiter,'POST','candidates',{...candidateBody,email:'second@example.com'}),a=call(f,f.recruiter,'POST','applications',{candidate_id:c.id,requisition_id:f.req.id});for(const stage of ['Screening','Interview','Offer'])call(f,f.recruiter,'POST',`applications/${a.id}/stage`,{stage});assert.throws(()=>call(f,f.recruiter,'POST',`applications/${a.id}/stage`,{stage:'Hired'}));assert.equal(f.db.prepare('SELECT count(*) n FROM stage_events').get().n,7);f.db.close();});
test('pipeline configuration rejects removal of occupied stages',()=>{const f=hiringFixture();call(f,f.recruiter,'POST',`applications/${f.app.id}/stage`,{stage:'Screening'});assert.throws(()=>call(f,f.admin,'PUT','pipeline',{stages:['Applied','Hired','Rejected']}));assert.throws(()=>call(f,f.recruiter,'PUT','pipeline',{stages:['Applied','Hired','Rejected']}));assert.deepEqual(call(f,f.admin,'PUT','pipeline',{stages:['Applied','Screening','Assessment','Interview','Offer','Hired','Rejected']}).slice(0,3),['Applied','Screening','Assessment']);f.db.close();});
test('matching explanation uses explicit skills and handles absent job criteria',()=>{const f=hiringFixture(),r=call(f,f.recruiter,'GET',`applications/${f.app.id}/match`);assert.equal(r.score,50);assert.deepEqual(r.missing,['JavaScript']);assert.equal(matchSkills(f.candidate,{skills:'[]'}).score,null);f.db.close();});
test('interview assignment, structured scorecard, feedback blinding and immutable submission',()=>{const f=hiringFixture(),second=user(f.db,'Interviewer'),unassigned=user(f.db,'Interviewer');const schedule=u=>call(f,f.recruiter,'POST','interviews',{application_id:f.app.id,interviewer_id:u.id,scheduled_at:new Date(Date.now()+86400000).toISOString(),competencies:['Technical','Communication']});const one=schedule(f.interviewer),two=schedule(second),score={ratings:{Technical:4,Communication:3},recommendation:'Yes',notes:'Solved the exercise and explained the tradeoffs.'};call(f,f.interviewer,'POST',`interviews/${one.id}/scorecards`,score);assert.throws(()=>call(f,f.interviewer,'POST',`interviews/${one.id}/scorecards`,score));assert.throws(()=>call(f,second,'POST',`interviews/${one.id}/scorecards`,score));assert.throws(()=>call(f,unassigned,'GET',`interviews/${one.id}/scorecards`));let view=call(f,second,'GET',`interviews/${two.id}/scorecards`);assert.equal(view.blinded,true);assert.equal(view.scorecards.length,0);call(f,second,'POST',`interviews/${two.id}/scorecards`,score);view=call(f,second,'GET',`interviews/${two.id}/scorecards`);assert.equal(view.blinded,false);assert.equal(view.scorecards.length,2);f.db.close();});
test('invalid scorecards and past interview dates fail validation',()=>{const f=hiringFixture();assert.throws(()=>call(f,f.recruiter,'POST','interviews',{application_id:f.app.id,interviewer_id:f.interviewer.id,scheduled_at:'2000-01-01',competencies:['Skill']}));const i=call(f,f.recruiter,'POST','interviews',{application_id:f.app.id,interviewer_id:f.interviewer.id,scheduled_at:new Date(Date.now()+86400000).toISOString(),competencies:['Skill']});assert.throws(()=>call(f,f.interviewer,'POST',`interviews/${i.id}/scorecards`,{ratings:{Skill:6},recommendation:'Yes',notes:'Evidence'}));f.db.close();});
test('referrals reveal only the submitting employee records',()=>{const f=hiringFixture(),employee=user(f.db,'Employee/Referral'),other=user(f.db,'Employee/Referral');call(f,employee,'POST','referrals',{requisition_id:f.req.id,name:'Referral',email:'ref@example.com',note:'Worked together'});assert.equal(call(f,employee,'GET','referrals').length,1);assert.equal(call(f,other,'GET','referrals').length,0);assert.equal(call(f,employee,'GET','requisitions')[0].salary_max,undefined);f.db.close();});
test('analytics are scoped to the actor team',()=>{const f=hiringFixture(),other=user(f.db,'Recruiter','Sales');assert.equal(call(f,f.recruiter,'GET','analytics').candidates,1);assert.equal(call(f,other,'GET','analytics').candidates,0);f.db.close();});
test('audit records are append-only and admin-only',()=>{const f=fixture();audit(f.db,f.admin.id,'test.event','target');assert.throws(()=>f.db.exec("UPDATE audit SET event='changed'"));assert.throws(()=>f.db.exec('DELETE FROM audit'));assert.throws(()=>call(f,f.recruiter,'GET','admin/audit'));assert.equal(call(f,f.admin,'GET','admin/audit')[0].event,'test.event');f.db.close();});
test('plain text parser and job template return honest methods',()=>{const f=fixture();assert.equal(call(f,f.recruiter,'POST','resume/parse',{text:'Contact: hi@example.com'}).email,'hi@example.com');assert.match(call(f,f.recruiter,'POST','jd/draft',{title:'Engineer',skills:['SQL']}).method,/not generative AI/);f.db.close();});
test('candidate editing updates candidate details, experience and enforces permissions and duplicate checks',()=>{
  const f=hiringFixture();
  const updated=call(f,f.recruiter,'PUT',`candidates/${f.candidate.id}`,{
    name:'Avery Chen Updated',
    email:'avery.updated@example.com',
    skills:['SQL','Node.js','JavaScript'],
    experience:'Over 10 years of backend and system architecture experience.',
    phone:'+1 (555) 999-8888',
    source:'Direct',
    team:'Engineering'
  });
  assert.equal(updated.name,'Avery Chen Updated');
  assert.equal(updated.email,'avery.updated@example.com');
  assert.deepEqual(updated.skills,['SQL','Node.js','JavaScript']);
  assert.equal(updated.experience,'Over 10 years of backend and system architecture experience.');
  assert.equal(updated.resume_text,'Over 10 years of backend and system architecture experience.');
  assert.equal(updated.phone,'+1 (555) 999-8888');

  const fetched=call(f,f.recruiter,'GET',`candidates/${f.candidate.id}`);
  assert.equal(fetched.name,'Avery Chen Updated');
  assert.equal(fetched.email,'avery.updated@example.com');
  assert.deepEqual(fetched.skills,['SQL','Node.js','JavaScript']);
  assert.equal(fetched.experience,'Over 10 years of backend and system architecture experience.');

  const auditEntry=f.db.prepare("SELECT * FROM audit WHERE event='candidate.updated' AND target=?").get(f.candidate.id);
  assert.ok(auditEntry);
  assert.equal(JSON.parse(auditEntry.detail).name,'Avery Chen Updated');

  const second=call(f,f.recruiter,'POST','candidates',{...candidateBody,email:'second.cand@example.com'});
  assert.throws(()=>call(f,f.recruiter,'PUT',`candidates/${f.candidate.id}`,{
    ...updated,
    email:'second.cand@example.com'
  }));

  assert.doesNotThrow(()=>call(f,f.recruiter,'PUT',`candidates/${f.candidate.id}`,{
    ...updated,
    name:'Avery C.'
  }));

  const interviewer=user(f.db,'Interviewer','Engineering');
  assert.throws(()=>call(f,interviewer,'PUT',`candidates/${f.candidate.id}`,{name:'Hacker'}));

  const employee=user(f.db,'Employee/Referral','Engineering');
  assert.throws(()=>call(f,employee,'PUT',`candidates/${f.candidate.id}`,{name:'Hacker'}));

  const otherTeamRecruiter=user(f.db,'Recruiter','Sales');
  assert.throws(()=>call(f,otherTeamRecruiter,'PUT',`candidates/${f.candidate.id}`,{name:'Cross-team'}));

  f.db.close();
});
test('skills validation accepts comma-separated skills and rejects unsupported characters/separators such as *, :, and &',()=>{
  const f=fixture();
  const validCandidate=call(f,f.recruiter,'POST','candidates',{
    ...candidateBody,
    email:'testing-skills@example.com',
    skills:['Manual Testing','Automation Testing']
  });
  assert.deepEqual(validCandidate.skills,['Manual Testing','Automation Testing']);

  const validCandidateStr=call(f,f.recruiter,'POST','candidates',{
    ...candidateBody,
    email:'testing-skills2@example.com',
    skills:'Manual Testing, Automation Testing'
  });
  assert.deepEqual(validCandidateStr.skills,['Manual Testing','Automation Testing']);

  assert.throws(
    ()=>call(f,f.recruiter,'POST','candidates',{...candidateBody,email:'err1@example.com',skills:['Manual Testing * Automation Testing']}),
    e=>e.status===400&&e.message.includes('expected comma-separated format')
  );
  assert.throws(
    ()=>call(f,f.recruiter,'POST','candidates',{...candidateBody,email:'err1@example.com',skills:'Manual Testing * Automation Testing'}),
    e=>e.status===400&&e.message.includes('expected comma-separated format')
  );

  assert.throws(
    ()=>call(f,f.recruiter,'POST','candidates',{...candidateBody,email:'err2@example.com',skills:['Manual Testing : Automation Testing']}),
    e=>e.status===400&&e.message.includes('expected comma-separated format')
  );
  assert.throws(
    ()=>call(f,f.recruiter,'POST','candidates',{...candidateBody,email:'err2@example.com',skills:'Manual Testing : Automation Testing'}),
    e=>e.status===400&&e.message.includes('expected comma-separated format')
  );

  assert.throws(
    ()=>call(f,f.recruiter,'POST','candidates',{...candidateBody,email:'err3@example.com',skills:['Manual Testing & Automation Testing']}),
    e=>e.status===400&&e.message.includes('expected comma-separated format')
  );
  assert.throws(
    ()=>call(f,f.recruiter,'POST','candidates',{...candidateBody,email:'err3@example.com',skills:'Manual Testing & Automation Testing'}),
    e=>e.status===400&&e.message.includes('expected comma-separated format')
  );

  assert.throws(
    ()=>call(f,f.recruiter,'POST','requisitions',{...reqBody,skills:['Manual Testing * Automation Testing']}),
    e=>e.status===400&&e.message.includes('expected comma-separated format')
  );

  assert.throws(
    ()=>call(f,f.recruiter,'PUT',`candidates/${validCandidate.id}`,{...validCandidate,skills:'Manual Testing & Automation Testing'}),
    e=>e.status===400&&e.message.includes('expected comma-separated format')
  );
  f.db.close();
});

test('interview editing updates scheduled date and time and validates future dates, permissions and status',()=>{
  const f=hiringFixture();
  const futureDate=new Date(Date.now()+86400000*2).toISOString();
  const created=call(f,f.recruiter,'POST','interviews',{
    application_id:f.app.id,
    interviewer_id:f.interviewer.id,
    scheduled_at:futureDate,
    competencies:['Technical analysis']
  });

  const rescheduledDate=new Date(Date.now()+86400000*5).toISOString();
  const updatedByRecruiter=call(f,f.recruiter,'PUT',`interviews/${created.id}`,{
    scheduled_at:rescheduledDate
  });
  assert.equal(updatedByRecruiter.scheduled_at,rescheduledDate);

  const rescheduledByInterviewer=new Date(Date.now()+86400000*6).toISOString();
  const updatedByInterviewer=call(f,f.interviewer,'PUT',`interviews/${created.id}`,{
    scheduled_at:rescheduledByInterviewer
  });
  assert.equal(updatedByInterviewer.scheduled_at,rescheduledByInterviewer);

  // Past date validation
  assert.throws(
    ()=>call(f,f.recruiter,'PUT',`interviews/${created.id}`,{scheduled_at:'2020-01-01T10:00:00.000Z'}),
    e=>e.status===400&&e.message.includes('future interview date')
  );

  // Unauthorized user rejection
  const unauthorized=user(f.db,'Employee/Referral');
  assert.throws(
    ()=>call(f,unauthorized,'PUT',`interviews/${created.id}`,{scheduled_at:new Date(Date.now()+86400000*7).toISOString()}),
    e=>e.status===403
  );

  // Completed interview cannot be edited
  call(f,f.interviewer,'POST',`interviews/${created.id}/scorecards`,{
    ratings:{'Technical analysis':4},
    recommendation:'Yes',
    notes:'Good discussion'
  });
  assert.throws(
    ()=>call(f,f.recruiter,'PUT',`interviews/${created.id}`,{scheduled_at:new Date(Date.now()+86400000*8).toISOString()}),
    e=>e.status===409&&e.message.includes('Completed interviews cannot be edited')
  );

  f.db.close();
});

test('requisition editing updates requisition details and enforces approval status and permissions',()=>{
  const f=fixture();
  // 1. Create a draft requisition
  const draft=call(f,f.recruiter,'POST','requisitions',reqBody);
  assert.equal(draft.status,'draft');
  assert.equal(draft.title,reqBody.title);

  // 2. Edit draft requisition details
  const updated=call(f,f.recruiter,'PUT',`requisitions/${draft.id}`,{
    title:'Principal Systems Architect',
    team:'Engineering',
    headcount:3,
    salary_min:180000,
    salary_max:240000,
    currency:'USD',
    description:'Lead system architecture, distributed services, and platform engineering.',
    skills:['Distributed Systems','Go','Kubernetes']
  });
  assert.equal(updated.title,'Principal Systems Architect');
  assert.equal(updated.headcount,3);
  assert.equal(updated.salary_min,180000);
  assert.equal(updated.salary_max,240000);
  assert.equal(updated.currency,'USD');
  assert.equal(updated.description,'Lead system architecture, distributed services, and platform engineering.');
  assert.deepEqual(updated.skills,['Distributed Systems','Go','Kubernetes']);

  // Verify GET by ID returns updated fields
  const fetched=call(f,f.recruiter,'GET',`requisitions/${draft.id}`);
  assert.equal(fetched.title,'Principal Systems Architect');
  assert.equal(fetched.headcount,3);
  assert.deepEqual(fetched.skills,['Distributed Systems','Go','Kubernetes']);

  // Verify audit entry
  const auditEntry=f.db.prepare("SELECT * FROM audit WHERE event='requisition.updated' AND target=?").get(draft.id);
  assert.ok(auditEntry);
  assert.equal(JSON.parse(auditEntry.detail).title,'Principal Systems Architect');

  // 3. Validation errors
  // Salary min > max
  assert.throws(
    ()=>call(f,f.recruiter,'PUT',`requisitions/${draft.id}`,{salary_min:300000,salary_max:200000}),
    e=>e.status===400&&e.message.includes('Minimum salary exceeds maximum')
  );
  // Invalid currency
  assert.throws(
    ()=>call(f,f.recruiter,'PUT',`requisitions/${draft.id}`,{currency:'XYZ'}),
    e=>e.status===400&&e.message.includes('supported three-letter currency code')
  );
  // Invalid skills with special characters
  assert.throws(
    ()=>call(f,f.recruiter,'PUT',`requisitions/${draft.id}`,{skills:['Go & Rust']}),
    e=>e.status===400&&e.message.includes('comma-separated format')
  );
  // Headcount < 1
  assert.throws(
    ()=>call(f,f.recruiter,'PUT',`requisitions/${draft.id}`,{headcount:0}),
    e=>e.status===400
  );

  // 4. Permissions and team isolation
  const otherTeamRecruiter=user(f.db,'Recruiter','Sales');
  assert.throws(
    ()=>call(f,otherTeamRecruiter,'PUT',`requisitions/${draft.id}`,{title:'Hacked Title'}),
    e=>e.status===403
  );
  const unauthorizedUser=user(f.db,'Employee/Referral');
  assert.throws(
    ()=>call(f,unauthorizedUser,'PUT',`requisitions/${draft.id}`,{title:'Hacked Title'}),
    e=>e.status===403
  );

  // Hiring manager in the same team can edit
  const manager=user(f.db,'Hiring Manager','Engineering');
  const managerUpdated=call(f,manager,'PUT',`requisitions/${draft.id}`,{title:'Principal Architect (HM Edit)'});
  assert.equal(managerUpdated.title,'Principal Architect (HM Edit)');

  // 5. Status constraints: pending requisition cannot be edited
  call(f,f.recruiter,'POST',`requisitions/${draft.id}/submit`);
  assert.throws(
    ()=>call(f,f.recruiter,'PUT',`requisitions/${draft.id}`,{title:'Cannot Edit While Pending'}),
    e=>e.status===409&&e.message.includes('awaiting approval')
  );

  // Reject requisition: rejected requisition cannot be edited
  call(f,f.manager,'POST',`requisitions/${draft.id}/reject`,{note:'Not approved'});
  assert.throws(
    ()=>call(f,f.recruiter,'PUT',`requisitions/${draft.id}`,{title:'Cannot Edit Rejected'}),
    e=>e.status===409
  );

  // 6. Open requisition editing and headcount constraint with hired candidate
  const hf=hiringFixture();
  const openReq=call(hf,hf.recruiter,'GET',`requisitions/${hf.req.id}`);
  assert.equal(openReq.status,'open');
  const openUpdated=call(hf,hf.recruiter,'PUT',`requisitions/${hf.req.id}`,{
    description:'Updated description for open role',
    headcount:5
  });
  assert.equal(openUpdated.description,'Updated description for open role');
  assert.equal(openUpdated.headcount,5);

  // Move candidate to Hired
  for(const stage of ['Screening','Interview','Offer','Hired']){
    call(hf,hf.recruiter,'POST',`applications/${hf.app.id}/stage`,{stage});
  }

  // Add a second hired candidate
  const c2=call(hf,hf.recruiter,'POST','candidates',{...candidateBody,email:'second.hired@example.com'});
  const a2=call(hf,hf.recruiter,'POST','applications',{candidate_id:c2.id,requisition_id:hf.req.id});
  for(const stage of ['Screening','Interview','Offer','Hired']){
    call(hf,hf.recruiter,'POST',`applications/${a2.id}/stage`,{stage});
  }

  // Attempt to reduce headcount below 2 hired candidates
  assert.throws(
    ()=>call(hf,hf.recruiter,'PUT',`requisitions/${hf.req.id}`,{headcount:1}),
    e=>e.status===409&&e.message.includes('Headcount cannot be less than the number of hired candidates')
  );
  assert.throws(
    ()=>call(hf,hf.admin,'PUT',`requisitions/${hf.req.id}`,{team:'Sales'}),
    e=>e.status===409&&e.message.includes('existing applications')
  );

  f.db.close();
  hf.db.close();
});


