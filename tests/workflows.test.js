import test from 'node:test';
import assert from 'node:assert/strict';
import { service,matchSkills } from '../src/service.js';
import { can,roles } from '../src/policy.js';
import { audit } from '../src/db.js';
import { fixture,user,reqBody,candidateBody,addSignedOffer } from './helpers.js';
const call=(f,u,m,p,b)=>service(f.db,u,m,p,b);
const markInterviewReady=(f,interview)=>f.db.prepare('UPDATE interviews SET scheduled_at=? WHERE id=?').run(new Date(Date.now()-60000).toISOString(),interview.id);
function hiringFixture(){const f=fixture();f.req=call(f,f.recruiter,'POST','requisitions',reqBody);call(f,f.recruiter,'POST',`requisitions/${f.req.id}/submit`);call(f,f.manager,'POST',`requisitions/${f.req.id}/approve`,{});call(f,f.finance,'POST',`requisitions/${f.req.id}/approve`,{});f.candidate=call(f,f.recruiter,'POST','candidates',candidateBody);f.app=call(f,f.recruiter,'POST','applications',{candidate_id:f.candidate.id,requisition_id:f.req.id});return f;}
test('requester, manager and finance approval sequence opens headcount',()=>{const f=fixture();const req=call(f,f.recruiter,'POST','requisitions',reqBody);assert.equal(req.status,'draft');assert.throws(()=>call(f,f.recruiter,'POST',`requisitions/${req.id}/approve`));call(f,f.recruiter,'POST',`requisitions/${req.id}/submit`);assert.throws(()=>call(f,f.finance,'POST',`requisitions/${req.id}/approve`,{}));assert.equal(call(f,f.manager,'POST',`requisitions/${req.id}/approve`,{}).status,'pending_finance');assert.equal(call(f,f.finance,'POST',`requisitions/${req.id}/approve`,{}).status,'open');assert.equal(f.db.prepare('SELECT count(*) n FROM approvals').get().n,2);f.db.close();});
test('self approval is allowed when permission is granted, but same person at both steps is forbidden without override',()=>{const f=fixture();const r=call(f,f.admin,'POST','requisitions',reqBody);call(f,f.admin,'POST',`requisitions/${r.id}/submit`);const app1=call(f,f.admin,'POST',`requisitions/${r.id}/approve`,{});assert.equal(app1.status,'pending_finance');assert.throws(()=>call(f,f.admin,'POST',`requisitions/${r.id}/approve`,{}),e=>e.status===403);f.db.close();});
test('rejected requisition cannot receive applications',()=>{const f=fixture();const r=call(f,f.recruiter,'POST','requisitions',reqBody);call(f,f.recruiter,'POST',`requisitions/${r.id}/submit`);call(f,f.manager,'POST',`requisitions/${r.id}/reject`,{note:'Budget unavailable'});const c=call(f,f.recruiter,'POST','candidates',candidateBody);assert.throws(()=>call(f,f.recruiter,'POST','applications',{candidate_id:c.id,requisition_id:r.id}));f.db.close();});
test('candidate duplicates are case insensitive and safe against SQL injection',()=>{const f=fixture();call(f,f.recruiter,'POST','candidates',candidateBody);assert.throws(()=>call(f,f.recruiter,'POST','candidates',{...candidateBody,email:'AVERY@EXAMPLE.COM'}));const c=call(f,f.recruiter,'POST','candidates',{...candidateBody,email:'second@example.com',name:"Robert'); DROP TABLE users;--"});assert.ok(c.id);assert.ok(f.db.prepare('SELECT count(*) n FROM users').get().n>0);f.db.close();});
test('team isolation protects reads, writes and record IDs',()=>{const f=hiringFixture(),other=user(f.db,'Recruiter','Sales');assert.equal(call(f,other,'GET','candidates').length,0);assert.equal(call(f,other,'GET','applications').length,0);assert.throws(()=>call(f,other,'POST',`applications/${f.app.id}/stage`,{stage:'Screening'}));assert.throws(()=>call(f,other,'POST','candidates',candidateBody));f.db.close();});
test('roles deny admin access, financial approval and candidate access by default',()=>{const f=fixture();for(const role of roles.filter(r=>r!=='System Admin')){const u=user(f.db,role);assert.throws(()=>call(f,u,'GET','admin/users'));}for(const role of ['Employee/Referral','Interviewer','Finance Approver','Agency']){const u=user(f.db,role);assert.throws(()=>call(f,u,'GET','candidates'));}assert.equal(can(user(f.db,'Agency'),'jobs'),false);f.db.close();});
test('manual user provisioning requires Entra IDs and rejects optional agency role',()=>{const f=fixture();assert.throws(()=>call(f,f.admin,'POST','admin/users',{email:'new@example.com',name:'New',role:'Recruiter',team:'Engineering'}));assert.throws(()=>call(f,f.admin,'POST','admin/users',{email:'new@example.com',name:'New',role:'Agency'}));assert.equal(call(f,f.admin,'POST','admin/users',{email:'new@example.com',name:'New',role:'Recruiter',team:'Engineering',oid:'44444444-4444-4444-4444-444444444444',tenant:'11111111-1111-1111-1111-111111111111'}).status,'active');f.db.close();});
test('pipeline records transitions, prevents skipping and enforces terminal stages/headcount',()=>{const f=hiringFixture();assert.throws(()=>call(f,f.recruiter,'POST',`applications/${f.app.id}/stage`,{stage:'Hired'}));for(const stage of ['Screening','Interview','Offer'])call(f,f.recruiter,'POST',`applications/${f.app.id}/stage`,{stage});addSignedOffer(f.db,f.app.id,f.candidate,f.req);call(f,f.recruiter,'POST',`applications/${f.app.id}/stage`,{stage:'Hired'});assert.throws(()=>call(f,f.recruiter,'POST',`applications/${f.app.id}/stage`,{stage:'Rejected'}));const c=call(f,f.recruiter,'POST','candidates',{...candidateBody,email:'second@example.com'}),a=call(f,f.recruiter,'POST','applications',{candidate_id:c.id,requisition_id:f.req.id});for(const stage of ['Screening','Interview','Offer'])call(f,f.recruiter,'POST',`applications/${a.id}/stage`,{stage});assert.throws(()=>call(f,f.recruiter,'POST',`applications/${a.id}/stage`,{stage:'Hired'}));assert.equal(f.db.prepare('SELECT count(*) n FROM stage_events').get().n,7);f.db.close();});
test('pipeline configuration rejects removal of occupied stages',()=>{const f=hiringFixture();call(f,f.recruiter,'POST',`applications/${f.app.id}/stage`,{stage:'Screening'});assert.throws(()=>call(f,f.admin,'PUT','pipeline',{stages:['Applied','Hired','Rejected']}));assert.throws(()=>call(f,f.recruiter,'PUT','pipeline',{stages:['Applied','Hired','Rejected']}));assert.deepEqual(call(f,f.admin,'PUT','pipeline',{stages:['Applied','Screening','Assessment','Interview','Offer','Hired','Rejected']}).slice(0,3),['Applied','Screening','Assessment']);f.db.close();});
test('matching explanation uses explicit skills and handles absent job criteria',()=>{const f=hiringFixture(),r=call(f,f.recruiter,'GET',`applications/${f.app.id}/match`);assert.equal(r.score,50);assert.deepEqual(r.missing,['JavaScript']);assert.equal(matchSkills(f.candidate,{skills:'[]'}).score,null);f.db.close();});
test('interview assignment, structured scorecard, feedback blinding and immutable submission',()=>{const f=hiringFixture(),second=user(f.db,'Interviewer'),unassigned=user(f.db,'Interviewer');const schedule=u=>{const i=call(f,f.recruiter,'POST','interviews',{application_id:f.app.id,interviewer_id:u.id,scheduled_at:new Date(Date.now()+86400000).toISOString(),competencies:['Technical','Communication']});markInterviewReady(f,i);return i;};const one=schedule(f.interviewer),two=schedule(second),score={ratings:{Technical:4,Communication:3},recommendation:'Yes',notes:'Solved the exercise and explained the tradeoffs.'};call(f,f.interviewer,'POST',`interviews/${one.id}/scorecards`,score);assert.throws(()=>call(f,f.interviewer,'POST',`interviews/${one.id}/scorecards`,score));assert.throws(()=>call(f,second,'POST',`interviews/${one.id}/scorecards`,score));assert.throws(()=>call(f,unassigned,'GET',`interviews/${one.id}/scorecards`));let view=call(f,second,'GET',`interviews/${two.id}/scorecards`);assert.equal(view.blinded,true);assert.equal(view.scorecards.length,0);call(f,second,'POST',`interviews/${two.id}/scorecards`,score);view=call(f,second,'GET',`interviews/${two.id}/scorecards`);assert.equal(view.blinded,false);assert.equal(view.scorecards.length,2);f.db.close();});
test('invalid scorecards and past interview dates fail validation',()=>{const f=hiringFixture();assert.throws(()=>call(f,f.recruiter,'POST','interviews',{application_id:f.app.id,interviewer_id:f.interviewer.id,scheduled_at:'2000-01-01',competencies:['Skill']}));const i=call(f,f.recruiter,'POST','interviews',{application_id:f.app.id,interviewer_id:f.interviewer.id,scheduled_at:new Date(Date.now()+86400000).toISOString(),competencies:['Skill']});assert.throws(()=>call(f,f.interviewer,'POST',`interviews/${i.id}/scorecards`,{ratings:{Skill:6},recommendation:'Yes',notes:'Evidence'}));f.db.close();});
test('scorecards are blocked before the scheduled interview time and leave the interview planned',()=>{
  const f=hiringFixture();
  const scheduledAt=new Date(Date.now()+3600000).toISOString();
  const interview=call(f,f.recruiter,'POST','interviews',{
    application_id:f.app.id,
    interviewer_id:f.interviewer.id,
    scheduled_at:scheduledAt,
    competencies:['Technical','Communication']
  });
  const score={ratings:{Technical:4,Communication:3},recommendation:'Yes',notes:'Evidence submitted too early.'};
  assert.throws(
    ()=>call(f,f.interviewer,'POST',`interviews/${interview.id}/scorecards`,score),
    e=>e.status===409&&e.message==='Feedback can be submitted after the scheduled interview time.'
  );
  assert.equal(call(f,f.recruiter,'GET',`interviews/${interview.id}`).status,'planned');
  assert.equal(f.db.prepare('SELECT count(*) n FROM scorecards WHERE interview_id=?').get(interview.id).n,0);

  // Once the timezone-aware scheduled timestamp has passed, submission completes the interview.
  markInterviewReady(f,interview);
  const submitted=call(f,f.interviewer,'POST',`interviews/${interview.id}/scorecards`,score);
  assert.ok(submitted.id);
  assert.equal(call(f,f.recruiter,'GET',`interviews/${interview.id}`).status,'completed');
  f.db.close();
});

test('Agency role remains limited to its portal and is denied internal ATS APIs',()=>{
  const f=fixture();
  const agency=user(f.db,'Agency','QA');
  const me=call(f,agency,'GET','me');
  assert.deepEqual(me.permissions,[]);
  for(const path of ['requisitions','candidates','applications','interviews','analytics']){
    assert.throws(
      ()=>call(f,agency,'GET',path),
      e=>e.status===403&&e.message==='Your role cannot perform this action.'
    );
  }
  assert.throws(
    ()=>call(f,agency,'POST','referrals',{requisition_id:'missing',name:'Agency Candidate',email:'agency@example.com'}),
    e=>e.status===403
  );
  f.db.close();
});

test('referrals reveal only the submitting employee records',()=>{const f=hiringFixture(),employee=user(f.db,'Employee/Referral'),other=user(f.db,'Employee/Referral');call(f,employee,'POST','referrals',{requisition_id:f.req.id,name:'Referral',email:'ref@example.com',note:'Worked together'});assert.equal(call(f,employee,'GET','referrals').length,1);assert.equal(call(f,other,'GET','referrals').length,0);assert.equal(call(f,employee,'GET','requisitions')[0].salary_max,undefined);f.db.close();});
test('analytics are scoped to the actor team',()=>{const f=hiringFixture(),other=user(f.db,'Recruiter','Sales');assert.equal(call(f,f.recruiter,'GET','analytics').candidates,1);assert.equal(call(f,other,'GET','analytics').candidates,0);f.db.close();});
test('audit records are append-only and admin-only',()=>{const f=fixture();audit(f.db,f.admin.id,'test.event','target');assert.throws(()=>f.db.exec("UPDATE audit SET event='changed'"));assert.throws(()=>f.db.exec('DELETE FROM audit'));assert.throws(()=>call(f,f.recruiter,'GET','admin/audit'));assert.equal(call(f,f.admin,'GET','admin/audit')[0].event,'test.event');f.db.close();});
test('plain text parser and job template return honest methods',()=>{
  const f=fixture();
  const parsed=call(f,f.recruiter,'POST','resume/parse',{text:'Contact: hi@example.com, Phone: +1 555-123-4567'});
  assert.equal(parsed.email,'hi@example.com');
  assert.equal(parsed.phone,'+1 555-123-4567');
  assert.equal(parsed.message,'Email and phone number extracted successfully.');

  const emptyParsed=call(f,f.recruiter,'POST','resume/parse',{text:'No contact info here.'});
  assert.equal(emptyParsed.email,'');
  assert.equal(emptyParsed.phone,'');
  assert.equal(emptyParsed.message,'No email or phone number found in resume text.');

  assert.throws(()=>call(f,f.recruiter,'POST','resume/parse',{text:''}),e=>e.status===400);

  const draft=call(f,f.recruiter,'POST','jd/draft',{title:'Engineer',skills:['SQL']});
  assert.equal(draft.message,'Job description drafted. Please review before saving.');
  assert.doesNotMatch(JSON.stringify(draft),/not generative AI/i);
  assert.match(draft.draft,/Engineer/);
  assert.match(draft.draft,/SQL/);
  assert.throws(()=>call(f,f.recruiter,'POST','jd/draft',{title:'Engineer',skills:[]}),e=>e.status===400);
  f.db.close();
});
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

  assert.throws(
    ()=>call(f,f.recruiter,'PUT',`candidates/${f.candidate.id}`,{
      ...updated,
      phone:'abc123'
    }),
    e=>e.status===400&&e.message==='Enter a valid phone number.'
  );

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

test('candidate email validation rejects malformed email formats and accepts valid formats',()=>{
  const f=fixture();
  const malformedEmails=[
    'gaurvi..gupta@example.com',
    '.gaurvi@example.com',
    'gaurvi.@example.com',
    '..@example.com',
    'test..user@domain.com',
    '.leading@domain.com',
    'trailing.@domain.com'
  ];

  for(const badEmail of malformedEmails){
    assert.throws(
      ()=>call(f,f.recruiter,'POST','candidates',{...candidateBody,email:badEmail}),
      e=>e.status===400&&e.message==='Enter a valid email address.'
    );
    assert.throws(
      ()=>call(f,f.admin,'POST','candidates',{...candidateBody,email:badEmail,team:'Dev'}),
      e=>e.status===400&&e.message==='Enter a valid email address.'
    );
  }

  assert.equal(f.db.prepare('SELECT count(*) n FROM candidates').get().n,0);

  const cand=call(f,f.recruiter,'POST','candidates',{...candidateBody,email:'gaurvi.gupta@example.com'});
  assert.ok(cand.id);
  assert.equal(cand.email,'gaurvi.gupta@example.com');
  assert.equal(f.db.prepare('SELECT count(*) n FROM candidates WHERE email=?').get('gaurvi.gupta@example.com').n,1);

  for(const badEmail of malformedEmails){
    assert.throws(
      ()=>call(f,f.recruiter,'PUT',`candidates/${cand.id}`,{email:badEmail}),
      e=>e.status===400&&e.message==='Enter a valid email address.'
    );
  }

  const updated=call(f,f.recruiter,'PUT',`candidates/${cand.id}`,{email:'gaurvi.updated@example.com'});
  assert.equal(updated.email,'gaurvi.updated@example.com');
  assert.equal(f.db.prepare('SELECT email FROM candidates WHERE id=?').get(cand.id).email,'gaurvi.updated@example.com');

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

  // Verify initial listing returns original interviewer
  const initialListing = call(f, f.recruiter, 'GET', 'interviews');
  assert.equal(initialListing.find(i=>i.id===created.id).interviewer_id, f.interviewer.id);
  assert.equal(initialListing.find(i=>i.id===created.id).interviewer, f.interviewer.name);

  // Recruiter reschedules date/time
  const rescheduledDate=new Date(Date.now()+86400000*5).toISOString();
  const updatedByRecruiter=call(f,f.recruiter,'PUT',`interviews/${created.id}`,{
    scheduled_at:rescheduledDate
  });
  assert.equal(updatedByRecruiter.scheduled_at,rescheduledDate);

  // Assigned interviewer reschedules date/time
  const rescheduledByInterviewer=new Date(Date.now()+86400000*6).toISOString();
  const updatedByInterviewer=call(f,f.interviewer,'PUT',`interviews/${created.id}`,{
    scheduled_at:rescheduledByInterviewer
  });
  assert.equal(updatedByInterviewer.scheduled_at,rescheduledByInterviewer);

  // Recruiter reassigns interviewer to another eligible team member
  const secondInterviewer = user(f.db, 'Interviewer', f.req.team);
  const reassignedDate = new Date(Date.now()+86400000*7).toISOString();
  const reassigned = call(f, f.recruiter, 'PUT', `interviews/${created.id}`, {
    scheduled_at: reassignedDate,
    interviewer_id: secondInterviewer.id
  });
  assert.equal(reassigned.interviewer_id, secondInterviewer.id);
  assert.equal(reassigned.scheduled_at, reassignedDate);

  // Verify changes persist across GET /api/interviews and GET /api/interviews/:id
  const updatedListing = call(f, f.recruiter, 'GET', 'interviews');
  const listed = updatedListing.find(i=>i.id===created.id);
  assert.equal(listed.interviewer_id, secondInterviewer.id);
  assert.equal(listed.interviewer, secondInterviewer.name);
  assert.equal(listed.scheduled_at, reassignedDate);

  const detail = call(f, f.recruiter, 'GET', `interviews/${created.id}`);
  assert.equal(detail.interviewer_id, secondInterviewer.id);
  assert.equal(detail.interviewer, secondInterviewer.name);
  assert.equal(detail.scheduled_at, reassignedDate);

  // Assigned interviewer without recruit permission cannot reassign interviewer
  assert.throws(
    ()=>call(f, secondInterviewer, 'PUT', `interviews/${created.id}`, { scheduled_at: new Date(Date.now()+86400000*8).toISOString(), interviewer_id: f.interviewer.id }),
    e=>e.status===403
  );

  // Inactive interviewer rejection
  const disabledInterviewer = user(f.db, 'Interviewer', f.req.team, 'disabled');
  assert.throws(
    ()=>call(f, f.recruiter, 'PUT', `interviews/${created.id}`, { scheduled_at: new Date(Date.now()+86400000*8).toISOString(), interviewer_id: disabledInterviewer.id }),
    e=>e.status===400 && e.message.includes('active interviewer')
  );

  // Non-existent interviewer ID rejection
  assert.throws(
    ()=>call(f, f.recruiter, 'PUT', `interviews/${created.id}`, { scheduled_at: new Date(Date.now()+86400000*8).toISOString(), interviewer_id: 'non-existent-user' }),
    e=>e.status===404
  );

  // Cross-team interviewer rejection
  const otherTeamInterviewer = user(f.db, 'Interviewer', 'HR');
  assert.throws(
    ()=>call(f, f.recruiter, 'PUT', `interviews/${created.id}`, { scheduled_at: new Date(Date.now()+86400000*8).toISOString(), interviewer_id: otherTeamInterviewer.id }),
    e=>e.status===400 && e.message.includes('can access this team')
  );

  // Cross-team recruiter rejection
  const crossTeamRecruiter = user(f.db, 'Recruiter', 'HR');
  assert.throws(
    ()=>call(f, crossTeamRecruiter, 'PUT', `interviews/${created.id}`, { scheduled_at: new Date(Date.now()+86400000*8).toISOString() }),
    e=>e.status===403
  );

  // Non-existent interview ID rejection
  assert.throws(
    ()=>call(f, f.recruiter, 'PUT', 'interviews/non-existent-id', { scheduled_at: new Date(Date.now()+86400000*8).toISOString() }),
    e=>e.status===404
  );

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
  markInterviewReady(f, created);
  call(f,secondInterviewer,'POST',`interviews/${created.id}/scorecards`,{
    ratings:{'Technical analysis':4},
    recommendation:'Yes',
    notes:'Good discussion'
  });
  assert.throws(
    ()=>call(f,f.recruiter,'PUT',`interviews/${created.id}`,{scheduled_at:new Date(Date.now()+86400000*8).toISOString()}),
    e=>e.status===409&&e.message.includes('Completed interviews cannot be edited')
  );

  // Verify audit logging
  assert.ok(f.db.prepare("SELECT * FROM audit WHERE event='interview.updated' AND target=?").get(created.id));

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
  for(const stage of ['Screening','Interview','Offer']){
    call(hf,hf.recruiter,'POST',`applications/${hf.app.id}/stage`,{stage});
  }
  addSignedOffer(hf.db, hf.app.id, hf.candidate, hf.req);
  call(hf,hf.recruiter,'POST',`applications/${hf.app.id}/stage`,{stage:'Hired'});

  // Add a second hired candidate
  const c2=call(hf,hf.recruiter,'POST','candidates',{...candidateBody,email:'second.hired@example.com'});
  const a2=call(hf,hf.recruiter,'POST','applications',{candidate_id:c2.id,requisition_id:hf.req.id});
  for(const stage of ['Screening','Interview','Offer']){
    call(hf,hf.recruiter,'POST',`applications/${a2.id}/stage`,{stage});
  }
  addSignedOffer(hf.db, a2.id, c2, hf.req);
  call(hf,hf.recruiter,'POST',`applications/${a2.id}/stage`,{stage:'Hired'});

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

test('requisition currency validation rejects unsupported values and accepts supported currencies',()=>{
  const f=fixture();
  const unsupportedCurrencies=['@@@','123','XYZ','ABC','','!@#'];
  for(const cur of unsupportedCurrencies){
    assert.throws(
      ()=>call(f,f.recruiter,'POST','requisitions',{...reqBody,currency:cur}),
      e=>e.status===400&&e.message==='Enter a supported three-letter currency code.'
    );
  }

  for(const cur of ['USD','eur','gbp','inr']){
    const req=call(f,f.recruiter,'POST','requisitions',{...reqBody,title:`Req in ${cur}`,currency:cur});
    assert.ok(req.id);
    assert.equal(req.currency,cur.trim().toUpperCase());
  }
  f.db.close();
});

test('System Admin permission enhancements, overrides, proxy scorecard, and team dropdowns', () => {
  const f = fixture();
  const call = (u, m, p, b) => service(f.db, u, m, p, b);

  // 1. Policy grants in /api/me: System Admin has all 10 grants, including requisition and interview
  const meAdmin = call(f.admin, 'GET', 'me');
  assert.ok(meAdmin.permissions.includes('requisition'), 'Admin must have requisition grant');
  assert.ok(meAdmin.permissions.includes('interview'), 'Admin must have interview grant');
  assert.equal(meAdmin.permissions.length, 10);
  assert.ok(Array.isArray(meAdmin.teams) && meAdmin.teams.includes('Dev') && meAdmin.teams.includes('TL'));

  // Non-admin roles retain boundaries
  const meInterviewer = call(f.interviewer, 'GET', 'me');
  assert.ok(!meInterviewer.permissions.includes('requisition'));
  assert.ok(!meInterviewer.permissions.includes('admin'));

  // 2. Organization-wide referral visibility:
  const employeeSales = user(f.db, 'Employee/Referral', 'Sales');
  const reqSales = call(f.admin, 'POST', 'requisitions', { ...reqBody, team: 'Sales' });
  call(f.admin, 'POST', `requisitions/${reqSales.id}/submit`);
  call(f.admin, 'POST', `requisitions/${reqSales.id}/approve`, { emergency_override: true, override_reason: 'Testing approval manager' });
  call(f.admin, 'POST', `requisitions/${reqSales.id}/approve`, { emergency_override: true, override_reason: 'Testing approval finance' });
  const ref1 = call(employeeSales, 'POST', 'referrals', { name: 'Ref Candidate', email: 'ref@example.com', requisition_id: reqSales.id, note: 'Great candidate' });

  const employeeEng = user(f.db, 'Employee/Referral', 'Engineering');
  const reqEng = call(f.recruiter, 'POST', 'requisitions', reqBody);
  call(f.recruiter, 'POST', `requisitions/${reqEng.id}/submit`);
  call(f.manager, 'POST', `requisitions/${reqEng.id}/approve`, {});
  call(f.finance, 'POST', `requisitions/${reqEng.id}/approve`, {});
  const ref2 = call(employeeEng, 'POST', 'referrals', { name: 'Eng Ref', email: 'engref@example.com', requisition_id: reqEng.id, note: 'Engineer' });

  // Non-admin employeeEng only sees their own referral
  const engRefs = call(employeeEng, 'GET', 'referrals');
  assert.equal(engRefs.length, 1);
  assert.equal(engRefs[0].id, ref2.id);

  // System Admin sees all referrals across teams
  const allRefs = call(f.admin, 'GET', 'referrals');
  assert.ok(allRefs.length >= 2);
  assert.ok(allRefs.some(r => r.id === ref1.id));
  assert.ok(allRefs.some(r => r.id === ref2.id));

  // 3. Requisition editing in pending approval states
  const pendingReq = call(f.recruiter, 'POST', 'requisitions', { ...reqBody, title: 'Pending Dev Lead' });
  call(f.recruiter, 'POST', `requisitions/${pendingReq.id}/submit`);
  // Non-admin cannot edit pending requisition
  assert.throws(
    () => call(f.recruiter, 'PUT', `requisitions/${pendingReq.id}`, { title: 'New Title' }),
    e => e.status === 409
  );
  // System Admin CAN edit pending requisition
  const adminEdited = call(f.admin, 'PUT', `requisitions/${pendingReq.id}`, { title: 'Pending Dev Lead (Admin Correction)' });
  assert.equal(adminEdited.title, 'Pending Dev Lead (Admin Correction)');

  // 4. Team reassignment with existing applications
  const cand = call(f.recruiter, 'POST', 'candidates', candidateBody);
  const app = call(f.recruiter, 'POST', 'applications', { candidate_id: cand.id, requisition_id: reqEng.id });
  // Without admin_override, throws 409
  assert.throws(
    () => call(f.admin, 'PUT', `requisitions/${reqEng.id}`, { team: 'QA' }),
    e => e.status === 409 && e.message.includes('existing applications')
  );
  // Non-admin with admin_override still throws 409
  assert.throws(
    () => call(f.recruiter, 'PUT', `requisitions/${reqEng.id}`, { team: 'QA', admin_override: true }),
    e => e.status === 403 || e.status === 409
  );
  // System Admin with admin_override succeeds
  const reteamed = call(f.admin, 'PUT', `requisitions/${reqEng.id}`, { team: 'QA', admin_override: true });
  assert.equal(reteamed.team, 'QA');
  const reteamAudit = f.db.prepare("SELECT * FROM audit WHERE event='requisition.updated' AND target=?").get(reqEng.id);
  assert.ok(reteamAudit);
  assert.equal(JSON.parse(reteamAudit.detail).admin_team_reassignment, true);

  // 5. Emergency approval override
  const reqOverride = call(f.admin, 'POST', 'requisitions', { ...reqBody, team: 'Dev' });
  call(f.admin, 'POST', `requisitions/${reqOverride.id}/submit`);
  // Requester with permission can self-approve at manager step
  const approvedManager = call(f.admin, 'POST', `requisitions/${reqOverride.id}/approve`, { note: 'Manager self-approval' });
  assert.equal(approvedManager.status, 'pending_finance');

  // Same approver cannot approve finance stage without emergency override (same approver at both steps)
  assert.throws(
    () => call(f.admin, 'POST', `requisitions/${reqOverride.id}/approve`, {}),
    e => e.status === 403 && e.message.includes('Requester and each approver must be different people')
  );
  // Non-admin cannot invoke emergency override
  assert.throws(
    () => call(f.recruiter, 'POST', `requisitions/${reqOverride.id}/approve`, { emergency_override: true, override_reason: 'Bypass' }),
    e => e.status === 403
  );
  // Emergency override without reason fails
  assert.throws(
    () => call(f.admin, 'POST', `requisitions/${reqOverride.id}/approve`, { emergency_override: true, override_reason: '' }),
    e => e.status === 400 && e.message.includes('reason')
  );
  // Emergency override succeeds for finance stage
  const approvedFinance = call(f.admin, 'POST', `requisitions/${reqOverride.id}/approve`, {
    emergency_override: true,
    override_reason: 'Finance Director on medical leave, overriding per authorized procedure'
  });
  assert.equal(approvedFinance.status, 'open');
  const emAudit1 = f.db.prepare("SELECT * FROM audit WHERE event='admin.emergency_approval_override' AND target=?").get(reqOverride.id);
  assert.ok(emAudit1);
  const detail1 = JSON.parse(emAudit1.detail);
  assert.equal(detail1.step, 'finance');
  assert.equal(detail1.bypassed_rule, 'same_approver_both_steps');

  // 6. Proxy scorecard submission & feedback unblinding
  const cand2 = call(f.admin, 'POST', 'candidates', { ...candidateBody, email: 'cand2@example.com', team: 'Dev' });
  const app2 = call(f.admin, 'POST', 'applications', { candidate_id: cand2.id, requisition_id: reqOverride.id });
  call(f.admin, 'POST', `applications/${app2.id}/stage`, { stage: 'Screening' });
  call(f.admin, 'POST', `applications/${app2.id}/stage`, { stage: 'Interview' });
  const scheduledTime = new Date(Date.now() + 86400000).toISOString();
  const assignedInterviewer = user(f.db, 'Interviewer', 'Dev');
  const interview2 = call(f.admin, 'POST', 'interviews', {
    application_id: app2.id,
    interviewer_id: assignedInterviewer.id,
    scheduled_at: scheduledTime,
    competencies: ['JavaScript', 'SQL']
  });
  markInterviewReady(f, interview2);

  // Non-assigned non-admin user cannot submit scorecard
  const otherInterviewer = user(f.db, 'Interviewer', 'Dev');
  assert.throws(
    () => call(otherInterviewer, 'POST', `interviews/${interview2.id}/scorecards`, {
      ratings: { JavaScript: 4, SQL: 4 },
      recommendation: 'Yes',
      notes: 'Good'
    }),
    e => e.status === 403
  );

  // Admin proxy submission without reason fails
  assert.throws(
    () => call(f.admin, 'POST', `interviews/${interview2.id}/scorecards`, {
      ratings: { JavaScript: 5, SQL: 4 },
      recommendation: 'Strong yes',
      notes: 'Submitted via proxy'
    }),
    e => e.status === 400 && e.message.includes('reason')
  );

  // Admin proxy submission with reason succeeds
  const proxyResult = call(f.admin, 'POST', `interviews/${interview2.id}/scorecards`, {
    ratings: { JavaScript: 5, SQL: 4 },
    recommendation: 'Strong yes',
    notes: 'Interviewer provided verbal scorecard due to network outage.',
    proxy_reason: 'Interviewer network outage during travel'
  });
  assert.equal(proxyResult.proxy_for, assignedInterviewer.id);

  // Verify scorecard persisted in DB with proxy_for and proxy_reason
  const scRecord = f.db.prepare('SELECT * FROM scorecards WHERE id=?').get(proxyResult.id);
  assert.equal(scRecord.author, f.admin.id);
  assert.equal(scRecord.proxy_for, assignedInterviewer.id);
  assert.equal(scRecord.proxy_reason, 'Interviewer network outage during travel');

  // Verify audit log for proxy scorecard
  const proxyAudit = f.db.prepare("SELECT * FROM audit WHERE event='admin.scorecard_proxy_submitted' AND target=?").get(proxyResult.id);
  assert.ok(proxyAudit);
  const proxyAuditDetail = JSON.parse(proxyAudit.detail);
  assert.equal(proxyAuditDetail.proxy_for, assignedInterviewer.id);
  assert.equal(proxyAuditDetail.proxy_reason, 'Interviewer network outage during travel');

  // Feedback visibility: System Admin is unblinded
  const adminFb = call(f.admin, 'GET', `interviews/${interview2.id}/scorecards`);
  assert.equal(adminFb.blinded, false);
  assert.equal(adminFb.scorecards.length, 1);
  assert.equal(adminFb.scorecards[0].proxy_for, assignedInterviewer.id);

  // 7. Cross-team candidate application
  const candQA = call(f.admin, 'POST', 'candidates', { ...candidateBody, email: 'qa.cand@example.com', team: 'QA' });
  const recruiterQA = user(f.db, 'Recruiter', 'QA');
  assert.throws(
    () => call(recruiterQA, 'POST', 'applications', { candidate_id: candQA.id, requisition_id: reqOverride.id }),
    e => e.status === 403 || e.status === 409
  );
  const crossApp = call(f.admin, 'POST', 'applications', { candidate_id: candQA.id, requisition_id: reqOverride.id });
  assert.ok(crossApp.id);
  const crossAudit = f.db.prepare("SELECT * FROM audit WHERE event='application.created' AND target=?").get(crossApp.id);
  assert.ok(crossAudit);
  assert.equal(JSON.parse(crossAudit.detail).cross_team_override, true);

  // 8. Pipeline admin override
  // Move candidate2 to Offer, then to Hired
  call(f.admin, 'POST', `applications/${app2.id}/stage`, { stage: 'Offer' });
  addSignedOffer(f.db, app2.id, cand2, reqOverride);
  call(f.admin, 'POST', `applications/${app2.id}/stage`, { stage: 'Hired' });
  // Candidate2 is now in terminal stage Hired
  // Non-admin cannot move terminal candidate
  const recruiterDev = user(f.db, 'Recruiter', 'Dev');
  assert.throws(
    () => call(recruiterDev, 'POST', `applications/${app2.id}/stage`, { stage: 'Offer' }),
    e => e.status === 409 && e.message.includes('Terminal')
  );
  // Admin without override flag cannot move terminal candidate
  assert.throws(
    () => call(f.admin, 'POST', `applications/${app2.id}/stage`, { stage: 'Offer' }),
    e => e.status === 409 && e.message.includes('override')
  );
  // Admin with admin_override can move terminal candidate
  const stageOverridden = call(f.admin, 'POST', `applications/${app2.id}/stage`, {
    stage: 'Offer',
    admin_override: true,
    override_reason: 'Administrative correction after candidate rescinded acceptance'
  });
  assert.equal(stageOverridden.stage, 'Offer');
  const stageAudit = f.db.prepare("SELECT * FROM audit WHERE event='admin.application_stage_override' AND target=?").get(app2.id);
  assert.ok(stageAudit);
  const stageDetail = JSON.parse(stageAudit.detail);
  assert.equal(stageDetail.admin_override, true);
  assert.equal(stageDetail.bypassed_rule, 'terminal_stage, non_sequential_transition');

  f.db.close();
});

test('pipeline allows sequential backward transitions for mistake correction while preventing skip-back', () => {
  const f = hiringFixture();
  assert.equal(f.app.stage, 'Applied');

  // Move forward to Screening
  const screening = call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening' });
  assert.equal(screening.stage, 'Screening');

  // Send back to Applied (mistake correction)
  const backToApplied = call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Applied' });
  assert.equal(backToApplied.stage, 'Applied');

  // Move forward again: Applied -> Screening -> Interview
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening' });
  const interview = call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview' });
  assert.equal(interview.stage, 'Interview');

  // Cannot skip backward: from Interview directly to Applied throws 409
  assert.throws(
    () => call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Applied' }),
    e => e.status === 409
  );

  // But sequential backward step to Screening succeeds
  const backToScreening = call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening' });
  assert.equal(backToScreening.stage, 'Screening');

  // Verify stage events audit
  const events = f.db.prepare('SELECT from_stage, to_stage FROM stage_events WHERE application_id=? ORDER BY at ASC').all(f.app.id);
  assert.deepEqual(events.map(e => [e.from_stage, e.to_stage]), [
    ['Applied', 'Screening'],
    ['Screening', 'Applied'],
    ['Applied', 'Screening'],
    ['Screening', 'Interview'],
    ['Interview', 'Screening']
  ]);

  f.db.close();
});

test('candidate status: lists applications with persisted stage and requisition title, handles zero and multiple applications', () => {
  const f = hiringFixture();
  // Candidate 1 (f.candidate) has 1 application (f.app) on f.req
  const list1 = call(f, f.recruiter, 'GET', 'candidates');
  const cand1 = list1.find(c => c.id === f.candidate.id);
  assert.ok(cand1);
  assert.equal(cand1.applications.length, 1);
  assert.equal(cand1.applications[0].title, f.req.title);
  assert.equal(cand1.applications[0].stage, 'Applied');

  // Candidate with zero applications
  const unappliedCand = call(f, f.recruiter, 'POST', 'candidates', {
    ...candidateBody,
    email: 'unapplied@example.com',
    name: 'Unapplied Candidate'
  });
  const list2 = call(f, f.recruiter, 'GET', 'candidates');
  const unapplied = list2.find(c => c.id === unappliedCand.id);
  assert.ok(unapplied);
  assert.deepEqual(unapplied.applications, []);

  // Candidate with multiple applications across different requisitions
  const req2 = call(f, f.recruiter, 'POST', 'requisitions', {
    ...reqBody,
    title: 'QA Lead',
    skills: ['Testing', 'Automation']
  });
  call(f, f.recruiter, 'POST', `requisitions/${req2.id}/submit`);
  call(f, f.manager, 'POST', `requisitions/${req2.id}/approve`, {});
  call(f, f.finance, 'POST', `requisitions/${req2.id}/approve`, {});

  // Apply Candidate 1 to req2
  const app2 = call(f, f.recruiter, 'POST', 'applications', {
    candidate_id: f.candidate.id,
    requisition_id: req2.id
  });

  // Advance application 1 stage to Interview
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview' });

  // Advance application 2 stage to Screening
  call(f, f.recruiter, 'POST', `applications/${app2.id}/stage`, { stage: 'Screening' });

  // Fetch candidate list and single candidate
  const list3 = call(f, f.recruiter, 'GET', 'candidates');
  const multiCand = list3.find(c => c.id === f.candidate.id);
  assert.ok(multiCand);
  assert.equal(multiCand.applications.length, 2);

  const appMap = new Map(multiCand.applications.map(a => [a.title, a.stage]));
  assert.equal(appMap.get(f.req.title), 'Interview');
  assert.equal(appMap.get('QA Lead'), 'Screening');

  // Verify single candidate fetch (GET /api/candidates/:id)
  const single = call(f, f.recruiter, 'GET', `candidates/${f.candidate.id}`);
  assert.equal(single.applications.length, 2);
  const singleMap = new Map(single.applications.map(a => [a.title, a.stage]));
  assert.equal(singleMap.get(f.req.title), 'Interview');
  assert.equal(singleMap.get('QA Lead'), 'Screening');

  // Verify search by requisition title and stage
  const searchReq = service(f.db, f.recruiter, 'GET', 'candidates', {}, new URLSearchParams({ q: 'QA Lead' }));
  assert.ok(searchReq.some(c => c.id === f.candidate.id));
  assert.ok(!searchReq.some(c => c.id === unappliedCand.id));

  const searchStage = service(f.db, f.recruiter, 'GET', 'candidates', {}, new URLSearchParams({ q: 'Interview' }));
  assert.ok(searchStage.some(c => c.id === f.candidate.id));
  assert.ok(!searchStage.some(c => c.id === unappliedCand.id));

  f.db.close();
});

test('candidate status: enforces team-scoping for applications and prevents cross-team data leaks', () => {
  const f = hiringFixture();
  const salesRecruiter = user(f.db, 'Recruiter', 'Sales');
  const salesManager = user(f.db, 'Hiring Manager', 'Sales');
  const salesFinance = user(f.db, 'Finance Approver', 'Sales');

  // Create a requisition on 'Sales'
  const salesReq = call(f, salesRecruiter, 'POST', 'requisitions', {
    ...reqBody,
    team: 'Sales',
    title: 'Account Executive',
    skills: ['Sales', 'Negotiation']
  });
  call(f, salesRecruiter, 'POST', `requisitions/${salesReq.id}/submit`);
  call(f, salesManager, 'POST', `requisitions/${salesReq.id}/approve`, {});
  call(f, salesFinance, 'POST', `requisitions/${salesReq.id}/approve`, {});

  // Admin applies the Engineering candidate to the Sales requisition (cross-team application)
  const crossApp = call(f, f.admin, 'POST', 'applications', {
    candidate_id: f.candidate.id,
    requisition_id: salesReq.id
  });
  assert.ok(crossApp.id);

  // Recruiter on Engineering sees candidate, but only sees the Engineering requisition application (NOT Sales)
  const engCandList = call(f, f.recruiter, 'GET', 'candidates');
  const engCand = engCandList.find(c => c.id === f.candidate.id);
  assert.ok(engCand);
  assert.equal(engCand.applications.length, 1);
  assert.equal(engCand.applications[0].title, f.req.title);
  assert.ok(!engCand.applications.some(a => a.title === 'Account Executive'));

  // Recruiter on Sales cannot see Engineering candidate at all
  const salesCandList = call(f, salesRecruiter, 'GET', 'candidates');
  assert.ok(!salesCandList.some(c => c.id === f.candidate.id));

  // Admin sees both applications on the candidate
  const adminCandList = call(f, f.admin, 'GET', 'candidates');
  const adminCand = adminCandList.find(c => c.id === f.candidate.id);
  assert.ok(adminCand);
  assert.equal(adminCand.applications.length, 2);
  const titles = adminCand.applications.map(a => a.title);
  assert.ok(titles.includes(f.req.title));
  assert.ok(titles.includes('Account Executive'));

  f.db.close();
});

test('TA Manager can review and approve requisitions in pending_manager stage for their team', () => {
  const f = fixture();
  const taManager = user(f.db, 'TA Manager', 'Engineering');
  const otherTeamTAManager = user(f.db, 'TA Manager', 'Sales');

  // Recruiter creates and submits requisition
  const req = call(f, f.recruiter, 'POST', 'requisitions', reqBody);
  assert.equal(req.status, 'draft');

  // TA Manager cannot approve draft
  assert.throws(() => call(f, taManager, 'POST', `requisitions/${req.id}/approve`, {}), e => e.status === 409);

  call(f, f.recruiter, 'POST', `requisitions/${req.id}/submit`);
  const pendingReq = call(f, taManager, 'GET', `requisitions/${req.id}`);
  assert.equal(pendingReq.status, 'pending_manager');

  // TA Manager from another team cannot approve
  assert.throws(() => call(f, otherTeamTAManager, 'POST', `requisitions/${req.id}/approve`, {}), e => e.status === 403);

  // Authorized TA Manager approves
  const approved = call(f, taManager, 'POST', `requisitions/${req.id}/approve`, { note: 'Approved by TA Manager' });
  assert.equal(approved.status, 'pending_finance');

  // Verify approval record
  const approvalRecord = f.db.prepare("SELECT * FROM approvals WHERE requisition_id=? AND step='manager'").get(req.id);
  assert.ok(approvalRecord);
  assert.equal(approvalRecord.actor, taManager.id);
  assert.equal(approvalRecord.decision, 'approve');
  assert.equal(approvalRecord.note, 'Approved by TA Manager');

  // Verify audit entry
  const auditEntry = f.db.prepare("SELECT * FROM audit WHERE event='requisition.approve' AND target=?").get(req.id);
  assert.ok(auditEntry);
  assert.equal(auditEntry.actor, taManager.id);

  // TA Manager cannot approve pending_finance (only finance approver/admin can)
  assert.throws(() => call(f, taManager, 'POST', `requisitions/${req.id}/approve`, {}), e => e.status === 403);

  // Finance approver completes approval
  const finalReq = call(f, f.finance, 'POST', `requisitions/${req.id}/approve`, { note: 'Finance sign-off' });
  assert.equal(finalReq.status, 'open');

  // Cannot approve open requisition
  assert.throws(() => call(f, taManager, 'POST', `requisitions/${req.id}/approve`, {}), e => e.status === 409);

  f.db.close();
});

test('TA Manager can reject a requisition awaiting manager approval', () => {
  const f = fixture();
  const taManager = user(f.db, 'TA Manager', 'Engineering');

  const req = call(f, f.recruiter, 'POST', 'requisitions', reqBody);
  call(f, f.recruiter, 'POST', `requisitions/${req.id}/submit`);

  const rejected = call(f, taManager, 'POST', `requisitions/${req.id}/reject`, { note: 'Headcount frozen' });
  assert.equal(rejected.status, 'rejected');

  const approvalRecord = f.db.prepare("SELECT * FROM approvals WHERE requisition_id=? AND step='manager'").get(req.id);
  assert.ok(approvalRecord);
  assert.equal(approvalRecord.actor, taManager.id);
  assert.equal(approvalRecord.decision, 'reject');
  assert.equal(approvalRecord.note, 'Headcount frozen');

  // Rejected requisition cannot be approved
  assert.throws(() => call(f, taManager, 'POST', `requisitions/${req.id}/approve`, {}), e => e.status === 409);

  f.db.close();
});

test('TA Manager can approve a requisition they personally created (self-approval allowed with permission)', () => {
  const f = fixture();
  const taManager = user(f.db, 'TA Manager', 'Engineering');

  // TA Manager has 'recruit' permission, so they can create a requisition
  const req = call(f, taManager, 'POST', 'requisitions', reqBody);
  call(f, taManager, 'POST', `requisitions/${req.id}/submit`);

  // TA Manager has requisitions.approve_manager permission: self-approval succeeds
  const approved = call(f, taManager, 'POST', `requisitions/${req.id}/approve`, { note: 'Self manager approval' });
  assert.equal(approved.status, 'pending_finance');

  // User without approval permission cannot approve
  const employee = user(f.db, 'Employee/Referral', 'Engineering');
  assert.throws(() => call(f, employee, 'POST', `requisitions/${req.id}/approve`, {}), e => e.status === 403);

  f.db.close();
});

test('interviewer can add/remove competencies when submitting scorecard and when editing interview', () => {
  const f = hiringFixture();
  const otherInterviewer = user(f.db, 'Interviewer');

  // Recruiter plans interview with initial competencies
  const interview = call(f, f.recruiter, 'POST', 'interviews', {
    application_id: f.app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    competencies: ['Technical', 'Communication']
  });

  // 1. Assigned interviewer can update planned competencies on the scheduled interview
  const updated = call(f, f.interviewer, 'PUT', `interviews/${interview.id}`, {
    scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    competencies: ['Coding', 'Architecture', 'Communication']
  });
  assert.deepEqual(JSON.parse(updated.competencies), ['Coding', 'Architecture', 'Communication']);

  // Unassigned interviewer cannot update competencies on this interview
  assert.throws(
    () => call(f, otherInterviewer, 'PUT', `interviews/${interview.id}`, {
      scheduled_at: new Date(Date.now() + 86400000).toISOString(),
      competencies: ['Hacking']
    }),
    e => e.status === 403
  );

  // 2. Scorecard submission with custom competencies added and a planned competency removed
  markInterviewReady(f, interview);

  // Rejects empty ratings
  assert.throws(
    () => call(f, f.interviewer, 'POST', `interviews/${interview.id}/scorecards`, {
      ratings: {},
      recommendation: 'Yes',
      notes: 'No ratings provided'
    }),
    e => e.status === 400 && /at least one/i.test(e.message)
  );

  // Rejects rating out of range
  assert.throws(
    () => call(f, f.interviewer, 'POST', `interviews/${interview.id}/scorecards`, {
      ratings: { Coding: 0 },
      recommendation: 'Yes',
      notes: 'Rating too low'
    }),
    e => e.status === 400
  );

  // Interviewer submits ratings: keeping 'Coding', removing 'Architecture', and adding custom 'Problem Solving' & 'Culture Fit'
  const customScorecard = {
    ratings: {
      Coding: 4,
      Communication: 5,
      'Problem Solving': 4,
      'Culture Fit': 5
    },
    recommendation: 'Strong yes',
    notes: 'Exceeded expectations in problem solving and coding; culture fit is outstanding.'
  };

  const scResult = call(f, f.interviewer, 'POST', `interviews/${interview.id}/scorecards`, customScorecard);
  assert.ok(scResult.id);

  // Verify interview status is completed and interview record reflects evaluated competencies
  const completedInterview = call(f, f.recruiter, 'GET', `interviews/${interview.id}`);
  assert.equal(completedInterview.status, 'completed');
  assert.deepEqual(JSON.parse(completedInterview.competencies), ['Coding', 'Communication', 'Problem Solving', 'Culture Fit']);

  // Reviewing feedback reveals the custom competencies and scores
  const feedback = call(f, f.interviewer, 'GET', `interviews/${interview.id}/scorecards`);
  assert.equal(feedback.scorecards.length, 1);
  const parsedRatings = JSON.parse(feedback.scorecards[0].ratings);
  assert.equal(parsedRatings.Coding, 4);
  assert.equal(parsedRatings['Problem Solving'], 4);
  assert.equal(parsedRatings['Culture Fit'], 5);
  assert.equal(parsedRatings.Communication, 5);
  assert.equal(parsedRatings.Architecture, undefined);
  f.db.close();
});

test('interview scheduling allows same-day scheduling and scheduling 2 minutes from now while rejecting past dates', () => {
  const f = hiringFixture();
  // 1. Scheduling 2 minutes from now succeeds
  const twoMinutesFromNow = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  const i1 = call(f, f.recruiter, 'POST', 'interviews', {
    application_id: f.app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: twoMinutesFromNow,
    competencies: ['Technical']
  });
  assert.equal(i1.scheduled_at, twoMinutesFromNow);

  // 2. Scheduling same day succeeds even if time is earlier today (same day validation removed)
  const earlierToday = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const i2 = call(f, f.recruiter, 'PUT', `interviews/${i1.id}`, {
    scheduled_at: earlierToday
  });
  assert.equal(i2.scheduled_at, earlierToday);

  // 3. Scheduling a date prior to today (yesterday) fails
  const yesterday = new Date(Date.now() - 86400000 * 2).toISOString();
  assert.throws(
    () => call(f, f.recruiter, 'POST', 'interviews', {
      application_id: f.app.id,
      interviewer_id: f.interviewer.id,
      scheduled_at: yesterday,
      competencies: ['Technical']
    }),
    e => e.status === 400 && e.message.includes('future interview date')
  );
  assert.throws(
    () => call(f, f.recruiter, 'PUT', `interviews/${i1.id}`, {
      scheduled_at: yesterday
    }),
    e => e.status === 400 && e.message.includes('future interview date')
  );

  f.db.close();
});



