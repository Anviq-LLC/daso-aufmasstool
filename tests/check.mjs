import assert from 'node:assert/strict';
import {as,accessBindings} from './access.mjs';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {build} from '../node_modules/.pnpm/esbuild@0.28.0/node_modules/esbuild/lib/main.js';
import {Miniflare} from '../node_modules/.pnpm/miniflare@4.20260515.0_@types+node@22.19.19/node_modules/miniflare/dist/src/index.js';
import {checkLinkedExtras} from './linked-extras.mjs';
import {checkApprovedLVDescriptions} from './approved-lv-descriptions.mjs';
import {checkProjectContacts} from './project-contacts.mjs';
import {checkDraftPersistence} from './report-drafts.mjs';
import {checkTimeRevenueDays} from './time-revenue-days.mjs';
import {checkTimeReports} from './time-reports.mjs';
import {checkCompanyAdjustments} from './company-adjustments.mjs';
import {checkSharedEmployees} from './shared-employees.mjs';
import {checkAttachmentStorage} from './attachment-storage.mjs';

const require=createRequire(import.meta.url),out='/tmp/aufmass-tests';
await mkdir(out,{recursive:true});
const banner={js:"import { createRequire as testCreateRequire } from 'node:module'; const require = testCreateRequire(import.meta.url);"};
await build({entryPoints:['tests/runtime-worker.ts'],outfile:out+'/worker.mjs',bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],external:['cloudflare:workers'],define:{'process.env.NODE_ENV':'"production"'}});
await build({entryPoints:['lib/ids.ts','lib/business.ts','lib/employees.ts','lib/import-lv.ts','lib/pdf.ts','lib/speech.ts','lib/plan-crew.ts','lib/manual-positions.ts','lib/employee-directory.ts','lib/time-reports.ts','lib/time-speech.ts','lib/report-drafts.ts','lib/company.ts','lib/line-adjustments.ts','lib/attachment-orientation.ts','lib/project-contacts.ts','lib/approved-lv-descriptions.ts','lib/report-crews.ts','lib/linked-extras.ts'],outdir:out+'/modules',bundle:true,format:'esm',platform:'node',banner});
await build({entryPoints:['tests/crew-ui.tsx'],outfile:out+'/crew-ui.js',bundle:true,format:'esm',platform:'node',banner});
const business=await import(out+'/modules/business.js'),pdf=await import(out+'/modules/pdf.js'),ui=await import(out+'/crew-ui.js');
const {PDFDocument}=require('pdf-lib');
const nativeFetch=globalThis.fetch;globalThis.fetch=async url=>typeof url==='string'&&url.startsWith('/')?new Response(await readFile('public'+url)):nativeFetch(url);

const script=await readFile(out+'/worker.mjs','utf8');
const mf=new Miniflare({modules:true,script,bindings:{DASO_PLAN_SYNC_SECONDS:'0',DASO_OWNER_EMAIL:'test-user@example.invalid',...accessBindings,DASO_SETTINGS_KEY:Buffer.alloc(32,7).toString('base64')},d1Databases:['DB','PLAN_DB'],r2Buckets:['BUCKET'],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat']});
const db=await mf.getD1Database('DB'),plan=await mf.getD1Database('PLAN_DB');
const sql=await readFile('drizzle/0000_hard_bill_hollister.sql','utf8');
await plan.prepare("CREATE TABLE users (id text primary key, email text not null, name text not null default '', access_role text not null default 'monteur', resource_id text)").run();
for(const s of sql.split('--> statement-breakpoint'))await db.prepare(s.trim()).run();
const headers={'Content-Type':'application/json',...await as('test-user@example.invalid')};
let projectId='';
async function state(){const r=await mf.dispatchFetch('http://test/api/data?project='+projectId,{headers});assert.equal(r.status,200);return r.json();}
async function call(action,payload={},expected=200,who='test-user'){
 if(['saveProjectEmployees','saveProjectPeople'].includes(action)&&payload.employeeDirectoryToken===undefined)payload={...payload,employeeDirectoryToken:(await state()).employeeDirectory.token};
 const r=await mf.dispatchFetch('http://test/api/data',{method:'POST',headers:{'Content-Type':'application/json',...await as(who+'@example.invalid')},body:JSON.stringify({action,projectId,...payload})});
 const j=await r.json();assert.equal(r.status,expected,JSON.stringify(j));return j;
}
async function upload(name,bytes,kind,reportId='',type='application/pdf'){
 const f=new FormData();f.set('projectId',projectId);f.set('reportId',reportId);f.set('kind',kind);f.set('file',new File([bytes],name,{type}));
 const req=new Request('http://test/api/files',{method:'POST',headers:{...await as('test-user@example.invalid')},body:f});
 const r=await mf.dispatchFetch(req.url,{method:'POST',headers:Object.fromEntries(req.headers),body:await req.arrayBuffer()});
 const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j;
}
const remove=async id=>mf.dispatchFetch('http://test/api/files?id='+id,{method:'DELETE',headers});

try{
 assert.equal((await mf.dispatchFetch('http://test/api/data')).status,400,'anonymous');
 for(const [uid,role] of [['foreman','Obermonteur'],['worker','Monteur']])await db.prepare('INSERT INTO records VALUES (?,?,?,?,?)').bind('access:'+uid+'@example.invalid','access','system',JSON.stringify({role,name:'Test'}),new Date().toISOString()).run();
 await plan.prepare('INSERT INTO users (id,email,name,access_role) VALUES (?,?,?,?)').bind('book','book@example.invalid','Buchhaltung','buchhaltung').run();
 assert.equal((await mf.dispatchFetch('http://test/api/data',{headers:await as('worker@example.invalid')})).status,400,'Monteur has no access');
 assert.equal((await mf.dispatchFetch('http://test/api/data',{headers:await as('foreman@example.invalid')})).status,200,'Obermonteur reads');
 assert.equal((await mf.dispatchFetch('http://test/api/data',{headers:await as('book@example.invalid')})).status,200,'Buchhaltung reads');
 assert.equal((await mf.dispatchFetch('http://test/api/company',{method:'POST',headers:{'Content-Type':'application/json',...await as('foreman@example.invalid')},body:'{}'})).status,400,'only a Planer edits the company');

 projectId=(await call('saveProject',{project:{name:'Prüfprojekt',number:'TEST-2026',customer:'Kunde',areas:['EG','OG'],factor:.9,measurementEmail:'kunde@example.invalid',contact:'Alexander Pankratz',foremanName:'Alexander Pankratz'}})).id;
 const roster=[{id:'regular-a',firstName:'Alexander',lastName:'Pankratz',code:'FAKE'},{id:'regular-b',firstName:'Jan',lastName:'Sommer',code:'FAKE'}];
 await call('saveProjectPeople',{updatedAt:(await state()).projects[0].updatedAt,employees:roster,teams:[]});
 await call('importLV',{positions:[{number:'1.1',description:'Spiralrohr DN 200 bis 3,5m',unit:'m',price:2383},{number:'1.2',description:'Spiralrohr DN 200 bis 5,5m',unit:'m',price:2860}]});
 let s=await state();const position=s.positions.find(p=>p.number==='1.1');
 const members=[{employeeId:'regular-a',name:'x',code:'FAKE',trial:false},{employeeId:'regular-b',name:'x',code:'FAKE',trial:false}];
 const input={date:'2026-09-28',endDate:'2026-09-28',team:'client-code',employeeMembers:members,area:'EG',note:'Prüfung',lines:[{id:'new',positionId:position.id,quantity:10,price:1,employeePrice:1,remark:'Montage'}]};
 const id=(await call('saveReport',{report:input})).id;s=await state();let report=s.reports.find(r=>r.id===id);
 assert.equal(report.state,'draft');assert.equal(report.lines[0].price,2383,'server owns the price');assert.equal(report.lines[0].employeePrice,2145,'90% employee value');assert.equal(report.author,'Alexander Pankratz');
 const attachment=await upload('Test.txt','Originalanlage','attachment',id,'text/plain');
 await call('finalizeReport',{id});s=await state();report=s.reports.find(r=>r.id===id);assert.equal(report.state,'ready');
 for(const field of ['review','reviewNote','sentAt','deadline','stage'])assert(!(field in report),'no review fields on '+field);

 // a finished Aufmaß is not locked: it can be edited and saved again, even in an old week
 const edited=await call('saveReport',{report:{...report,date:'2026-09-29',endDate:'2026-09-29',lines:report.lines.map(l=>({...l,quantity:12}))}});
 assert.equal(edited.id,id);await call('finalizeReport',{id});
 await call('importLV',{positions:[{number:'1.1',description:'Neue Bezeichnung',unit:'m',price:9999}]});
 s=await state();report=s.reports.find(r=>r.id===id);
 assert.equal(report.state,'ready');assert.equal(report.date,'2026-09-29');assert.equal(report.lines[0].quantity,12);assert.equal(report.lines[0].price,2383,'historical price persists after a LV re-import');
 assert.equal((await remove(attachment.id)).status,200,'attachments of a finished Aufmaß can be removed');

 for(const action of ['reopenReport','markReview','setStage','closeWeek','preparePackage','createPortalLink','addPayment'])await call(action,{id},400);
 await call('saveReport',{report:{...report,lines:report.lines.map(l=>({...l,quantity:5}))}},400,'book');
 await call('deleteReport',{id,updatedAt:report.updatedAt},400);
 await call('deleteReport',{id,updatedAt:report.updatedAt,reason:'falsche Baustelle'});
 assert(!(await state()).reports.some(r=>r.id===id),'deleted report is gone');
 console.log('PASS: roles (Planer, Obermonteur, Buchhaltung read-only), server-owned prices, finished Aufmaße stay editable, removed review/billing/dispatch actions, deletion with reason.');

 assert.equal(business.weekOf('2027-01-01'),'2026-W53');assert.equal(business.parseDecimal('1.234,56'),1234.56);
 s=await state();const p=s.projects[0],again=(await call('saveReport',{report:{...input,date:'2026-10-05',endDate:'2026-10-05',lines:[{...input.lines[0],positionId:s.positions[0].id}]}})).id;await call('finalizeReport',{id:again});s=await state();
 const bytes=await pdf.makePacket(p,[s.reports.find(r=>r.id===again)],[]),doc=await PDFDocument.load(bytes);
 assert(doc.getPageCount()>=1);assert.equal(doc.getForm().getFields().length,0,'the PDF carries no return form fields');
 console.log('PASS: PDF without review form, business helpers.');

 const worker={Miniflare,script,sql};
 await checkDraftPersistence({call,state,business});
 await checkCompanyAdjustments({call,state,upload,mf,headers,business,pdf,ui,PDFDocument,setProjectId:x=>{projectId=x;}});
 await checkTimeReports({call,state,upload,mf,headers,business,pdf,ui,PDFDocument,setProjectId:x=>{projectId=x;}});
 await checkTimeRevenueDays({call,state,business,pdf,ui,PDFDocument,setProjectId:x=>{projectId=x;}});
 await checkProjectContacts({call,state,business,ui,setProjectId:x=>{projectId=x;}});
 await checkAttachmentStorage({call,state,mf,headers,pdf,PDFDocument,setProjectId:x=>{projectId=x;}});
 await checkLinkedExtras({call,state,upload,business,pdf,PDFDocument,ui,setProjectId:x=>{projectId=x;}});
 await checkApprovedLVDescriptions({Miniflare,script:worker.script,sql,headers,project:p});
 await checkSharedEmployees({Miniflare,script:worker.script,sql,headers,project:p,ui});
}finally{await mf.dispose();}
