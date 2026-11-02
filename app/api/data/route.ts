import {returnBelongsToReport,recordPackageReview,packageReportReviewed} from '@/lib/package-returns';
import {db,bucket,readData,commit,createProject,readEmployeeDirectory} from '@/db/raw';
import {actor,planner} from '@/lib/auth';
import {aggregate,aggregateKey,aggregateTotals,weekOf,weekStart,deadlineFrom,defaultTemplate,employeeValue,requiresCumulative} from '@/lib/business';
import type {Project,ProjectTeam,ProjectEmployee,EmployeeDirectory,EmployeeMember,TeamWork,Position,Report,Closure,Payment,MailPackage,Line,Aggregate,WeekRecord,WeekChange} from '@/lib/types';
import {effectiveWeekRows,weekRecord,weekFinance,weekToken,mergeRows,paymentWeek,summaryToken,packetSummaryValid,rangeWeekRows} from '@/lib/weeks';
import {assignEmployeeCodes,employeeTeamCode,TRIAL_EMPLOYEE_ID,trialEmployee,findEmployee} from '@/lib/employees';
import {addDirectoryEmployees} from '@/lib/employee-directory';
import {remarkAdjustment,adjustedPrice,adjustmentMissing,percentRemark} from '@/lib/line-adjustments';
import {bundleIssue} from '@/lib/linked-extras';
import {reportKind,isTimeReport,reportLabel,canonicalTimeSheet,timeLines,timeDates,timeReportBounds,timeReadiness,validateTimeRates,workMinutes,defaultTimeRates} from '@/lib/time-reports';
import {contactText,validateProjectContacts} from '@/lib/project-contacts';
import {manualPositionDetails,positionNumberKey} from '@/lib/manual-positions';
import {approvedLVDescriptionChanges} from '@/lib/approved-lv-descriptions';
import {canonicalCrews,reportCrews,measurementHoursIssues} from '@/lib/report-crews';
import {invoiceBasis} from '@/lib/invoice-basis';
import {defaultCompany} from '@/lib/company';
import {closureIsCurrent,weekSourceToken} from '@/lib/weeks';
import {buildPortal,portalUrl} from '@/lib/portal-link';
import {readPlan} from '@/lib/plan';

function text(v:unknown,max=2000){return String(v??'').trim().slice(0,max);}
function need(ok:unknown,message:string):asserts ok{if(!ok)throw new Error(message);}
function date(v:unknown){const s=text(v,10);need(/^\d{4}-\d{2}-\d{2}$/.test(s)&&!isNaN(+new Date(s+'T12:00:00Z'))&&new Date(s+'T12:00:00Z').toISOString().slice(0,10)===s,'Ungültiges Datum.');return s;}
function emails(v:unknown){const s=text(v,1000);need(!/[\r\n]/.test(s)&&s.split(/[;,]/).filter(x=>x.trim()).every(x=>/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(x.trim())),'Bitte E-Mail-Adressen prüfen (mehrere mit Komma trennen).');return s;}
function integer(v:unknown,max=1e12){const n=Number(v);need(typeof v==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=max,'Ungültiger Geldbetrag.');return n;}
function calendarWeek(v:unknown){const s=text(v,8);need(/^\d{4}-W\d{2}$/.test(s)&&weekOf(weekStart(s))===s,'Ungültige Kalenderwoche.');return s;}
export async function GET(request:Request){try{await actor(request);await syncPlanProjects().catch(()=>{});return Response.json(await readData(new URL(request.url).searchParams.get('project')||undefined),{headers:{'Cache-Control':'no-store'}});}catch(e){return Response.json({error:e instanceof Error?e.message:'Daten konnten nicht geladen werden.'},{status:400});}}
export async function POST(request:Request){try{
 const user=await actor(request);need(Number(request.headers.get('content-length')||0)<3_000_000,'Import ist zu groß. Bitte aufteilen.');const b=await request.json() as {action:string;projectId:string;project:Project;positions:Position[];report:Report;id:string;updatedAt:string;reason:string;review:Report['review'];note:string;week:string;amount:number;number:string;date:string;closureId:string;reference:string;reportIds:string[];versions:Record<string,string>;area:string;fileId:string;to:string;cc:string;subject:string;body:string;includeSummary:boolean};const action=text(b.action,50),now=new Date().toISOString();let projectId=text(b.projectId,100);
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
 const closed=(r:Report)=>data.closures.some(c=>c.week===weekOf(r.date));
 const guardWeek=(week:string)=>need(!data.packages.some(p=>p.deliveryState==='sending'&&((p.weeks||[p.week]).includes(week)||p.includeSummary&&(p.weeks||[p.week]).slice().sort().at(-1)!>=week)),'Diese Kalenderwoche ist Teil eines laufenden Versands. Bitte kurz warten.');
 const account=(week:string):WeekRecord=>weekRecord(data,week)||{id:projectId+':account:'+week,projectId,week,adjustments:[],history:[],updatedAt:''};
 if(action==='saveProject'){need(!data.packages.some(p=>p.deliveryState==='sending'),'Ein Versand läuft gerade. Bitte die Projektänderung danach speichern.');need(b.project.updatedAt===project.updatedAt,'Projekt wurde geändert. Bitte Stammdaten neu öffnen.');puts.push({kind:'project',value:{...projectValues({...b.project,...(project.planId?{planId:project.planId,name:project.name,number:project.number,orderNumber:project.orderNumber,customer:project.customer,address:project.address,foremanName:project.foremanName}:{}),requiresCumulative:b.project.requiresCumulative??project.requiresCumulative,timeRates:b.project.timeRates??project.timeRates,contactPersons:b.project.contactPersons??project.contactPersons},projectId,now),teams:project.teams||[],employees:project.employees||[],...(project.archivedAt?{archivedAt:project.archivedAt}:{}),...(project.archivedByPlan?{archivedByPlan:true}:{})}});if(b.project.factor!==project.factor){for(const r of data.reports)puts.push({kind:'report',value:r});for(const c of data.closures)puts.push({kind:'closure',value:c});}}
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
   if(v.id){need(old,'Aufmaß nicht gefunden.');need(old.updatedAt===v.updatedAt,'Dieses Aufmaß wurde geändert. Bitte neu öffnen.');need(old.state==='draft','Aufmaß ist fertiggestellt. Bitte zuerst zur Korrektur öffnen.');}
   const kind=reportKind(v);need(['measurement','extra','timesheet'].includes(kind),'Ungültige Formularart.');const parentReportId=old?.parentReportId||text(v.parentReportId,100),parent=parentReportId?data.reports.find(r=>r.id===parentReportId):undefined;need(!old||v.parentReportId===undefined||v.parentReportId===old.parentReportId,'Die Zuordnung zum Aufmaß kann nicht geändert werden.');if(parentReportId){need(kind==='extra'&&parent&&reportKind(parent)==='measurement'&&parent.projectId===projectId&&parent.id!==old?.id,'Mehraufwand muss zu einem Aufmaß dieses Projekts gehören.');need(old||parent.state==='draft','Bitte das Aufmaß vor dem Hinzufügen von Mehraufwand zur Bearbeitung öffnen.');}need(!old||reportKind(old)===kind,'Die Formularart eines gespeicherten Berichts kann nicht geändert werden.');const bounds=isTimeReport(v)?timeReportBounds(v.timeSheet!):null,day=bounds?bounds.date:date(v.date),end=bounds?bounds.endDate:date(v.endDate||v.date);guardWeek(weekOf(day));need(end>=day&&weekOf(day)===weekOf(end)&&(isTimeReport(v)||day.slice(0,7)===end.slice(0,7)),'Ein Aufmaß darf keine Wochen- oder Monatsgrenze überschreiten. Bitte in zwei Aufmaße aufteilen.');if(old&&weekOf(old.date)!==weekOf(day)){need(!old.sentAt&&!data.packages.some(p=>p.reportIds.includes(old.id)),'Dieses Aufmaß gehört zu einem Versandpaket. Das Datum kann nur innerhalb derselben Kalenderwoche geändert werden.');need(!closed(old)&&!data.closures.some(c=>c.week===weekOf(day)),'Eine der beiden Kalenderwochen ist abgeschlossen. Bitte die Woche zuerst öffnen.');need(!data.reports.some(r=>r.parentReportId===old.id),'Bitte zuerst die verknüpften Mehraufwandberichte entfernen.');}if(parent)need(day>=parent.date&&end<=(parent.endDate||parent.date),'Die Mehraufwandtage müssen im Zeitraum des zugehörigen Aufmaßes liegen.');if(old&&kind==='measurement')need(data.reports.filter(r=>r.parentReportId===old.id).every(r=>r.date>=day&&(r.endDate||r.date)<=end),'Der neue Zeitraum muss die verknüpften Mehraufwandtage einschließen.');
   const area=text(v.area,200);need(Array.isArray(v.lines)&&v.lines.length<=500,'Zu viele Positionen.');const crew=canonicalCrews(v,project,old||parent,(Math.round((Date.parse(end)-Date.parse(day))/86400000)+1)*24,isTimeReport(v)),team=crew.team!,employeeMembers=crew.employeeMembers||[],teamWork=crew.teamWork||null;
   const lines:Line[]=isTimeReport(v)?[]:v.lines.map(l=>{const position=data.positions.find(p=>p.id===l.positionId),prior=old?.lines.find(x=>x.id===l.id);need(position||prior,'LV-Position nicht mehr verfügbar. Bitte neu auswählen.');const source=prior||position!,quantity=Number(l.quantity),inputRemark=text(l.remark,2000),trigger=remarkAdjustment(inputRemark),basePrice=prior?.basePrice??source.price,requested=l.priceAdjustment;need(requested===undefined||typeof requested==='number'&&Number.isFinite(requested),'Ungültige EP-Anpassung.');const priceAdjustment=trigger?(requested===undefined?trigger.suggested===undefined?undefined:trigger.sign*trigger.suggested:trigger.sign*Math.abs(requested)):0,remark=trigger&&priceAdjustment!==undefined?percentRemark(inputRemark,Math.abs(priceAdjustment)):inputRemark,price=trigger||prior?.basePrice!==undefined?adjustedPrice(basePrice,priceAdjustment??0):source.price,employeeFactor=prior?.employeeFactor??project.factor;need(Number.isFinite(quantity)&&quantity>=0&&quantity<=1e8,'Mengen müssen eine gültige Zahl ab 0 sein.');return{id:prior?.id||crypto.randomUUID(),positionId:prior?.positionId||position!.id,number:source.number,description:source.description,unit:source.unit,price,...(trigger||prior?.basePrice!==undefined?{basePrice,priceAdjustment}:{}),employeePrice:Math.round(price*employeeFactor),employeeFactor,quantity,remark};});
   id=old?.id||crypto.randomUUID();const r:Report={id,projectId,...(parentReportId?{parentReportId}:{}),...(old?.clientDraftId||clientDraftId?{clientDraftId:old?.clientDraftId||clientDraftId}:{}),...(isTimeReport(v)?{kind}:old?.kind?{kind:old.kind}:{}),date:day,endDate:end,team,teamWork,employeeMembers,...(crew.crews?{crews:crew.crews}:{}),author:text(v.author||project.foremanName||user,160),area,note:text(v.note,12000),lines,state:'draft',review:old?.review||'pending',reviewNote:old?.reviewNote||'',createdAt:old?.createdAt||now,updatedAt:now,sentAt:old?.sentAt||null,deadline:old?.deadline||null};if(isTimeReport(v)){r.timeSheet=canonicalTimeSheet(project,{...r,timeSheet:v.timeSheet},old);r.lines=timeLines(r);for(const c of reportCrews(r))if(c.teamWork)c.teamWork.workers=c.teamWork.workers.map((w,i)=>({...w,hours:r.timeSheet!.entries.filter(e=>e.workerId===`sub:${c.teamWork!.code}:${i}`).reduce((sum,e)=>sum+(workMinutes(e)||0)/60,0)}));}if(!old&&data.closures.some(c=>c.week===weekOf(day))){const record=account(weekOf(day));puts.push({kind:'weekrecord',value:{...record,reportBases:{...record.reportBases,[r.id]:null},updatedAt:now}});}puts.push({kind:'report',value:r});detail=`${day} · ${team} · ${area}`;
 }
 else if(action==='correctReport'){
   const input=b as unknown as {id:string;updatedAt:string;rows:{id:string;quantity:number}[];timeEntries?:{id:string;start:string;end:string;pauseMinutes:number;allowanceQuantity:number}[];reason:string;fileId:string;verified:boolean},r=reportById(input.id);id=r.id;guardWeek(weekOf(r.date));need(r.state==='ready','Bitte den aktuellen Entwurf zuerst speichern und fertigstellen.');need(input.updatedAt===r.updatedAt,'Das Aufmaß wurde geändert. Bitte Mengenvergleich neu öffnen.');need(input.verified===true,'Bitte alle Mengen mit dem Kundenrücklauf prüfen und bestätigen.');need(text(input.reason),'Bitte einen Korrekturgrund angeben.');const file=input.fileId?data.files.find(f=>f.id===input.fileId&&returnBelongsToReport(f,r)):undefined;need(!input.fileId||file,'Kundenrücklauf gehört nicht zu diesem Aufmaß.');
   let corrected:Report={...r,updatedAt:now,review:file?'approved':'pending',reviewNote:text(input.reason,2000),...(file?{reviewFileId:file.id}:{})};
   if(isTimeReport(r)){need(Array.isArray(input.timeEntries)&&input.timeEntries.length===r.timeSheet?.entries.length,'Bitte alle Stundenzeilen prüfen.');const ids=new Set<string>();const sheet={...r.timeSheet!,entries:r.timeSheet!.entries.map(e=>{const value=input.timeEntries!.find(v=>v.id===e.id);need(value&&!ids.has(value.id),'Stundenzeile fehlt oder wurde doppelt erfasst.');ids.add(value.id);need(e.allowanceQuantity!==undefined||value.allowanceQuantity===e.travelQuantity+e.overnightQuantity,'Alte getrennte Pauschalen bitte über die erneute Berichtsbearbeitung ändern.');return{...e,start:value.start,end:value.end,pauseMinutes:value.pauseMinutes,...(e.allowanceQuantity!==undefined?{allowanceQuantity:value.allowanceQuantity,travelQuantity:0,overnightQuantity:0}:{})};})};corrected.timeSheet=canonicalTimeSheet(project,{...r,timeSheet:sheet},r);corrected.timeSheet.entries=corrected.timeSheet.entries.map(e=>({...e,rates:r.timeSheet!.entries.find(old=>old.id===e.id)!.rates}));need(corrected.timeSheet.entries.every(e=>workMinutes(e)!==null),'Bitte Anfang, Ende und Pause prüfen.');corrected.lines=timeLines(corrected);need(!timeReadiness(corrected).length,timeReadiness(corrected).join(' '));}
   else {need(Array.isArray(input.rows)&&input.rows.length===r.lines.length,'Bitte sämtliche Aufmaßzeilen prüfen.');const ids=new Set<string>();corrected.lines=r.lines.map(line=>{const value=input.rows.find(v=>v.id===line.id);need(value&&!ids.has(value.id),'Aufmaßzeile fehlt oder wurde doppelt erfasst.');ids.add(value.id);const quantity=value.quantity;need(typeof quantity==='number'&&Number.isFinite(quantity)&&quantity>=0&&quantity<=1e8&&Math.abs(quantity*10000-Math.round(quantity*10000))<.001,'Korrigierte Mengen benötigen eine gültige Zahl ab 0 mit höchstens vier Nachkommastellen.');return{...line,quantity};});}
   if(file?.packageId){const pack=data.packages.find(p=>p.id===file.packageId);need(pack&&pack.reportIds.includes(r.id),'Rücklauf gehört nicht zum Versandpaket.');puts.push({kind:'package',value:recordPackageReview(pack,corrected,file.id,now,user)});}
   puts.push({kind:'reportrevision',value:{id:crypto.randomUUID(),projectId,reportId:r.id,before:r,after:corrected,at:now,user,reason:text(input.reason,2000),fileId:file?.id||'',verified:true}},{kind:'report',value:corrected});const record=account(weekOf(r.date));if(!Object.prototype.hasOwnProperty.call(record.reportBases||{},r.id))puts.push({kind:'weekrecord',value:{...record,reportBases:{...record.reportBases,[r.id]:r},updatedAt:now}});detail=`${r.date} · Mengenprüfung/Korrektur · ${text(input.reason,2000)}`;
 }
 else if(['finalizeReport','reopenReport','deleteDraft','markReview'].includes(action)){
   const r=reportById(text(b.id));id=r.id;guardWeek(weekOf(r.date));need(!data.packages.some(p=>p.deliveryState==='sending'&&p.reportIds.includes(r.id)),'Dieses Aufmaß wird gerade versandt. Bitte kurz warten.');need(!b.updatedAt||r.updatedAt===b.updatedAt,'Aufmaß wurde zwischenzeitlich geändert.');
   if(action==='finalizeReport'){need(r.state==='draft'&&r.lines.length,'Bitte mindestens eine Leistung eintragen.');let finalized=r;need(!measurementHoursIssues(r).length,measurementHoursIssues(r).join(' '));if(isTimeReport(r)){finalized={...r,timeSheet:canonicalTimeSheet(project,r,r)};finalized.lines=timeLines(finalized);need(!timeReadiness(finalized).length,timeReadiness(finalized).join(' '));}else need(!r.lines.some(adjustmentMissing),'Bitte den prozentualen Zu- oder Abschlag an jeder markierten Position eintragen (0 % ist zulässig).');puts.push({kind:'report',value:{...finalized,state:'ready',updatedAt:now}});}
   if(action==='reopenReport'){need(r.state==='ready','Der Bericht ist bereits zur Bearbeitung geöffnet.');need(text(b.reason),'Bitte einen Grund für die Korrektur eintragen.');const record=account(weekOf(r.date));puts.push({kind:'reportrevision',value:{id:crypto.randomUUID(),projectId,reportId:r.id,before:r,at:now,user,reason:text(b.reason)}});if(!Object.prototype.hasOwnProperty.call(record.reportBases||{},r.id))puts.push({kind:'weekrecord',value:{...record,reportBases:{...record.reportBases,[r.id]:r},updatedAt:now}});puts.push({kind:'report',value:{...r,state:'draft',review:'pending',updatedAt:now}});detail=text(b.reason);}
   if(action==='deleteDraft'){need(!data.reports.some(child=>child.parentReportId===r.id),'Bitte zuerst die verknüpften Mehraufwandberichte entfernen.');need(r.state==='draft'&&!closed(r)&&!r.sentAt,'Nur unversandte Entwürfe können gelöscht werden.');need(!data.files.some(f=>f.reportId===r.id),'Bitte zuerst die Anlagen entfernen.');deletes.push(r.id);}
   if(action==='markReview'){need(['pending','approved','changes'].includes(b.review),'Ungültiger Prüfstatus.');if(b.review==='approved')need(data.files.some(f=>returnBelongsToReport(f,r)),'Bitte zuerst das geprüfte/unterschriebene Kundenaufmaß hochladen.');puts.push({kind:'report',value:{...r,review:b.review,reviewNote:text(b.note),updatedAt:now}});}
 }
 else if(action==='approvePackageReturn'){
  const input=b as unknown as {id:string;fileId:string;verified:boolean;versions:Record<string,string>;reason:string},pack=data.packages.find(p=>p.id===input.id);need(pack?.sentAt,'Bitte ein bestätigtes Versandpaket auswählen.');need(input.verified===true&&text(input.reason),'Bitte bestätigen, dass sämtliche Aufmaße anhand des Kundenrücklaufs geprüft wurden.');const file=data.files.find(f=>f.id===input.fileId&&f.kind==='signed'&&f.packageId===pack.id&&f.projectId===projectId);need(file,'Bitte den geprüften Kundenrücklauf zum Versandpaket hochladen.');let updated=pack;
  for(const reportId of pack.reportIds){const r=reportById(reportId);guardWeek(weekOf(r.date));need(r.state==='ready'&&input.versions?.[r.id]===r.updatedAt,'Ein Aufmaß wurde geändert oder erneut geöffnet. Bitte den Rücklauf aktualisieren und erneut prüfen.');if(packageReportReviewed(pack,r))continue;const approved={...r,review:'approved' as const,reviewFileId:file.id,reviewNote:text(input.reason,2000),updatedAt:now};puts.push({kind:'report',value:approved},{kind:'reportrevision',value:{id:crypto.randomUUID(),projectId,reportId:r.id,before:r,after:approved,at:now,user,reason:text(input.reason,2000),fileId:file.id,verified:true}});updated=recordPackageReview(updated,approved,file.id,now,user);}
  puts.push({kind:'package',value:updated});id=pack.id;detail='Kundenrücklauf vollständig geprüft · '+pack.reportIds.length+' Aufmaße · '+text(input.reason,2000);
 }
 else if(action==='closeWeek'||action==='closeWeeks'){
   const bulk=action==='closeWeeks',input=b as unknown as {weeks:unknown;tokens:Record<string,string>;confirmQuantities:boolean};need(input.confirmQuantities===true,'Bitte bestätigen, dass die Mengen der ausgewählten Kalenderwochen geprüft und Rücklaufkorrekturen eingearbeitet sind.');
   let weeks:string[];if(bulk){need(Array.isArray(input.weeks)&&input.weeks.length>0&&input.weeks.length<=52,'Bitte 1–52 Kalenderwochen auswählen.');weeks=input.weeks.map(calendarWeek);need(new Set(weeks).size===weeks.length,'Eine Kalenderwoche wurde mehrfach ausgewählt.');weeks.sort();}else weeks=[calendarWeek(b.week)];
   for(const week of weeks){guardWeek(week);if(bulk)need(input.tokens?.[week]===weekToken(data,week),`${week} wurde geändert. Bitte die Woche erneut auswählen.`);const reports=data.reports.filter(r=>weekOf(r.date)===week);need(reports.length&&reports.every(r=>r.state==='ready'),`${week}: Alle Berichte dieser Woche müssen fertiggestellt sein.`);
    need(!reports.some(r=>measurementHoursIssues(r).length),`${week}: Bitte Nachunternehmerstunden zuerst vollständig den einzelnen Aufmaßtagen zuordnen.`);const existing=data.closures.find(c=>c.week===week),rows=aggregate(reports,project.factor),value=aggregateTotals(effectiveWeekRows({...data,closures:data.closures.filter(c=>c.week!==week)},project,week),project.factor);id=existing?.id||`${projectId}:${week}`;if(existing)puts.push({kind:'closurerevision',value:{id:crypto.randomUUID(),projectId,week,before:existing,weekRecord:weekRecord(data,week),at:now,user}});
    const c:Closure={id,projectId,week,closedAt:now,reportIds:reports.map(r=>r.id),rows,customerValue:value.customer,employeeValue:value.employee,invoiceNumber:existing?.invoiceNumber||'',invoiceDate:existing?.invoiceDate||'',invoiceAmount:existing?.invoiceAmount??null,sourceToken:weekSourceToken(data,week),adjustmentToken:JSON.stringify(weekRecord(data,week)?.adjustments||[]),quantitiesConfirmed:true,updatedAt:now};
    const nextData={...data,closures:[...data.closures.filter(v=>v.week!==week),c],weekRecords:data.weekRecords.map(record=>record.week===week?{...record,reportBases:{}}:record)};c.documentSnapshot={basis:invoiceBasis(nextData,project,week),project,company:data.company||defaultCompany()};puts.push({kind:'closure',value:c});const record=account(week);if(record.reportBases)puts.push({kind:'weekrecord',value:{...record,reportBases:{},updatedAt:now}});
   }detail=weeks.join(', ')+' · ausgewählte Wochenmengen geprüft und für Rechnung abgeschlossen';
 }
 else if(action==='reopenWeek'){
   const c=data.closures.find(c=>c.id===b.id);need(c,'Abschluss nicht gefunden.');guardWeek(c.week);need(!weekFinance(data,project,c.week).invoice.number&&!data.payments.some(p=>paymentWeek(data,p)===c.week),'Eine fakturierte oder bezahlte Woche kann nicht überschrieben werden. Bitte eine Korrektur gesondert erfassen.');need(!data.packages.some(p=>(p.weeks||[p.week]).includes(c.week)&&p.sentAt),'Diese Woche wurde bereits versandt. Der Abschluss bleibt als Nachweis erhalten.');need(text(b.reason),'Bitte einen Grund angeben.');puts.push({kind:'closurerevision',value:{id:crypto.randomUUID(),projectId,week:c.week,before:c,at:now,user,reason:text(b.reason)}});deletes.push(c.id);detail=text(b.reason);
 }
 else if(action==='correctWeek'){
   need(requiresCumulative(project),'Für dieses Projekt ist keine kumulierte Aufmaßkorrektur vorgesehen. Einzelaufmaße bearbeiten oder die Rechnungsdaten korrigieren.');
   const input=b as unknown as {week:string;token:string;reason:string;rows:{key?:string;positionId?:string;quantity:number}[]},week=calendarWeek(input.week);const effectiveDate=date(b.date||weekStart(week));need(weekOf(effectiveDate)===week,'Das Zuordnungsdatum muss in der korrigierten Kalenderwoche liegen.');need(input.token===weekToken(data,week),'Die Kalenderwoche wurde geändert. Bitte Korrektur neu öffnen.');const reason=text(input.reason,2000);need(reason,'Bitte einen Korrekturgrund eintragen.');need(Array.isArray(input.rows)&&input.rows.length<=2500,'Bitte höchstens 2.500 Positionen korrigieren.');
   guardWeek(week);
   const current=effectiveWeekRows(data,project,week),currentMap=new Map(current.map(r=>[r.key,r])),seen=new Set<string>(),changes:NonNullable<WeekChange['rows']>=[],deltas:Aggregate[]=[];
   for(const entry of input.rows){let source=currentMap.get(text(entry.key,300));if(!source){const position=data.positions.find(p=>p.id===entry.positionId);need(position,'LV-Position nicht gefunden. Bitte Korrektur neu öffnen.');source={key:aggregateKey({...position,employeeFactor:project.factor}),number:position.number,description:position.description,unit:position.unit,price:position.price,employeePrice:Math.round(position.price*project.factor),employeeFactor:project.factor,quantity:0,customerValue:0,employeeValue:0};source=currentMap.get(source.key)||source;}
    need(!seen.has(source.key),'Eine Position wurde doppelt eingetragen.');seen.add(source.key);const quantity=Number(entry.quantity);need(typeof entry.quantity==='number'&&Number.isFinite(quantity)&&quantity>=0&&quantity<=1e8&&Math.abs(quantity*10000-Math.round(quantity*10000))<.001,'Korrigierte Mengen müssen zwischen 0 und 100.000.000 liegen und höchstens vier Nachkommastellen haben.');if(quantity===source.quantity)continue;
    const customerValue=integer(Math.round(quantity*source.price)),employeeFactor=source.employeeFactor??project.factor,after={...source,quantity,customerValue,employeeFactor,employeeValue:employeeValue([{customer:customerValue,factor:employeeFactor}])};changes.push({before:source,after});deltas.push({...after,quantity:quantity-source.quantity,customerValue:customerValue-source.customerValue,employeeValue:after.employeeValue-source.employeeValue});
   }
   need(current.every(r=>seen.has(r.key)),'Eine bestehende Position fehlt. Bitte zum Entfernen die Menge auf 0 setzen.');need(changes.length,'Es wurden keine Mengen geändert.');const month=effectiveDate.slice(0,7),monthLast=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0,12)).toISOString().slice(0,10),monthRows=rangeWeekRows(data,project,week,month+'-01',monthLast);need(mergeRows([monthRows,deltas]).every(r=>r.quantity>=0&&r.customerValue>=0),'Diese Kürzung würde im zugeordneten Monat negative Mengen ergeben. Bitte die Korrektur nach Monaten aufteilen und passende Zuordnungsdaten wählen.');const record=account(week),change:WeekChange={id:crypto.randomUUID(),at:now,user,kind:'measurement',reason,effectiveDate,rows:changes};id=record.id;puts.push({kind:'weekrecord',value:{...record,adjustments:mergeRows([record.adjustments,deltas]).filter(r=>r.quantity!==0||r.customerValue!==0),history:[...record.history,change],updatedAt:now}});detail=`${week} · ${changes.length} Positionskorrekturen · ${reason}`;
 }
 else if(action==='saveInvoice'||action==='saveWeekInvoice'){
   const c=action==='saveInvoice'?data.closures.find(c=>c.id===b.id):undefined;need(action!=='saveInvoice'||c,'Bitte zuerst die Woche abschließen.');const week=calendarWeek(c?.week||b.week);guardWeek(week);if(c)need(!b.updatedAt||b.updatedAt===c.updatedAt,'Rechnungsdaten wurden geändert. Bitte neu öffnen.');else need((b as unknown as {token:string}).token===weekToken(data,week),'Die Kalenderwoche wurde geändert. Bitte neu öffnen.');
   const amount=integer(b.amount),number=text(b.number,100);need(number,'Rechnungsnummer fehlt.');const financial=weekFinance(data,project,week),reason=text(b.reason,2000);need(!financial.invoice.number||reason,'Bitte einen Grund für die Rechnungskorrektur eintragen.');const record=account(week),invoice={number,date:date(b.date),amount},change:WeekChange={id:crypto.randomUUID(),at:now,user,kind:'invoice',reason:reason||'Rechnung erstmals erfasst',invoiceBefore:financial.invoice,invoiceAfter:invoice};id=record.id;puts.push({kind:'weekrecord',value:{...record,invoice,history:[...record.history,change],updatedAt:now}});if(c)puts.push({kind:'closure',value:{...c,invoiceNumber:number,invoiceDate:invoice.date,invoiceAmount:amount,updatedAt:now}});detail=`${week} · ${invoice.number} · ${change.reason}`;
 }
 else if(action==='addPayment'){
   const c=b.closureId?data.closures.find(c=>c.id===b.closureId):undefined;need(!b.closureId||c,'Kalenderwoche nicht gefunden.');const week=calendarWeek(b.week||c?.week);need(!c||c.week===week,'Zahlung und Wochenabschluss gehören nicht zur selben Kalenderwoche.');const amount=integer(b.amount);need(amount>0,'Zahlung muss größer als 0 sein.');id=crypto.randomUUID();const p:Payment={id,projectId,closureId:c?.id||data.closures.find(x=>x.week===week)?.id||'',week,date:date(b.date),amount,reference:text(b.reference,500),updatedAt:now};puts.push({kind:'payment',value:p});detail=`${week} · ${amount/100} EUR`;
 }
 else if(action==='deletePayment'){
   const p=data.payments.find(p=>p.id===b.id);need(p,'Zahlung nicht gefunden.');const reason=text(b.reason,2000);need(reason,'Bitte einen Korrekturgrund angeben.');const week=calendarWeek(paymentWeek(data,p));guardWeek(week);const record=account(week),change:WeekChange={id:crypto.randomUUID(),at:now,user,kind:'payment',reason,paymentBefore:p};puts.push({kind:'payment',value:{...p,voidedAt:now,voidReason:reason,updatedAt:now}},{kind:'weekrecord',value:{...record,history:[...record.history,change],updatedAt:now}});detail=`${week} · ${reason}`;
 }
 else if(action==='preparePackage'){
   need(b.includeSummary===true&&(b as unknown as {overviewVersion:number}).overviewVersion===1,'Bitte das Versandpaket neu erstellen. Die Wochenmassenübersicht ist jetzt immer enthalten.');need((b as unknown as {summaryMode:string}).summaryMode===(requiresCumulative(project)?'cumulative':'weekly'),'Projekteinstellung wurde geändert. Bitte Paket neu erstellen.');
   need(Array.isArray(b.reportIds)&&b.reportIds.length>0&&b.reportIds.length<=500&&new Set(b.reportIds).size===b.reportIds.length,'Bitte 1–500 unterschiedliche Aufmaße auswählen.');const reports=b.reportIds.map((rid:string)=>reportById(rid));need(!bundleIssue(reports,data.reports),bundleIssue(reports,data.reports));const weeks=[...new Set(reports.map((r:Report)=>weekOf(r.date)))].sort() as string[],week=weeks[0],area='';need(reports.every((r:Report)=>r.state==='ready'),'Bitte alle gewählten Aufmaße zuerst fertigstellen.');need(reports.every((r:Report)=>b.versions?.[r.id]===r.updatedAt),'Aufmaße wurden während der PDF-Erstellung geändert. Bitte Paket neu erstellen.');const cumulativeToken=b.includeSummary?summaryToken(data,weeks.at(-1)!):undefined;need(!b.includeSummary||(b as unknown as {summaryToken:string}).summaryToken===cumulativeToken,'Kumulierung wurde geändert. Bitte das Versandpaket neu erstellen.');const file=data.files.find(f=>f.id===b.fileId&&f.kind==='package');need(file,'Versand-PDF fehlt.');const to=emails(b.to);need(to,'Empfänger fehlt.');id=crypto.randomUUID();const pack:MailPackage={id,projectId,week,weeks,area,deliveryState:'prepared',reportIds:reports.map((r:Report)=>r.id),includeSummary:true,overviewVersion:1,summaryMode:requiresCumulative(project)?'cumulative':'weekly',summaryToken:cumulativeToken,to,cc:emails(b.cc),subject:text(b.subject,300).replace(/[\r\n]/g,' '),body:text(b.body,20000),preparedAt:now,sentAt:null,deadline:null,fileId:file.id};puts.push({kind:'package',value:{...pack,versions:b.versions}});detail=`${week} · ${area} · ${reports.length} Aufmaße`;
 }
 else if(action==='markPackageSent'){
   const pack=data.packages.find(p=>p.id===b.id) as (MailPackage&{versions:Record<string,string>})|undefined;need(pack&&!pack.sentAt&&pack.deliveryState!=='sending','Versandpaket nicht gefunden oder bereits versandt.');const reports=pack.reportIds.map(reportById);need(!bundleIssue(reports,data.reports),bundleIssue(reports,data.reports));need(packetSummaryValid(data,pack),'Projekteinstellung oder Kumulierung wurde geändert. Bitte neues Versandpaket erstellen.');need(reports.every(r=>r.state==='ready'&&r.updatedAt===pack.versions[r.id]),'Aufmaße wurden geändert. Bitte neues Versandpaket erstellen.');const sentDate=date(b.date),deadline=project.deadlineDays>0?deadlineFrom(sentDate,project.deadlineDays,project.deadlineType==='working'):null;puts.push({kind:'package',value:{...pack,sentAt:sentDate,deadline,deliveryState:'sent'}});for(const r of reports)puts.push({kind:'report',value:{...r,sentAt:sentDate,deadline,updatedAt:now}});detail=`Tatsächlicher Versand am ${sentDate}`;
 }
 else if(action==='archiveProject'){
   const archived=(b as unknown as {archived:boolean}).archived===true,{archivedAt:_old,archivedByPlan:_by,...rest}=project;puts.push({kind:'project',value:{...rest,...(archived?{archivedAt:now}:{}),updatedAt:now}});detail=`${project.number} · ${project.name} · ${archived?'archiviert':'wiederhergestellt'}`;
 }
 else if(action==='projectImpact'||action==='deleteProject'){
   need(project.archivedAt,'Bitte das Projekt zuerst archivieren.');
   const invoices=[...data.closures.filter(c=>c.invoiceNumber||c.invoiceAmount).map(c=>({week:c.week,number:c.invoiceNumber,amount:c.invoiceAmount})),...data.weekRecords.filter(w=>w.invoice).map(w=>({week:w.week,number:w.invoice!.number,amount:w.invoice!.amount}))],sentPackages=data.packages.filter(p=>p.sentAt).length,paidAmount=data.payments.reduce((sum,p)=>sum+p.amount,0);
   const impact={reports:data.reports.length,packages:data.packages.length,sentPackages,closures:data.closures.length,invoices,payments:data.payments.length,paidAmount,files:data.files.length},sensitive=invoices.length>0||data.payments.length>0||sentPackages>0;
   if(action==='projectImpact')return Response.json({ok:true,impact,sensitive,number:project.number});
   if(sensitive)need(text((b as unknown as {confirmNumber:string}).confirmNumber,100)===project.number,'Bitte die Projektnummer zur Bestätigung eintragen.');
   const keys=data.files.flatMap(f=>[f.key,f.original?.key]).concat(data.packages.map(p=>(p as MailPackage&{emlKey?:string}).emlKey)).filter((k):k is string=>!!k);
   await db().batch([db().prepare('DELETE FROM records WHERE project_id = ?').bind(projectId),db().prepare('DELETE FROM audit WHERE project_id = ?').bind(projectId),db().prepare('DELETE FROM project_revisions WHERE id = ?').bind(projectId),...(project.planId?[db().prepare("INSERT OR REPLACE INTO records (id,kind,project_id,data,updated_at) VALUES (?,'plandeleted','system','{}',?)").bind('plandel:'+project.planId,now)]:[]),db().prepare('INSERT INTO audit (id,project_id,action,user,detail,at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(),'system','Projekt gelöscht',user,`${project.number} · ${project.name} · ${impact.reports} Aufmaße, ${invoices.length} Rechnungen, ${impact.payments} Zahlungen`,now)]);
   await Promise.all(keys.map(k=>bucket().delete(k).catch(()=>{})));
   return Response.json({ok:true,id:projectId});
 }
 else if(action==='deleteReport'){
   const r=reportById(text(b.id)),reason=text(b.reason,2000);id=r.id;guardWeek(weekOf(r.date));
   need(reason,'Bitte einen Grund für das Löschen angeben.');need(!b.updatedAt||r.updatedAt===b.updatedAt,'Aufmaß wurde zwischenzeitlich geändert.');
   need(!closed(r),'Die Kalenderwoche ist abgeschlossen. Bitte die Woche zuerst öffnen.');need(!data.reports.some(c=>c.parentReportId===r.id),'Bitte zuerst die verknüpften Mehraufwandberichte entfernen.');
   const packs=data.packages.filter(p=>p.reportIds.includes(r.id));need(!r.sentAt&&packs.every(p=>!p.sentAt&&p.deliveryState==='prepared'&&p.reportIds.length===1),'Das Aufmaß ist Teil eines versandten oder gemeinsamen Versandpakets und bleibt als Nachweis erhalten.');
   const files=data.files.filter(f=>f.reportId===r.id||packs.some(p=>f.packageId===p.id||f.id===p.fileId));
   puts.push({kind:'deletedreport',value:{id:'deleted:'+r.id,report:r,packages:packs,files,reason,user,at:now}});deletes.push(r.id,...packs.map(p=>p.id),...files.map(f=>f.id));detail=`${r.date} · ${r.team} · ${reason}`;
 }
 else if(action==='createPortalLink'){
   const pack=data.packages.find(p=>p.id===b.id);need(pack?.sentAt,'Bitte zuerst den Versand bestätigen.');const reports=pack.reportIds.map(reportById);need(reports.every(r=>r.state==='ready'),'Ein Aufmaß wurde erneut geöffnet. Bitte ein neues Versandpaket erstellen.');
   const portal=await buildPortal(pack,reports,user);need(portal,'Dieses Paket enthält keine Aufmaßmengen für den Kundenlink.');
   puts.push({kind:'portal',value:portal.link},...(portal.revoked?[{kind:'portal',value:portal.revoked}]:[]),{kind:'package',value:{...pack,portalId:portal.link.id}});extra={url:portalUrl(new URL(request.url).origin,portal.token),until:portal.until};id=pack.id;detail='Kundenlink erstellt';
 }
 else if(action==='decidePortal'){
   const input=b as unknown as {id:string;decision:string;note:string},link=data.portals?.find(p=>p.id===input.id);need(link?.status==='submitted'&&link.submission,'Es liegt keine offene Kundenrückmeldung vor.');
   const pack=data.packages.find(p=>p.id===link.packageId);need(pack?.sentAt,'Versandpaket nicht gefunden.');id=link.id;const note=text(input.note,2000);
   if(input.decision==='reject'){need(note,'Bitte einen Grund für die Ablehnung eintragen.');puts.push({kind:'portal',value:{...link,status:'rejected',decision:{at:now,user,note}}});detail='Kundenrückmeldung abgelehnt · '+note;}
   else{
    need(input.decision==='apply','Ungültige Entscheidung.');const submission=link.submission,file=data.files.find(f=>f.id===submission.fileId);need(file,'Bestätigungs-PDF fehlt.');
    let updated:MailPackage=pack,count=0;const records=new Map<string,WeekRecord>();
    for(const ref of link.reports){
     const r=reportById(ref.id);guardWeek(weekOf(r.date));need(r.state==='ready','Ein Aufmaß wurde erneut geöffnet. Bitte die Rückmeldung ablehnen und einen neuen Link senden.');
     const changes=submission.corrections.filter(c=>c.reportId===r.id);
     const lines=r.lines.map(l=>{const change=changes.find(c=>c.lineId===l.id);if(!change)return l;const sent=link.rows.find(x=>x.reportId===r.id&&x.lineId===l.id);need(sent&&sent.quantity===l.quantity,'Ein Aufmaß wurde seit dem Versand geändert. Bitte die Rückmeldung ablehnen und einen neuen Link senden.');count++;return{...l,quantity:change.quantity};});
     const reason=text(`Kundenrückmeldung über Online-Link von ${submission.name}${changes.length?'':' (Mengen bestätigt)'}${submission.note?': '+submission.note:''}`,2000),corrected:Report={...r,lines,updatedAt:now,review:'approved',reviewFileId:file.id,reviewNote:reason};
     puts.push({kind:'report',value:corrected},{kind:'reportrevision',value:{id:crypto.randomUUID(),projectId,reportId:r.id,before:r,after:corrected,at:now,user,reason,fileId:file.id,verified:true}});
     const week=weekOf(r.date),record=records.get(week)||account(week);if(!Object.prototype.hasOwnProperty.call(record.reportBases||{},r.id))records.set(week,{...record,reportBases:{...record.reportBases,[r.id]:r},updatedAt:now});
     updated=recordPackageReview(updated,corrected,file.id,now,user);
    }
    for(const value of records.values())puts.push({kind:'weekrecord',value});
    puts.push({kind:'package',value:updated},{kind:'portal',value:{...link,status:'applied',decision:{at:now,user,note}}});detail=`Kundenrückmeldung übernommen · ${count} Positionen korrigiert · ${submission.name}`;
   }
 }
 else throw new Error('Unbekannte Aktion.');
 await commit(projectId,action,user,puts,deletes,detail,revision.version,directoryChange);return Response.json({ok:true,id,...extra,...(createdPosition?{position:createdPosition}:{})});
 }catch(e){return Response.json({error:e instanceof Error?e.message:'Speichern fehlgeschlagen.'},{status:400});}}

// Every active Montageplanung project appears here on its own. A project a Planer deleted stays away.
// ponytail: per-isolate throttle, the sync full-scans records and the plan DB; use a KV/D1 timestamp if isolates multiply
let lastSync=0;
async function syncPlanProjects(){
 if(Date.now()-lastSync<120000)return;lastSync=Date.now();
 const plan=await readPlan();if(!plan.projects.length)return;
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
   const base:Project={id:'',name:m.name,number:m.number||'ohne Nummer',orderNumber:m.orderNumber,customer:m.customer,address:m.address,areas:[],foremanName:m.foreman,contact:m.foreman,measurementEmail:'',invoiceEmail:'',cc:'',contacts:'',factor:.9,deadlineDays:0,deadlineType:'calendar',template:defaultTemplate,hourlyNote:false,requiresCumulative:true,timeRates:defaultTimeRates(),planId:m.id,updatedAt:''};
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
 need(v&&text(v.name)&&text(v.number),'Projektname und Projektnummer fehlen.');need(v.requiresCumulative===undefined||typeof v.requiresCumulative==='boolean','Bitte die Einstellung zur kumulierten Aufstellung prüfen.');const factor=Number(v.factor);need(Number.isFinite(factor)&&factor>=0&&factor<=1,'Mitarbeiterfaktor muss zwischen 0 und 1 liegen.');const days=integer(v.deadlineDays,90),contactPersons=validateProjectContacts(v.contactPersons);return{id,name:text(v.name,200),foremanName:text(v.foremanName,160),number:text(v.number,100),orderNumber:text(v.orderNumber,100),customer:text(v.customer,200),address:text(v.address,1000),areas:[...new Set((v.areas||[]).map(x=>text(x,200)).filter(Boolean))].slice(0,100),teams:projectTeams(v.teams||[]),employees:projectEmployees(v.employees||[]),measurementEmail:emails(v.measurementEmail),invoiceEmail:emails(v.invoiceEmail),cc:emails(v.cc),contact:text(v.contact,200)||text(v.foremanName,160),...(v.planId?{planId:text(v.planId,100)}:{}),contacts:contactPersons===undefined?text(v.contacts,5000):contactText(contactPersons),...(contactPersons===undefined?{}:{contactPersons}),factor,deadlineDays:days,deadlineType:v.deadlineType==='working'?'working':'calendar',template:text(v.template||defaultTemplate,20000),hourlyNote:!!v.hourlyNote,requiresCumulative:requiresCumulative(v),timeRates:validateTimeRates(v.timeRates),updatedAt:now};
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
