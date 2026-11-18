import type {EmployeeMember,Project,Report,ReportCrew} from './types';
import {teamWorkers} from './team-members';
import {employeeTeamCode} from './employees';
import {crewPatch,equalCrewShares} from './report-crews';
export type PlanDay={employees:string[];contractors:{name:string;count:number}[]};
const key=(value:string)=>value.trim().normalize('NFKC').toLowerCase().replace(/\s+/g,' ');
// The crew Montageplanung has planned for this project and day, as a patch for any report type.
export function planCrewPatch(project:Pick<Project,'employees'|'teams'>,day:PlanDay):Partial<Report>|null{
 const known=new Map((project.employees||[]).filter(e=>!e.inactive).map(e=>[key(e.firstName+' '+e.lastName),e])),members:EmployeeMember[]=[];
 for(const name of day.employees){const e=known.get(key(name));if(e&&!members.some(m=>m.employeeId===e.id))members.push({employeeId:e.id,name:`${e.firstName} ${e.lastName}`,code:e.code,trial:false});}
 members.sort((a,b)=>a.code.localeCompare(b.code,'de',{numeric:true}));
 const crews:ReportCrew[]=[];
 if(members.length)crews.push({id:'plan-own',team:employeeTeamCode(members),employeeMembers:members,teamWork:null,share:0});
 for(const c of day.contractors){
  const team=(project.teams||[]).find(t=>key(t.company)===key(c.name)),workers=team?teamWorkers(team).filter(w=>w.name):[];
  if(!team||!workers.length||crews.some(x=>x.teamWork?.code===team.code))continue;
  crews.push({id:'plan-'+team.code,team:team.code,employeeMembers:[],teamWork:{code:team.code,company:team.company,workers},share:0});
 }
 if(!crews.length)return null;
 return crews.length===1?{team:crews[0].team,teamWork:crews[0].teamWork,employeeMembers:crews[0].employeeMembers,crews:undefined}:crewPatch(equalCrewShares(crews));
}
