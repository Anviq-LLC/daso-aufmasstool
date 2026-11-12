import { env } from 'cloudflare:workers';
import type {Data,EmployeeDirectory,Project} from '@/lib/types';
import {normalizeFinancialData} from '@/lib/business';
import {COMPANY_ID,defaultCompany} from '@/lib/company';
import {EMPLOYEE_DIRECTORY_ID,employeeDirectory} from '@/lib/employee-directory';
export function db(){if(!env.DB)throw new Error('Datenbank ist noch nicht bereit.');return env.DB;}
export function bucket(){if(!env.BUCKET)throw new Error('Anlagenablage ist noch nicht bereit.');return env.BUCKET;}
export async function readData(projectId?:string):Promise<Data>{
 const rows=await db().prepare(projectId?'SELECT id,kind,data FROM records WHERE project_id = ? OR kind = ? OR id IN (?,?)':"SELECT id,kind,data FROM records WHERE kind != 'inbound'").bind(...(projectId?[projectId,'project',EMPLOYEE_DIRECTORY_ID,COMPANY_ID]:[])).all<{id:string;kind:string;data:string}>();
 const data:Data={projects:[],positions:[],reports:[],files:[],audit:[]},map:Record<string,keyof Data>={project:'projects',position:'positions',report:'reports',file:'files'};let stored:EmployeeDirectory|undefined;data.company=defaultCompany();
 for(const r of rows.results){if(r.id===COMPANY_ID){data.company=JSON.parse(r.data);continue;}if(r.id===EMPLOYEE_DIRECTORY_ID){stored=JSON.parse(r.data);continue;}const key=map[r.kind];if(key){const value=JSON.parse(r.data);(data[key] as unknown[]).push(value);}}
 data.employeeDirectory=await employeeDirectory(data.projects,stored);data.projects=data.projects.map(p=>({...p,employees:data.employeeDirectory!.employees}));
 if(projectId){const a=await db().prepare('SELECT id,action,user,detail,at FROM audit WHERE project_id = ? ORDER BY at DESC LIMIT 50').bind(projectId).all();data.audit=a.results as Data['audit'];}return normalizeFinancialData(data);
}
export async function readEmployeeDirectory():Promise<EmployeeDirectory>{
 const rows=await db().prepare('SELECT id,kind,data FROM records WHERE kind = ? OR id = ?').bind('project',EMPLOYEE_DIRECTORY_ID).all<{id:string;kind:string;data:string}>();
 return employeeDirectory(rows.results.filter(r=>r.kind==='project').map(r=>JSON.parse(r.data)),rows.results.find(r=>r.id===EMPLOYEE_DIRECTORY_ID)?JSON.parse(rows.results.find(r=>r.id===EMPLOYEE_DIRECTORY_ID)!.data):undefined);
}
type DirectoryChange={value:EmployeeDirectory;expectedToken:string};
function directoryCondition(token:string){return token.startsWith('legacy-')?{sql:'NOT EXISTS (SELECT 1 FROM records WHERE id = ?)',values:[EMPLOYEE_DIRECTORY_ID]}:{sql:"EXISTS (SELECT 1 FROM records WHERE id = ? AND json_extract(data, '$.token') = ?)",values:[EMPLOYEE_DIRECTORY_ID,token]};}
const projectGuard='EXISTS (SELECT 1 FROM project_revisions WHERE id = ? AND token = ?)';
function directoryWrite(value:EmployeeDirectory,projectId:string,token:string){return db().prepare(`INSERT INTO records (id,kind,project_id,data,updated_at) SELECT ?,?,?,?,? WHERE ${projectGuard} ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`).bind(EMPLOYEE_DIRECTORY_ID,'employee-directory','system',JSON.stringify(value),value.updatedAt,projectId,token);}
export async function createProject(project:Project,user:string,directory:EmployeeDirectory|undefined,expectedDirectoryToken:string){
 const token=crypto.randomUUID(),condition=directoryCondition(expectedDirectoryToken),now=project.updatedAt;
 const stmts=[db().prepare(`INSERT INTO project_revisions (id,version,token) SELECT ?,0,? WHERE ${condition.sql}`).bind(project.id,token,...condition.values)];
 if(directory)stmts.push(directoryWrite(directory,project.id,token));
 stmts.push(db().prepare(`INSERT INTO records (id,kind,project_id,data,updated_at) SELECT ?,?,?,?,? WHERE ${projectGuard}`).bind(project.id,'project',project.id,JSON.stringify(project),now,project.id,token),db().prepare(`INSERT INTO audit (id,project_id,action,user,detail,at) SELECT ?,?,?,?,?,? WHERE ${projectGuard}`).bind(crypto.randomUUID(),project.id,'Projekt angelegt',user,project.name,now,project.id,token));
 const result=await db().batch(stmts);if(!result[0].meta.changes)throw Error('Die DaSo-Mitarbeiterliste wurde gleichzeitig geändert. Bitte erneut speichern.');
}
export async function commit(projectId:string,action:string,user:string,puts:{kind:string;value:{id:string}}[],deletes:string[]=[],detail='',expectedVersion?:number,directory?:DirectoryChange){
  const row=await db().prepare('SELECT version FROM project_revisions WHERE id = ?').bind(projectId).first<{version:number}>();if(!row)throw new Error('Projekt nicht gefunden.');const token=crypto.randomUUID(),now=new Date().toISOString();
  const guard=projectGuard,condition=directory?directoryCondition(directory.expectedToken):{sql:'1 = 1',values:[]};
  const stmts=[db().prepare(`UPDATE project_revisions SET version = version + 1, token = ? WHERE id = ? AND version = ? AND ${condition.sql}`).bind(token,projectId,expectedVersion??row.version,...condition.values)];
  if(directory)stmts.push(directoryWrite(directory.value,projectId,token));
  for(let i=0;i<deletes.length;i+=70){const ids=deletes.slice(i,i+70);stmts.push(db().prepare(`DELETE FROM records WHERE project_id = ? AND id IN (${ids.map(()=>'?').join(',')}) AND ${guard}`).bind(projectId,...ids,projectId,token));}
  for(let i=0;i<puts.length;i+=12){const items=puts.slice(i,i+12);stmts.push(db().prepare(`INSERT INTO records (id,kind,project_id,data,updated_at) SELECT column1,column2,column3,column4,column5 FROM (VALUES ${items.map(()=>'(?,?,?,?,?)').join(',')}) WHERE ${guard} ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`).bind(...items.flatMap(p=>[p.value.id,p.kind,projectId,JSON.stringify(p.value),now]),projectId,token));}
  stmts.push(db().prepare(`INSERT INTO audit (id,project_id,action,user,detail,at) SELECT ?,?,?,?,?,? WHERE ${guard}`).bind(crypto.randomUUID(),projectId,action,user,detail,now,projectId,token));
  const result=await db().batch(stmts);if(!result[0].meta.changes)throw new Error(directory?'Die DaSo-Mitarbeiterliste oder das Projekt wurde gleichzeitig geändert. Bitte aktualisieren und erneut speichern.':'Das Projekt wurde gleichzeitig geändert. Bitte aktualisieren und erneut speichern.');
}
