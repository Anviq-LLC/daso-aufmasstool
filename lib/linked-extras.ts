import {randomId} from './ids';
import type {Project,Report} from './types';
import {dateLabel} from './business';
import {reportCrews} from './report-crews';
import {newTimeEntry,reportKind,timeWorkers} from './time-reports';
import {reportFileName} from './file-names';

export function measurementExtras(report:Report,reports:Report[]):Report[]{return reports.filter(r=>r.parentReportId===report.id&&r.projectId===report.projectId).sort((a,b)=>a.date.localeCompare(b.date)||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));}
export function reportBundle(report:Report,reports:Report[]):Report[]{return reportKind(report)==='measurement'?[report,...measurementExtras(report,reports)]:[report];}
export function reportSelectionBundle(selected:Report[],reports:Report[]):Report[]{const found=new Map<string,Report>(),ids=new Set(selected.map(r=>r.id));for(const report of selected.filter(r=>!r.parentReportId||!ids.has(r.parentReportId)))for(const item of reportBundle(report,reports))found.set(item.id,item);return [...found.values()];}
export function bundleIssue(selected:Report[],reports:Report[]):string{
 const ids=new Set(selected.map(r=>r.id));
 for(const report of selected)if(reportKind(report)==='measurement')for(const extra of measurementExtras(report,reports)){
  if(extra.state!=='ready')return 'Zum Aufmaß vom '+dateLabel(report.date)+' gehört noch ein Mehraufwand-Entwurf. Bitte zuerst fertigstellen.';
  if(!ids.has(extra.id))return 'Zum Aufmaß gehören Mehraufwandberichte. Bitte das vollständige Versandpaket neu erstellen.';
 }
 return '';
}
export function bundleFileName(project:Project,report:Report,reports:Report[]){const bundle=reportBundle(report,reports);return reportFileName(project,bundle.length===1?report:{...report,crews:bundle.flatMap(reportCrews)});}
export function linkedExtraDraft(parent:Report,project:Project):Report{
 if(!parent.id||reportKind(parent)!=='measurement')throw Error('Bitte zuerst das Aufmaß speichern.');
 const report:Report={...structuredClone(parent),id:'',clientDraftId:randomId(),parentReportId:parent.id,kind:'extra',revenueAllocation:undefined,lines:[],note:'Mehraufwand zum Aufmaß vom '+dateLabel(parent.date),state:'draft',createdAt:'',updatedAt:'',timeSheet:{mode:parent.endDate!==parent.date?'week':'day',anchorDate:parent.date,factor:project.factor,entries:[]}};
 report.timeSheet!.entries=timeWorkers(report).map(worker=>({...newTimeEntry(project,report,parent.date,worker),allowanceQuantity:0}));
 return report;
}
