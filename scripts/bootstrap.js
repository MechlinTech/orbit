import { openDb, id, now, audit, transaction } from '../src/db.js';
import { email } from '../src/policy.js';
const [address,name,oid,tenant] = process.argv.slice(2);
if (!address || !name || !/^[a-f0-9-]{36}$/i.test(oid || '') || !/^[a-f0-9-]{36}$/i.test(tenant || '')) {
  console.error('Usage: npm run bootstrap -- admin@company.com "Admin Name" ENTRA_OBJECT_ID ENTRA_TENANT_ID'); process.exit(1);
}
const db = openDb(process.env.DATABASE_PATH);
if (db.prepare("SELECT id FROM users WHERE role='System Admin'").get()) {console.error('An administrator already exists. Use the administration screen.');process.exit(1);}
transaction(db,()=>{
  const uid=id();db.prepare('INSERT INTO users(id,email,name,oid,tenant,role,team,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(uid,email(address),name,oid,tenant,'System Admin','','active',now());
  audit(db,'bootstrap','admin.bootstrap',uid);
});
db.close();console.log('Initial administrator provisioned. Microsoft 365 sign-in is still required.');
