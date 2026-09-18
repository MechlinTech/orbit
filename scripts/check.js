import { readdirSync,readFileSync,existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
let count=0;
function checkDir(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())checkDir(path);else if(/\.m?js$/.test(entry.name)){execFileSync(process.execPath,['--check',path]);count++;}}}
for(const dir of ['src','scripts','public','tests'])checkDir(dir);
for(const file of ['package.json','public/manifest.webmanifest'])JSON.parse(readFileSync(file,'utf8'));
for(const file of ['README.md','DEPLOYMENT_INSTRUCTIONS.md','SELF_HOSTED_DEPLOYMENT.md','SECURITY.md','COMPLIANCE.md','TEST_PLAN.md','ARCHITECTURE.md','DATABASE.md','ENVIRONMENT_VARIABLES.md','KNOWN_LIMITATIONS.md'])if(!existsSync(file))throw new Error(`Missing ${file}`);
console.log(`PASS: ${count} JavaScript syntax checks, 2 JSON files, 10 required documents.`);
