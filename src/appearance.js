import { audit, transaction } from './db.js';
import { HttpError, requirePermission } from './policy.js';

export const themes = [
  {id:'mechlin',name:'Mechlin Light',description:'A bright workspace with signature Mechlin blue.'},
  {id:'midnight',name:'Midnight',description:'Deep navy surfaces for a quieter view.'},
  {id:'ocean',name:'Ocean',description:'Fresh cyan accents and a crisp, cool canvas.'}
];
export function getAppearance(db) {
  const stored = db.prepare("SELECT value FROM settings WHERE key='appearance'").get();
  let theme='mechlin';
  try {const data=JSON.parse(stored?.value || '{}');if(themes.some(t=>t.id===data.theme))theme=data.theme;} catch { /* Safe default if an operator corrupts optional branding data. */ }
  return {theme,productName:'Orbit',companyName:'Mechlin',themes};
}
export function setAppearance(db,user,body) {
  requirePermission(user,'admin');
  if(!body || !themes.some(t=>t.id===body.theme) || Object.keys(body).some(k=>k!=='theme'))throw new HttpError(400,'Choose one of the available themes.');
  return transaction(db,()=>{
    const before=getAppearance(db).theme;
    db.prepare("INSERT INTO settings(key,value) VALUES('appearance',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({theme:body.theme}));
    audit(db,user.id,'admin.appearance_updated','appearance',{before,after:body.theme});
    return getAppearance(db);
  });
}
