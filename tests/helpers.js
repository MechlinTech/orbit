import { openDb,id,now } from '../src/db.js';
import { config } from '../src/auth.js';
export const tenant='11111111-1111-1111-1111-111111111111';
export const client='22222222-2222-2222-2222-222222222222';
export const testConfig=()=>config({APP_ORIGIN:'http://localhost:3000',ENTRA_TENANT_ID:tenant,ENTRA_CLIENT_ID:client,ENTRA_CLIENT_SECRET:'test-only',ALLOWED_DOMAINS:'example.com'});
export function user(db,role='Recruiter',team='Engineering',status='active'){
  const uid=id();db.prepare('INSERT INTO users(id,email,name,oid,tenant,role,team,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(uid,`${uid}@example.com`,role,uid,tenant,role,team,status,now());return db.prepare('SELECT * FROM users WHERE id=?').get(uid);
}
export const fixture=()=>{const db=openDb(':memory:');return {db,admin:user(db,'System Admin'),recruiter:user(db),manager:user(db,'Hiring Manager'),finance:user(db,'Finance Approver'),interviewer:user(db,'Interviewer')};};
export const reqBody={title:'Senior Software Engineer',team:'Engineering',headcount:1,salary_min:90000,salary_max:140000,currency:'USD',description:'Build reliable internal systems.',skills:['JavaScript','SQL']};
export const candidateBody={name:'Avery Chen',email:'avery@example.com',team:'Engineering',phone:'',skills:['SQL'],resume_text:'SQL engineer',source:'Direct'};
