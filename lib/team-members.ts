import type {ProjectTeam,TeamMember,TeamWork} from './types';
export function teamMembers(team:Pick<ProjectTeam,'members'|'employees'|'hourlyRate'>):TeamMember[]{return team.members??(team.employees||[]).filter(Boolean).map(name=>({name,role:'fitter' as const,hourlyRate:team.hourlyRate??null}));}
export const workerRate=(work:Pick<TeamWork,'hourlyRate'>,worker:TeamWork['workers'][number])=>worker.hourlyRate!==undefined?worker.hourlyRate:work.hourlyRate??null;
export const teamWorkers=(team:ProjectTeam):TeamWork['workers']=>teamMembers(team).map(m=>({name:m.name,role:m.role,hourlyRate:m.hourlyRate,hours:null}));
