import {db,bucket,readData,commit,createProject,readEmployeeDirectory} from '@/db/raw';
import {actor,planner} from '@/lib/auth';
import {weekOf,weekStart,defaultTemplate} from '@/lib/business';
import type {Project,ProjectTeam,ProjectEmployee,EmployeeDirectory,Position,Report,Line} from '@/lib/types';
import {assignEmployeeCodes,TRIAL_EMPLOYEE_ID,findEmployee} from '@/lib/employees';
import {addDirectoryEmployees} from '@/lib/employee-directory';
import {remarkAdjustment,adjustedPrice,adjustmentMissing,percentRemark} from '@/lib/line-adjustments';
import {reportKind,isTimeReport,canonicalTimeSheet,timeLines,timeReportBounds,timeReadiness,validateTimeRates,workMinutes,defaultTimeRates} from '@/lib/time-reports';
import {contactText,validateProjectContacts} from '@/lib/project-contacts';
import {manualPositionDetails,positionNumberKey} from '@/lib/manual-positions';
import {approvedLVDescriptionChanges} from '@/lib/approved-lv-descriptions';
import {canonicalCrews,reportCrews,measurementHoursIssues} from '@/lib/report-crews';
import {readPlan} from '@/lib/plan';
import {env} from 'cloudflare:workers';

function text(v:unknown,max=2000){return String(v??'').trim().slice(0,max);}
function need(ok:unknown,message:string):asserts ok{if(!ok)throw new Error(message);}
function date(v:unknown){const s=text(v,10);need(/^\d{4}-\d{2}-\d{2}$/.test(s)&&!isNaN(+new Date(s+'T12:00:00Z'))&&new Date(s+'T12:00:00Z').toISOString().slice(0,10)===s,'Ungültiges Datum.');return s;}
function emails(v:unknown){const s=text(v,1000);need(!/[\r\n]/.test(s)&&s.split(/[;,]/).filter(x=>x.trim()).every(x=>/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(x.trim())),'Bitte E-Mail-Adressen prüfen (mehrere mit Komma trennen).');return s;}
function integer(v:unknown,max=1e12){const n=Number(v);need(typeof v==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=max,'Ungültiger Geldbetrag.');return n;}
function calendarWeek(v:unknown){const s=text(v,8);need(/^\d{4}-W\d{2}$/.test(s)&&weekOf(weekStart(s))===s,'Ungültige Kalenderwoche.');return s;}
export async function GET(request:Request){try{await actor(request);await syncPlanProjects().catch(()=>{});return Response.json(await readData(new URL(request.url).searchParams.get('project')||undefined),{headers:{'Cache-Control':'no-store'}});}catch(e){return Response.json({error:e instanceof Error?e.message:'Daten konnten nicht geladen werden.'},{status:400});}}
export async function POST(request:Request){try{
 const user=await actor(request);need(Number(request.headers.get('content-length')||0)<3_000_000,'Import ist zu groß. Bitte aufteilen.');const b=await request.json() as {action:string;projectId:string;project:Project;positions:Position[];report:Report;id:string;updatedAt:string;reason:string;note:string;week:string;amount:number;number:string;date:string;closureId:string;reference:string;reportIds:string[];versions:Record<string,string>;area:string;fileId:string;to:string;cc:string;subject:string;body:string;includeSummary:boolean};const action=text(b.action,50),now=new Date().toISOString();let projectId=text(b.projectId,100);
 if(action==='saveProject'&&!projectId){
  const id=crypto.randomUUID(),directory=await readEmployeeDirectory(),p=projectValues(b.project,id,now),employees=addDirectoryEmployees(directory.employees,projectEmployees(b.project.employees||[],directory.employees));
  p.employees=employees;const changed=directory.token.startsWith('legacy-')||JSON.stringify(employees)!==JSON.stringify(directory.employees),next=changed?{...directory,employees,token:crypto.randomUUID(),updatedAt:now}:undefined;
  await createProject(p,user,next,directory.token);return Response.json({id});
 }
 if(['archiveProject','deleteProject','projectImpact'].includes(action))await planner(request);
 need(projectId,'Bitte ein Projekt auswählen.');
 const revision=await db().prepare('SELECT version FROM project_revisions WHERE id = ?').bind(projectId).first<{version:number}>();need(revision,'Projekt nicht gefunden.');const data=await readData(projectId),project=data.projects.find(p=>p.id===projectId);need(project,'Projekt nicht gefunden.');
 const puts:{kind:string;value:{id:string;[key:string]:unknown}}[]=[],deletes:string[]=[];let detail='',id='',extra:Record<string,unknown>={},createdPosition:Position|undefined,directoryChange:{value:EmployeeDirectory;expectedToken:string}|undefined;
 const saveEmployees=(input:ProjectEmployee[])=>{
  const directory=data.employeeDirectory!;need((b as unknown as {employeeDirectoryToken:string}).employeeDirectoryToken===directory.token,'Die DaSo-Mitarbeiterliste wurde geändert. Bitte Daten aktualisieren und erneut bearbeiten.');
  const employees=projectEmployees(input,directory.employees);directoryChange={value:{...directory,employees,token:crypto.randomUUID(),updatedAt:now},expectedToken:directory.token};return employees;
 };
 const reportById=(reportId:string)=>{const r=data.reports.find(x=>x.id===reportId);need(r,'Aufmaß nicht gefunden.');return r;};
  if(action==='saveProject'){need(b.project.updatedAt===project.updatedAt,'Projekt wurde geändert. Bitte Stammdaten neu öffnen.');puts.push({kind:'project',value:{...projectValues({...b.project,...(project.planId?{planId:project.planId,name:project.name,number:project.number,orderNumber:project.orderNumber,customer:project.customer,address:project.address,foremanName:project.foremanName}:{}),timeRates:b.project.timeRates??project.timeRates,contactPersons:b.project.contactPersons??project.contactPersons},projectId,now),teams:project.teams||[],employees:project.employees||[],...(project.archivedAt?{archivedAt:project.archivedAt}:{}),...(project.archivedByPlan?{archivedByPlan:true}:{})}});if(b.project.factor!==project.factor){for(const r of data.reports)puts.push({kind:'report',value:r});}}
 else if(action==='saveProjectTeams'){need(b.updatedAt===project.updatedAt,'Projekt wurde geändert. Bitte aktualisieren.');const teams=projectTeams((b as unknown as {teams:ProjectTeam[]}).teams,project.teams||[]);puts.push({kind:'project',value:{...project,teams,updatedAt:now}});detail=teams.map(t=>t.code).join(', ');}
 else if(action==='saveProjectEmployees'){need(b.updatedAt===project.updatedAt,'Projekt wurde geändert. Bitte aktualisieren.');const employees=saveEmployees((b as unknown as {employees:ProjectEmployee[]}).employees);puts.push({kind:'project',value:{...project,employees,updatedAt:now}});detail=`DaSo-Liste für alle Projekte · ${employees.map(e=>e.code).join(', ')}`;}
 else if(action==='saveProjectPeople'){need(b.updatedAt===project.updatedAt,'Projekt wurde geändert. Bitte aktualisieren.');const input=b as unknown as {employees:ProjectEmployee[];teams:ProjectTeam[]},employees=saveEmployees(input.employees),teams=projectTeams(input.teams,project.teams||[]);puts.push({kind:'project',value:{...project,employees,teams,updatedAt:now}});detail=`${employees.length} DaSo-Mitarbeiter für alle Projekte · ${teams.length} Nachunternehmer-Teams in diesem Projekt`;}
 else if(action==='addPosition'){
   const details=manualPositionDetails((b as unknown as {position:unknown}).position,data.positions);
   id=crypto.randomUUID();createdPosition={...details,id,projectId,isSupplement:true};puts.push({kind:'position',value:createdPosition});detail=`${details.number} · ${details.description}`;
 }
 else if(action==='completeLVDescriptions'){
   const changes=approvedLVDescriptionChanges(projectId,data.positions),expected=(b as unknown as {changes:unknown}).changes;
   need(changes.length>0,'Keine unveränderten, geprüften LV-Kurztexte mehr zur Übernahme vorhanden.');
   need(JSON.stringify(expected)===JSON.stringify(changes),'Das LV wurde inzwischen geändert. Bitte die Vorschau erneut öffnen.');
   for(const change of changes){const position=data.positions.find(p=>p.id===change.id)!;puts.push({kind:'position',value:{...position,description:change.after}});}
   id=crypto.randomUUID();puts.push({kind:'lvtextrevision',value:{id,projectId,changes,createdAt:now,author:user}});
   detail=`${changes.length} geprüfte LV-Kurztexte vervollständigt: ${changes.map(change=>change.number).join(', ')}. Preise, Mengen und bestehende Aufmaße unverändert.`;
 }
 else if(action==='importLV'){
   need(Array.isArray(b.positions)&&b.positions.length>0&&b.positions.length<=2000,'Bitte 1–2.000 LV-Positionen importieren.');const numbers=new Set<string>();
   const positions:Position[]=b.positions.map((v:Position)=>{const number=text(v.number,80),description=text(v.description,3000),unit=text(v.unit,30);need(number&&description&&unit,'Jede Position benötigt Nummer, Bezeichnung und Einheit.');need(!numbers.has(number),'Doppelte LV-Nummer: '+number);numbers.add(number);return{id:crypto.randomUUID(),projectId,number,description,unit,price:integer(v.price),longText:text(v.longText,12000),planned:v.planned===null||v.planned===undefined?null:Number(v.planned)};});
   const supplements=data.positions.filter(p=>p.isSupplement);need(!positions.some(p=>supplements.some(s=>positionNumberKey(s.number)===positionNumberKey(p.number))),'Eine importierte Positionsnummer ist bereits als Nachtragsposition vorhanden. Bitte die Nummer in der Importdatei ändern.');
   deletes.push(...data.positions.filter(p=>!p.isSupplement).map(p=>p.id));puts.push(...positions.map(value=>({kind:'position',value})));detail=`${positions.length} Positionen; ${supplements.length} Nachtragspositionen bleiben erhalten; bisherige Aufmaße behalten ihre Preise.`;
 }
 else if(action==='saveReport'){
   const v=b.report as Report,clientDraftId=text(v.clientDraftId,100),old=v.id?data.reports.find(r=>r.id===v.id):clientDraftId?data.reports.find(r=>r.clientDraftId===clientDraftId):undefined;need(!clientDraftId||/^[a-zA-Z0-9_-]+$/.test(clientDraftId),'Ungültige Entwurfskennung.');if(!v.id&&old&&clientDraftId)return Response.json({ok:true,id:old.id,reusedDraft:true});need(!clientDraftId||!data.reports.some(r=>r.clientDraftId===clientDraftId&&r.id!==old?.id),'Entwurf wurde bereits unter einer anderen Kennung gespeichert.');
   if(v.id){need(old,'Aufmaß nicht gefunden.');need(old.updatedAt===v.updatedAt,'Dieses Aufmaß wurde geändert. Bitte neu öffnen.');}
   const kind=reportKind(v);need(['measurement','extra','timesheet'].includes(kind),'Ungültige Formularart.');const parentReportId=old?.parentReportId||text(v.parentReportId,100),parent=parentReportId?data.reports.find(r=>r.id===parentReportId):undefined;need(!old||v.parentReportId===undefined||v.parentReportId===old.parentReportId,'Die Zuordnung zum Aufmaß kann nicht geändert werden.');if(parentReportId){need(kind==='extra'&&parent&&reportKind(parent)==='measurement'&&parent.projectId===projectId&&parent.id!==old?.id,'Mehraufwand muss zu einem Aufmaß dieses Projekts gehören.');}need(!old||reportKind(old)===kind,'Die Formularart eines gespeicherten Berichts kann nicht geändert werden.');const bounds=isTimeReport(v)?timeReportBounds(v.timeSheet!):null,day=bounds?bounds.date:date(v.date),end=bounds?bounds.endDate:date(v.endDate||v.date);need(end>=day&&weekOf(day)===weekOf(end)&&(isTimeReport(v)||day.slice(0,7)===end.slice(0,7)),'Ein Aufmaß darf keine Wochen- oder Monatsgrenze überschreiten. Bitte in zwei Aufmaße aufteilen.');if(old&&weekOf(old.date)!==weekOf(day))need(!data.reports.some(r=>r.parentReportId===old.id),'Bitte zuerst die verknüpften Mehraufwandberichte entfernen.');if(parent)need(day>=parent.date&&end<=(parent.endDate||parent.date),'Die Mehraufwandtage müssen im Zeitraum des zugehörigen Aufmaßes liegen.');if(old&&kind==='measurement')need(data.reports.filter(r=>r.parentReportId===old.id).every(r=>r.date>=day&&(r.endDate||r.date)<=end),'Der neue Zeitraum muss die verknüpften Mehraufwandtage einschließen.');
   const area=text(v.area,200);need(Array.isArray(v.lines)&&v.lines.length<=500,'Zu viele Positionen.');const crew=canonicalCrews(v,project,old||parent,(Math.round((Date.parse(end)-Date.parse(day))/86400000)+1)*24,isTimeReport(v)),team=crew.team!,employeeMembers=crew.employeeMembers||[],teamWork=crew.teamWork||null;
   const lines:Line[]=isTimeReport(v)?[]:v.lines.map(l=>{const position=data.positions.find(p=>p.id===l.positionId),prior=old?.lines.find(x=>x.id===l.id);need(position||prior,'LV-Position nicht mehr verfügbar. Bitte neu auswählen.');const source=prior||position!,quantity=Number(l.quantity),inputRemark=text(l.remark,2000),trigger=remarkAdjustment(inputRemark),basePrice=prior?.basePrice??source.price,requested=l.priceAdjustment;need(requested===undefined||typeof requested==='number'&&Number.isFinite(requested),'Ungültige EP-Anpassung.');const priceAdjustment=trigger?(requested===undefined?trigger.suggested===undefined?undefined:trigger.sign*trigger.suggested:trigger.sign*Math.abs(requested)):0,remark=trigger&&priceAdjustment!==undefined?percentRemark(inputRemark,Math.abs(priceAdjustment)):inputRemark,price=trigger||prior?.basePrice!==undefined?adjustedPrice(basePrice,priceAdjustment??0):source.price,employeeFactor=prior?.employeeFactor??project.factor;need(Number.isFinite(quantity)&&quantity>=0&&quantity<=1e8,'Mengen müssen eine gültige Zahl ab 0 sein.');return{id:prior?.id||crypto.randomUUID(),positionId:prior?.positionId||position!.id,number:source.number,description:source.description,unit:source.unit,price,...(trigger||prior?.basePrice!==undefined?{basePrice,priceAdjustment}:{}),employeePrice:Math.round(price*employeeFactor),employeeFactor,quantity,remark};});
   id=old?.id||crypto.randomUUID();const r:Report={id,projectId,...(parentReportId?{parentReportId}:{}),...(old?.clientDraftId||clientDraftId?{clientDraftId:old?.clientDraftId||clientDraftId}:{}),...(isTimeReport(v)?{kind}:old?.kind?{kind:old.kind}:{}),date:day,endDate:end,team,teamWork,employeeMembers,...(crew.crews?{crews:crew.crews}:{}),author:text(v.author||project.foremanName||user,160),area,note:text(v.note,12000),lines,state:'draft',createdAt:old?.createdAt||now,updatedAt:now};if(isTimeReport(v)){r.timeSheet=canonicalTimeSheet(project,{...r,timeSheet:v.timeSheet},old);r.lines=timeLines(r);for(const c of reportCrews(r))if(c.teamWork)c.teamWork.workers=c.teamWork.workers.map((w,i)=>({...w,hours:r.timeSheet!.entries.filter(e=>e.workerId===`sub:${c.teamWork!.code}:${i}`).reduce((sum,e)=>sum+(workMinutes(e)||0)/60,0)}));}puts.push({kind:'report',value:r});detail=`${day} · ${team} · ${area}`;
 }
 else if(['finalizeReport','deleteDraft'].includes(action)){
   const r=reportById(text(b.id));id=r.id;need(!b.updatedAt||r.updatedAt===b.updatedAt,'Aufmaß wurde zwischenzeitlich geändert.');
   if(action==='finalizeReport'){need(r.state==='draft'&&r.lines.length,'Bitte mindestens eine Leistung eintragen.');let finalized=r;need(!measurementHoursIssues(r).length,measurementHoursIssues(r).join(' '));if(isTimeReport(r)){finalized={...r,timeSheet:canonicalTimeSheet(project,r,r)};finalized.lines=timeLines(finalized);need(!timeReadiness(finalized).length,timeReadiness(finalized).join(' '));}else need(!r.lines.some(adjustmentMissing),'Bitte den prozentualen Zu- oder Abschlag an jeder markierten Position eintragen (0 % ist zulässig).');puts.push({kind:'report',value:{...finalized,state:'ready',updatedAt:now}});}
   if(action==='deleteDraft'){need(!data.reports.some(child=>child.parentReportId===r.id),'Bitte zuerst die verknüpften Mehraufwandberichte entfernen.');need(r.state==='draft','Nur unversandte Entwürfe können gelöscht werden.');need(!data.files.some(f=>f.reportId===r.id),'Bitte zuerst die Anlagen entfernen.');deletes.push(r.id);}
 }
 else if(action==='archiveProject'){
   const archived=(b as unknown as {archived:boolean}).archived===true,{archivedAt:_old,archivedByPlan:_by,...rest}=project;puts.push({kind:'project',value:{...rest,...(archived?{archivedAt:now}:{}),updatedAt:now}});detail=`${project.number} · ${project.name} · ${archived?'archiviert':'wiederhergestellt'}`;
 }
 else if(action==='projectImpact'||action==='deleteProject'){
   need(project.archivedAt,'Bitte das Projekt zuerst archivieren.');
   const impact={reports:data.reports.length,files:data.files.length},sensitive=data.reports.length>0;
   if(action==='projectImpact')return Response.json({ok:true,impact,sensitive,number:project.number});
   if(sensitive)need(text((b as unknown as {confirmNumber:string}).confirmNumber,100)===project.number,'Bitte die Projektnummer zur Bestätigung eintragen.');
   const keys=data.files.flatMap(f=>[f.key,f.original?.key]).filter((k):k is string=>!!k);
   await db().batch([db().prepare('DELETE FROM records WHERE project_id = ?').bind(projectId),db().prepare('DELETE FROM audit WHERE project_id = ?').bind(projectId),db().prepare('DELETE FROM project_revisions WHERE id = ?').bind(projectId),...(project.planId?[db().prepare("INSERT OR REPLACE INTO records (id,kind,project_id,data,updated_at) VALUES (?,'plandeleted','system','{}',?)").bind('plandel:'+project.planId,now)]:[]),db().prepare('INSERT INTO audit (id,project_id,action,user,detail,at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(),'system','Projekt gelöscht',user,`${project.number} · ${project.name} · ${impact.reports} Aufmaße`,now)]);
   await Promise.all(keys.map(k=>bucket().delete(k).catch(()=>{})));
   return Response.json({ok:true,id:projectId});
 }
 else if(action==='deleteReport'){
   const r=reportById(text(b.id)),reason=text(b.reason,2000);id=r.id;
   need(reason,'Bitte einen Grund für das Löschen angeben.');need(!b.updatedAt||r.updatedAt===b.updatedAt,'Aufmaß wurde zwischenzeitlich geändert.');need(!data.reports.some(c=>c.parentReportId===r.id),'Bitte zuerst die verknüpften Mehraufwandberichte entfernen.');
   const files=data.files.filter(f=>f.reportId===r.id);
   puts.push({kind:'deletedreport',value:{id:'deleted:'+r.id,report:r,files,reason,user,at:now}});deletes.push(r.id,...files.map(f=>f.id));detail=`${r.date} · ${r.team} · ${reason}`;
 }
 else throw new Error('Unbekannte Aktion.');
 await commit(projectId,action,user,puts,deletes,detail,revision.version,directoryChange);return Response.json({ok:true,id,...extra,...(createdPosition?{position:createdPosition}:{})});
 }catch(e){return Response.json({error:e instanceof Error?e.message:'Speichern fehlgeschlagen.'},{status:400});}}

// Every active Montageplanung project appears here on its own. A project a Planer deleted stays away.
// ponytail: per-isolate throttle, the sync full-scans records and the plan DB; use a KV/D1 timestamp if isolates multiply
let lastSync=0;
async function syncPlanProjects(){
 if(Date.now()-lastSync<Number((env as unknown as {DASO_PLAN_SYNC_SECONDS?:string}).DASO_PLAN_SYNC_SECONDS??120)*1000)return;
 const plan=await readPlan();if(!plan.projects.length)return;lastSync=Date.now();
 const rows=await db().prepare("SELECT id,kind,data FROM records WHERE kind IN ('project','plandeleted')").all<{id:string;kind:string;data:string}>();
 const existing=rows.results.filter(r=>r.kind==='project').map(r=>JSON.parse(r.data) as Project),removed=new Set(rows.results.filter(r=>r.kind==='plandeleted').map(r=>r.id.slice(8)));
 const repaired=await db().prepare("SELECT 1 AS n FROM records WHERE id = 'migration:plan-email-1'").first();
 if(!repaired){
  for(const m of plan.projects){const p=existing.find(x=>x.planId===m.id);if(p&&m.email&&p.measurementEmail.trim().toLowerCase()===m.email.trim().toLowerCase()){try{await commit(p.id,'Aufmaß-E-Mail bereinigt','Montageplanung',[{kind:'project',value:{...p,measurementEmail:'',updatedAt:new Date().toISOString()} as Project}]);}catch{/* retried on the next load */}}}
  await db().prepare("INSERT OR IGNORE INTO records (id,kind,project_id,data,updated_at) VALUES ('migration:plan-email-1','migration','system','{}',?)").bind(new Date().toISOString()).run();
 }

 // Linked projects follow Montageplanung: master data, and archiving when it archives or removes the project.
 for(const p of existing){
  if(!p.planId)continue;
  const m=plan.projects.find(x=>x.id===p.planId),now=new Date().toISOString();let next:Project|undefined;
  if(m){
   const master={name:m.name||p.name,number:m.number||p.number,orderNumber:m.orderNumber,customer:m.customer,address:m.address,foremanName:m.foreman};
   const differs=(Object.keys(master) as (keyof typeof master)[]).some(k=>(p[k]||'')!==master[k]);
   if(differs||(p.archivedByPlan&&p.archivedAt)){const {archivedAt,archivedByPlan,...rest}=p;next={...rest,...master,...(!archivedByPlan&&archivedAt?{archivedAt}:{}),updatedAt:now} as Project;}
  }else if(!p.archivedAt)next={...p,archivedAt:now,archivedByPlan:true,updatedAt:now};
  if(next){try{await commit(p.id,'Projekt mit Montageplanung abgeglichen','Montageplanung',[{kind:'project',value:next}]);}catch{/* retried on the next load */}}
 }
 for(const m of plan.projects){
  if(removed.has(m.id)||existing.some(p=>p.planId===m.id||(!p.planId&&((m.number&&p.number===m.number)||p.name.trim().toLowerCase()===m.name.trim().toLowerCase()))))continue;
  try{
   const directory=await readEmployeeDirectory(),now=new Date().toISOString(),mail=(v:string)=>/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v.trim())?v.trim():'';
   const base:Project={id:'',name:m.name,number:m.number||'ohne Nummer',orderNumber:m.orderNumber,customer:m.customer,address:m.address,areas:[],foremanName:m.foreman,contact:m.foreman,measurementEmail:'',invoiceEmail:'',cc:'',contacts:'',factor:.9,deadlineDays:0,deadlineType:'calendar',template:defaultTemplate,hourlyNote:false,timeRates:defaultTimeRates(),planId:m.id,updatedAt:''};
   const contactPersons=m.contacts.map(c=>({id:crypto.randomUUID(),name:c.name,role:c.role,phone:c.phone,email:mail(c.email)}));
   let project:Project;try{project=projectValues({...base,contactPersons},'plan-'+m.id,now);}catch{project=projectValues(base,'plan-'+m.id,now);}
   project.employees=directory.employees;
   await createProject(project,'Montageplanung',undefined,directory.token);
  }catch{/* another request created it first, or the data is unusable; try again on the next load */}
 }

 // Employees follow Montageplanung by its own id: renames carry over, and people it archives become inactive here.
 const anchor=await db().prepare("SELECT id FROM records WHERE kind = 'project' ORDER BY id LIMIT 1").first<{id:string}>();
 if(!anchor)return;
 try{
  const directory=await readEmployeeDirectory(),norm=(first:string,last:string)=>(first+' '+last).trim().toLowerCase().replace(/\s+/g,' '),employees=directory.employees.map(e=>({...e})),active=new Set(plan.employees.map(e=>e.id)),incoming:ProjectEmployee[]=[];
  const byPlan=new Map(employees.filter(e=>e.planId).map(e=>[e.planId!,e])),byName=new Map(employees.filter(e=>!e.planId).map(e=>[norm(e.firstName,e.lastName),e]));let changed=false;
  for(const person of plan.employees){
   const parts=person.name.trim().split(/\s+/);if(parts.length<2)continue;
   const firstName=parts.slice(0,-1).join(' '),lastName=parts[parts.length-1],hit=byPlan.get(person.id)||byName.get(norm(firstName,lastName));
   if(hit){if(hit.planId!==person.id||hit.firstName!==firstName||hit.lastName!==lastName||hit.inactive){hit.planId=person.id;hit.firstName=firstName;hit.lastName=lastName;delete hit.inactive;changed=true;}byName.delete(norm(firstName,lastName));}
   else incoming.push({id:crypto.randomUUID(),firstName,lastName,code:'',planId:person.id});
  }
  for(const e of employees)if(e.planId&&!active.has(e.planId)&&!e.inactive){e.inactive=true;changed=true;}
  if(changed||incoming.length)await commit(anchor.id,'Mitarbeiter aus Montageplanung','Montageplanung',[],[],incoming.length+' neu',undefined,{value:{...directory,employees:incoming.length?addDirectoryEmployees(employees,incoming):employees,token:crypto.randomUUID(),updatedAt:new Date().toISOString()},expectedToken:directory.token});
 }catch{/* retried on the next load */}
 // Contractors become teams only in projects where Montageplanung assigns them.
 const rows2=await db().prepare("SELECT data FROM records WHERE kind = 'project'").all<{data:string}>();
 const cleaned=await db().prepare("SELECT 1 AS n FROM records WHERE id = 'migration:plan-teams-1'").first();
 for(const row of rows2.results){
  const p=JSON.parse(row.data) as Project;if(!p.planId)continue;
  const mine=plan.assigned.filter(a=>a.projectId===p.planId),assignedNames=new Set(mine.map(a=>a.name.trim().toLowerCase())),contractorNames=new Set(plan.contractors.map(c=>c.name.trim().toLowerCase()));
  let teams=(p.teams||[]).map(t=>({...t}));
  if(!cleaned){
   // Remove placeholder teams that an earlier version added to every project, unless a report already uses them.
   const used=new Set((await db().prepare("SELECT data FROM records WHERE kind = 'report' AND project_id = ?").bind(p.id).all<{data:string}>()).results.flatMap(r=>reportCrews(JSON.parse(r.data) as Report).map(c=>c.team)));
   teams=teams.filter(t=>!(contractorNames.has(t.company.trim().toLowerCase())&&!assignedNames.has(t.company.trim().toLowerCase())&&t.hourlyRate===null&&!t.employees.some(Boolean)&&!used.has(t.code)));
  }
  const codes=new Set(teams.map(t=>t.code)),added:ProjectTeam[]=[];
  for(const a of mine){
   const name=a.name.trim(),workers:[string,string]=[name,a.max>=2?name+' 2':''],t=teams.find(x=>x.planId===a.contractorId)||teams.find(x=>!x.planId&&x.company.trim().toLowerCase()===name.toLowerCase());
   if(t){t.planId=a.contractorId;t.company=name;if(!t.employees.some(Boolean))t.employees=workers;}
   else if(name){let n=1;while(codes.has('T'+n))n++;codes.add('T'+n);added.push({code:'T'+n,company:name,planId:a.contractorId,employees:workers,hourlyRate:null});}
  }
  const next=[...teams,...added];
  if(JSON.stringify(next)!==JSON.stringify(p.teams||[])){try{await commit(p.id,'Nachunternehmer aus Montageplanung','Montageplanung',[{kind:'project',value:{...p,teams:next,updatedAt:new Date().toISOString()} as Project}],[],added.map(t=>t.company).join(', '));}catch{/* retried on the next load */}}
 }
 if(!cleaned)await db().prepare("INSERT OR IGNORE INTO records (id,kind,project_id,data,updated_at) VALUES ('migration:plan-teams-1','migration','system','{}',?)").bind(new Date().toISOString()).run();
}

function projectValues(v:Project,id:string,now:string):Project{
 need(v&&text(v.name)&&text(v.number),'Projektname und Projektnummer fehlen.');const factor=Number(v.factor);need(Number.isFinite(factor)&&factor>=0&&factor<=1,'Mitarbeiterfaktor muss zwischen 0 und 1 liegen.');const days=integer(v.deadlineDays??0,90),contactPersons=validateProjectContacts(v.contactPersons);return{id,name:text(v.name,200),foremanName:text(v.foremanName,160),number:text(v.number,100),orderNumber:text(v.orderNumber,100),customer:text(v.customer,200),address:text(v.address,1000),areas:[...new Set((v.areas||[]).map(x=>text(x,200)).filter(Boolean))].slice(0,100),teams:projectTeams(v.teams||[]),employees:projectEmployees(v.employees||[]),measurementEmail:emails(v.measurementEmail),invoiceEmail:emails(v.invoiceEmail),cc:emails(v.cc),contact:text(v.contact,200)||text(v.foremanName,160),...(v.planId?{planId:text(v.planId,100)}:{}),contacts:contactPersons===undefined?text(v.contacts,5000):contactText(contactPersons),...(contactPersons===undefined?{}:{contactPersons}),factor,deadlineDays:days,deadlineType:v.deadlineType==='working'?'working':'calendar',template:text(v.template||defaultTemplate,20000),hourlyNote:!!v.hourlyNote,timeRates:validateTimeRates(v.timeRates),updatedAt:now};
}

function projectTeams(input:ProjectTeam[],previous:ProjectTeam[]=[]):ProjectTeam[]{need(Array.isArray(input)&&input.length<=100,'Bitte höchstens 100 Teams hinterlegen.');const codes=new Set<string>();const teams:ProjectTeam[]=input.map(t=>{const code=text(t.code,80);need(code&&!codes.has(code),'Teamkürzel fehlt oder ist doppelt.');codes.add(code);const hourlyRate=t.hourlyRate===null||t.hourlyRate===undefined?null:integer(t.hourlyRate,1e8),prior=previous.find(x=>x.code===code&&x.planId);return{code,company:prior?prior.company:text(t.company,200),employees:[text(t.employees?.[0],160),text(t.employees?.[1],160)] as [string,string],hourlyRate,...(prior?{planId:prior.planId}:{})};});for(const prior of previous)if(prior.planId&&!codes.has(prior.code))teams.push(prior);return teams;}

function projectEmployees(input:ProjectEmployee[],previous:ProjectEmployee[]=[]):ProjectEmployee[]{
 need(Array.isArray(input)&&input.length<=500,'Bitte höchstens 500 Mitarbeiter hinterlegen.');const ids=new Set<string>();
 const employees=input.map(e=>{const id=text(e.id,100),prior=findEmployee(previous,id),linked=!!prior?.planId,firstName=linked?prior!.firstName:text(e.firstName,80),lastName=linked?prior!.lastName:text(e.lastName,80);need(id!==TRIAL_EMPLOYEE_ID&&id&&!ids.has(id),'Mitarbeiter-ID fehlt oder ist doppelt.');ids.add(id);need(firstName&&lastName&&/^[\p{L}]/u.test(firstName)&&/^[\p{L}]/u.test(lastName),'Bitte Vor- und Nachname vollständig eintragen.');return{id:prior?.id||id,firstName,lastName,code:'',...(prior?.legacyIds?.length?{legacyIds:prior.legacyIds}:{}),...(prior?.planId?{planId:prior.planId}:{}),...(prior?.inactive?{inactive:true}:{})};});
 // People that Montageplanung manages cannot be removed here.
 for(const prior of previous)if(prior.planId&&!employees.some(e=>e.id===prior.id))employees.push({id:prior.id,firstName:prior.firstName,lastName:prior.lastName,code:'',...(prior.legacyIds?.length?{legacyIds:prior.legacyIds}:{}),planId:prior.planId,...(prior.inactive?{inactive:true}:{})});
 need(new Set(employees.map(e=>e.id)).size===employees.length,'Mitarbeiter wurde mehrfach eingetragen.');
 return assignEmployeeCodes(employees,previous);
}
