import assert from 'node:assert/strict';
import {as,accessBindings} from './access.mjs';

export async function checkSharedEmployees({Miniflare,script,sql,headers,project,ui}){
 const mf=new Miniflare({modules:true,script,bindings:{DASO_OWNER_EMAIL:'test-user@example.invalid',...accessBindings},d1Databases:['DB'],r2Buckets:['BUCKET'],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat']});
 try{
  const db=await mf.getD1Database('DB');for(const statement of sql.split('--> statement-breakpoint'))await db.prepare(statement.trim()).run();
  const a={id:'old-a',firstName:'Alexander',lastName:'Pankratz',code:'AP'},b={id:'old-b',firstName:'Andreas',lastName:'Peters',code:'AP'},alias={...a,id:'other-a'};
  const first={...project,id:'legacy-one',number:'LEGACY-1',updatedAt:'2026-09-01T00:00:00Z',employees:[a,b],teams:[]},second={...project,id:'legacy-two',number:'LEGACY-2',updatedAt:'2026-10-01T00:00:00Z',employees:[alias],teams:[]};
  for(const p of [first,second])await db.batch([db.prepare('INSERT INTO project_revisions VALUES (?,0,?)').bind(p.id,'seed-'+p.id),db.prepare('INSERT INTO records VALUES (?,?,?,?,?)').bind(p.id,'project',p.id,JSON.stringify(p),p.updatedAt)]);
  const oldReport={id:'old-report',projectId:first.id,date:'2026-10-08',endDate:'2026-10-08',team:'AP',employeeMembers:[{employeeId:a.id,name:'Alexander Pankratz',code:'AP',trial:false}],author:'Alexander Pankratz',area:'',note:'Altbestand',lines:[{id:'old-line',positionId:'old-position',number:'1.1',description:'Spiralrohr',unit:'m',price:1250,employeePrice:1125,employeeFactor:.9,quantity:3.2,remark:''}],state:'draft',review:'pending',reviewNote:'',createdAt:'2026-10-08T07:00:00Z',updatedAt:'2026-10-08T07:00:00Z',sentAt:null,deadline:null};
  const originalJSON=JSON.stringify(oldReport);await db.prepare('INSERT INTO records VALUES (?,?,?,?,?)').bind(oldReport.id,'report',first.id,originalJSON,oldReport.updatedAt).run();
  const get=async id=>{const r=await mf.dispatchFetch('http://test/api/data?project='+id,{headers});assert.equal(r.status,200);return r.json();};
  const post=async(action,projectId,payload={},expected=200)=>{const r=await mf.dispatchFetch('http://test/api/data',{method:'POST',headers,body:JSON.stringify({action,projectId,...payload})});const body=await r.json();assert.equal(r.status,expected,JSON.stringify(body));return body;};
  const own=(data,id)=>data.projects.find(p=>p.id===id);
  const saveRoster=async(id,employees)=>{const data=await get(id);return post('saveProjectEmployees',id,{employees,updatedAt:own(data,id).updatedAt,employeeDirectoryToken:data.employeeDirectory.token});};
  let data=await get(first.id);const bootstrap=data.employeeDirectory.employees;
  assert.equal(bootstrap.length,2,'existing entries from all projects are included once');assert.equal(new Set(bootstrap.map(e=>e.code)).size,2,'legacy abbreviation collisions are resolved');assert(bootstrap.find(e=>e.id===alias.id).legacyIds.includes(a.id));assert.deepEqual(own(data,first.id).employees,own(data,second.id).employees);
  assert.deepEqual(data.reports[0].employeeMembers,oldReport.employeeMembers,'bootstrap leaves historical members intact');
  const crew=ui.renderCrew(own(data,first.id),oldReport);assert.equal((crew.match(/class="[^"]*\bcrew-button\b/g)||[]).length,3,'a historical alias does not create a second button for the same employee');assert(crew.includes('Mitarbeiter dieses Projekts'));
  const inherited=(await post('saveProject','',{project:{...project,name:'Neue Baustelle',number:'NEW-1',employees:[],teams:[]}})).id;
  data=await get(inherited);assert.deepEqual(own(data,inherited).employees,bootstrap,'new project inherits the whole roster without client-supplied employees');
  const added={id:'new-anna',firstName:'Anna',lastName:'Peters',code:'FAKE'};
  await saveRoster(first.id,[...bootstrap,added]);data=await get(second.id);
  for(const id of [first.id,second.id,inherited])assert(own(data,id).employees.some(e=>e.id===added.id),'new entries appear in each project');
  assert.equal(new Set(data.employeeDirectory.employees.map(e=>e.code)).size,3);const staleToken=data.employeeDirectory.token;
  await saveRoster(first.id,data.employeeDirectory.employees.map(e=>e.id===alias.id?{...e,lastName:'Neumann'}:e));
  data=await get(second.id);assert(own(data,second.id).employees.some(e=>e.id===alias.id&&e.lastName==='Neumann'&&e.code==='AN'));
  assert.equal((await db.prepare('SELECT data FROM records WHERE id = ?').bind(oldReport.id).first()).data,originalJSON,'global edits do not rewrite stored reports');
  const oldView=await get(first.id);await post('saveReport',first.id,{report:oldView.reports[0]});
  const edited=(await get(first.id)).reports[0];assert.deepEqual(edited.employeeMembers,oldReport.employeeMembers,'old employee IDs, names and codes survive later editing');assert.deepEqual(edited.lines,oldReport.lines);
  await post('saveReport',first.id,{report:{...edited,employeeMembers:[...edited.employeeMembers,{employeeId:alias.id,trial:false}]}},400);
  await post('saveProjectEmployees',second.id,{employees:data.employeeDirectory.employees,updatedAt:own(data,second.id).updatedAt},400);
  await post('saveProjectEmployees',second.id,{employees:bootstrap,updatedAt:own(data,second.id).updatedAt,employeeDirectoryToken:staleToken},400);
  await post('saveProject',second.id,{project:{...own(data,second.id),name:'Stammdaten geändert',employees:bootstrap}});
  assert((await get(first.id)).employeeDirectory.employees.some(e=>e.id===alias.id&&e.lastName==='Neumann'),'stale project metadata cannot replace the shared roster');
  data=await get(second.id);await saveRoster(second.id,data.employeeDirectory.employees.filter(e=>e.id!==added.id));
  const subsequent=(await post('saveProject','',{project:{...project,name:'Weitere Baustelle',number:'NEW-2',employees:[],teams:[]}})).id;
  data=await get(subsequent);assert.equal(data.employeeDirectory.employees.length,2);assert(!own(data,subsequent).employees.some(e=>e.id===added.id),'removed employees are not revived from older project records');
  const nu={code:'T1',company:'Projektfirma',members:[{name:'Monteur 1',role:'fitter',hourlyRate:3200},{name:'Monteur 2',role:'foreman',hourlyRate:4100}]},beforeTeamToken=data.employeeDirectory.token;
  data=await get(first.id);await post('saveProjectTeams',first.id,{teams:[nu],updatedAt:own(data,first.id).updatedAt});data=await get(second.id);assert.equal(own(data,first.id).teams[0].company,nu.company);assert.deepEqual(own(data,first.id).teams[0].members,nu.members);assert.equal(own(data,second.id).teams.length,0);assert.equal(data.employeeDirectory.token,beforeTeamToken,'contractor-only edits leave the shared roster untouched');
  // Two people save different project forms based on the same shared roster.
  const attempts=[first.id,second.id].map((id,i)=>({id,employee:{id:'race-'+i,firstName:i?'Bernd':'Boris',lastName:'Sommer',code:''},teams:[{...nu,company:'Attempt '+i}]}));
  const oldTeams=new Map(data.projects.map(p=>[p.id,p.teams]));
  const results=await Promise.all(attempts.map(async attempt=>{const r=await mf.dispatchFetch('http://test/api/data',{method:'POST',headers,body:JSON.stringify({action:'saveProjectPeople',projectId:attempt.id,employees:[...data.employeeDirectory.employees,attempt.employee],teams:attempt.teams,updatedAt:own(data,attempt.id).updatedAt,employeeDirectoryToken:data.employeeDirectory.token})});return{status:r.status,body:await r.json()};}));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,400],'concurrent roster writes cannot silently overwrite each other');
  const winner=results.findIndex(r=>r.status===200),loser=1-winner;data=await get(first.id);
  assert(data.employeeDirectory.employees.some(e=>e.id===attempts[winner].employee.id));assert(!data.employeeDirectory.employees.some(e=>e.id===attempts[loser].employee.id));assert.deepEqual(own(data,attempts[loser].id).teams,oldTeams.get(attempts[loser].id),'a rejected shared update does not partly save project teams');
  assert(data.projects.every(p=>JSON.stringify(p.employees)===JSON.stringify(data.employeeDirectory.employees)));assert.deepEqual(data.reports[0].employeeMembers,oldReport.employeeMembers);
  await saveRoster(inherited,data.employeeDirectory.employees.filter(e=>e.id!==alias.id));data=await get(first.id);assert(!own(data,first.id).employees.some(e=>e.id===alias.id));
  await post('saveReport',first.id,{report:data.reports[0]});const retained=(await get(first.id)).reports[0];assert.deepEqual(retained.employeeMembers,oldReport.employeeMembers,'removing a directory entry does not invalidate a historical draft');assert.deepEqual(retained.lines,oldReport.lines);
  await post('saveReport',first.id,{report:{...retained,id:'',updatedAt:''}},400);
  console.log('PASS: legacy roster union/aliases, unique initials, automatic inheritance, global additions/renames/removal, immutable report members, project-specific contractors and atomic concurrent saves.');
 }finally{await mf.dispose();}
}
