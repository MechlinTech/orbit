import { openDb } from '../src/db.js';
import { resolve,dirname } from 'node:path';
import { mkdirSync,existsSync } from 'node:fs';
const target=process.argv[2];
if(!target){console.error('Usage: npm run backup -- /secure-backups/talentos-YYYY-MM-DD.sqlite');process.exit(1);}
const output=resolve(target);
if(existsSync(output))throw new Error('Refusing to overwrite an existing backup');
mkdirSync(dirname(output),{recursive:true});
const db=openDb(process.env.DATABASE_PATH);
db.prepare('VACUUM INTO ?').run(output);db.close();
console.log(`Consistent SQLite snapshot created: ${output}`);
