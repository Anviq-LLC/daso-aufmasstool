import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ProjectContactsEditor,ProjectContactsSummary} from '../components/project-contacts';
import {projectContacts} from '../lib/project-contacts';
import {DailyRevenueOverview} from '../components/daily-revenue-overview';
import {ProjectTeams} from '../components/project-teams';
import {MeasurementExtras} from '../components/measurement-extras';
import {MultiReportCrew,CrewRevenue} from '../components/multi-report-crew';
import {ReportCrew,ReportEmployeeShares,EmployeeBreakdown} from '../components/report-crew';
import {PositionMatches} from '../components/position-matches';
import {AttachmentList,attachmentType} from '../components/attachment-list';
import {TimeReportFields} from '../components/time-report-fields';
import {ProjectTimeRates} from '../components/project-time-rates';
import {CompanyForm} from '../components/company-settings';
import {LinePriceAdjustment,QuantityInput} from '../components/line-price-adjustment';
import type {Project,Report,Data,Position} from '../lib/types';
export function renderCrew(project:Project,report:Report){return renderToStaticMarkup(<><ProjectTeams project={project} reportCodes={[]} busy={false} onSave={async()=>{}}/><ReportCrew project={project} report={report} disabled={false} onChange={()=>{}}/><ReportEmployeeShares report={report} factor={project.factor}/><EmployeeBreakdown reports={[report]} factor={project.factor}/></>);}


export function renderMatches(positions:Position[],query:string,selected=''){return renderToStaticMarkup(<PositionMatches positions={positions} query={query} selected={selected} disabled={false} onSelect={()=>{}}/>);}

export function renderTime(project:Project,report:Report,initialDay?:string){return renderToStaticMarkup(<><ProjectTimeRates project={project} disabled={false} onChange={()=>{}}/><TimeReportFields initialDay={initialDay} project={project} report={report} disabled={false} onChange={()=>{}}/></>);}

export {attachmentType};
export function renderAttachments(files: import("../lib/types").StoredFile[]){return renderToStaticMarkup(<AttachmentList files={files}/>);}

export function renderCompany(company:import('../lib/types').CompanyProfile){return renderToStaticMarkup(<CompanyForm value={company} busy={false} editable={true} onChange={()=>{}}/>);}
export function renderAdjustment(remark:string,value?:number){return renderToStaticMarkup(<><LinePriceAdjustment remark={remark} value={value} disabled={false} onChange={()=>{}}/><QuantityInput label='Menge' value={3} disabled={false} onChange={()=>{}}/></>);}

export function renderDailyRevenue(project:Project,reports:Report[],view:'teams'|'employees'='teams'){return renderToStaticMarkup(<DailyRevenueOverview project={project} reports={reports} initialView={view}/>);}

export function renderProjectContacts(project:Project){return renderToStaticMarkup(<><ProjectContactsEditor contacts={projectContacts(project)} disabled={false} onChange={()=>{}}/><ProjectContactsSummary project={project}/></>);}

export function renderMultiCrew(project:Project,report:Report){return renderToStaticMarkup(<><MultiReportCrew project={project} report={report} disabled={false} onChange={()=>{}}/><CrewRevenue report={report} factor={project.factor}/></>);}

export function renderMeasurementExtras(project:Project,report:Report,extras:Report[]){return renderToStaticMarkup(<><MultiReportCrew project={project} report={report} disabled={false} hasExtraHours={!!extras.length} onChange={()=>{}}/><MeasurementExtras project={project} report={report} extras={extras} disabled={false} onOpen={()=>{}}/><CrewRevenue report={report} factor={project.factor} additionalReports={extras}/></>);}
export function renderLinkedTime(project:Project,report:Report,parent:Report){return renderToStaticMarkup(<TimeReportFields project={project} report={report} dateRange={{date:parent.date,endDate:parent.endDate}} disabled={false} onChange={()=>{}}/>);}


