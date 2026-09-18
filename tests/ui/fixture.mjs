// Test-only in-memory loopback fixture. Never imported by the production server.
import {createApp} from '../../src/server.js';
import {fixture,user,reqBody,candidateBody,testConfig} from '../helpers.js';
import {service} from '../../src/service.js';
import {createSession} from '../../src/auth.js';
const f=fixture();
f.db.prepare('UPDATE users SET name=? WHERE id=?').run('Morgan Ellis',f.admin.id);
const call=(u,m,p,b)=>service(f.db,u,m,p,b);
const roles=[['Senior Software Engineer',['JavaScript','SQL']],['Product Designer',['Figma','Research']],['People Operations Partner',['HR operations','Communication']]];
let first;
for(const [title,required] of roles){const r=call(f.recruiter,'POST','requisitions',{...reqBody,title,skills:required});call(f.recruiter,'POST',`requisitions/${r.id}/submit`);call(f.manager,'POST',`requisitions/${r.id}/approve`,{});call(f.finance,'POST',`requisitions/${r.id}/approve`,{});first ||= r;}
const pending=call(f.recruiter,'POST','requisitions',{...reqBody,title:'Engineering Manager',headcount:2});call(f.recruiter,'POST',`requisitions/${pending.id}/submit`);
for(const [n,name] of ['Avery Chen','Jordan Williams','Sam Rivera','Taylor Morgan'].entries()){const c=call(f.recruiter,'POST','candidates',{...candidateBody,name,email:`candidate${n}@example.com`,skills:n%2?['SQL']:['JavaScript','SQL']});const a=call(f.recruiter,'POST','applications',{candidate_id:c.id,requisition_id:first.id});if(n>0)call(f.recruiter,'POST',`applications/${a.id}/stage`,{stage:'Screening'});if(n>1)call(f.recruiter,'POST',`applications/${a.id}/stage`,{stage:'Interview'});if(n===2)call(f.recruiter,'POST','interviews',{application_id:a.id,interviewer_id:f.interviewer.id,scheduled_at:new Date(Date.now()+86400000).toISOString(),competencies:['Problem solving','Communication']});}
user(f.db,'Employee/Referral','Engineering','pending');
const c={...testConfig(),origin:'http://localhost:3000'},s=createSession(f.db,f.admin,c),app=createApp({db:f.db,c});
// Review harness injects synthetic identity only on a loopback, in-memory server.
app.prependListener('request',req=>{req.headers.cookie=`session=${s.value}`;});
app.listen(3000,'127.0.0.1',()=>console.log('Synthetic UI review server on http://localhost:3000'));
export {app};
