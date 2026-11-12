'use client';
import {useEffect,useMemo,useState} from 'react';
import {Loader2} from 'lucide-react';
import {NativeSelect} from '@/components/ui/native-select';
import {Input} from '@/components/ui/input';
import {DailyRevenueOverview} from '@/components/daily-revenue-overview';
import {dateLabel,money,qty2,reportDateRange,reportTotals,today} from '@/lib/business';
import {reportCrews} from '@/lib/report-crews';
import {projectPricedReport,reportKind,reportLabel} from '@/lib/time-reports';
import type {Data,Project,Report} from '@/lib/types';

type Mode='project'|'employee'|'contractor';
const modes:{key:Mode;label:string}[]=[{key:'project',label:'Projekt'},{key:'employee',label:'Mitarbeiter'},{key:'contractor',label:'Nachunternehmer'}];

function options(data:Data,mode:Mode){
 if(mode==='project')return data.projects.map(p=>({id:p.id,label:(p.number&&p.number!=='ohne Nummer'?p.number+' · ':'')+p.name})).sort((a,b)=>a.label.localeCompare(b.label));
 if(mode==='employee')return(data.employeeDirectory?.employees||[]).filter(e=>!e.inactive).map(e=>({id:e.id,label:`${e.code} · ${e.firstName} ${e.lastName}`})).sort((a,b)=>a.label.localeCompare(b.label));
 const names=new Set<string>();for(const p of data.projects)for(const t of p.teams||[])if(t.company.trim())names.add(t.company.trim());
 for(const r of data.reports)for(const c of reportCrews(r))if(c.teamWork?.company.trim())names.add(c.teamWork.company.trim());
 return[...names].sort().map(name=>({id:name,label:name}));
}

function matches(r:Report,mode:Mode,id:string){
 if(mode==='project')return r.projectId===id;
 const crews=reportCrews(r);
 return mode==='employee'?crews.some(c=>c.employeeMembers.some(m=>m.employeeId===id)):crews.some(c=>c.teamWork?.company.trim()===id);
}

export function Evaluation(){
 const [data,setData]=useState<Data|null>(null),[error,setError]=useState('');
 const [mode,setMode]=useState<Mode>('project'),[id,setId]=useState(''),[from,setFrom]=useState(today().slice(0,8)+'01'),[to,setTo]=useState(today());
 useEffect(()=>{fetch('/api/data',{cache:'no-store'}).then(async r=>{const j=await r.json() as Data&{error?:string};if(!r.ok)throw Error(j.error);setData(j);}).catch(e=>setError(e instanceof Error?e.message:'Daten konnten nicht geladen werden.'));},[]);
 const choices=useMemo(()=>data?options(data,mode):[],[data,mode]);
 const latest=data?[...data.reports].sort((x,y)=>y.date.localeCompare(x.date))[0]?.projectId:undefined,fallback=mode==='project'&&choices.some(c=>c.id===latest)?latest:choices[0]?.id,selected=choices.some(c=>c.id===id)?id:fallback||'';
 const picked=useMemo(()=>{
  if(!data||!selected)return[];
  const projects=new Map(data.projects.map(p=>[p.id,p]));
  return data.reports.filter(r=>projects.has(r.projectId)&&r.endDate>=from&&r.date<=to&&matches(r,mode,selected)).map(r=>projectPricedReport(r,projects.get(r.projectId)!)).sort((a,b)=>b.date.localeCompare(a.date));
 },[data,mode,selected,from,to]);
 if(!data)return error?<div className="message error">{error}</div>:<div className="loading"><Loader2 className="spin"/>Daten werden geladen …</div>;
 const projects=new Map<string,Project>(data.projects.map(p=>[p.id,p])),ready=picked.filter(r=>r.state==='ready'),drafts=picked.length-ready.length;
 const perDay=new Map<string,number>();for(const r of ready)perDay.set(r.date,(perDay.get(r.date)||0)+reportTotals([r],projects.get(r.projectId)!.factor).customer);
 const days=[...perDay.entries()].sort(([a],[b])=>a.localeCompare(b)),max=Math.max(1,...days.map(([,v])=>v));
 const total=ready.reduce((sum,r)=>sum+reportTotals([r],projects.get(r.projectId)!.factor).customer,0);
 const groups=[...new Set(ready.map(r=>r.projectId))].map(pid=>({project:projects.get(pid)!,reports:ready.filter(r=>r.projectId===pid)}));
 return <div className="stack">
  <div className="filter-bar evaluation-filter">
   <label className="field"><span>Auswerten nach</span><NativeSelect value={mode} onChange={e=>{setMode(e.target.value as Mode);setId('');}}>{modes.map(m=><option key={m.key} value={m.key}>{m.label}</option>)}</NativeSelect></label>
   <label className="field"><span>{modes.find(m=>m.key===mode)!.label}</span><NativeSelect value={selected} onChange={e=>setId(e.target.value)}>{choices.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</NativeSelect></label>
   <label className="field"><span>Von</span><Input type="date" value={from} max={to} onChange={e=>e.target.value&&setFrom(e.target.value)}/></label>
   <label className="field"><span>Bis</span><Input type="date" value={to} min={from} onChange={e=>e.target.value&&setTo(e.target.value)}/></label>
  </div>
  {!choices.length?<div className="empty"><p>Keine Einträge vorhanden.</p></div>:<>
   <div className="stats">
    <div className="stat"><div><span>Aufmaße im Zeitraum</span><strong>{ready.length}</strong><small>{dateLabel(from)} – {dateLabel(to)}{drafts>0?` · ${drafts} Entwürfe nicht gezählt`:''}</small></div></div>
    <div className="stat"><div><span>Umsatz (Kunde)</span><strong>{money(total)}</strong><small>{mode==='project'?'Alle Berichte des Projekts':'Alle Berichte, an denen beteiligt'}</small></div></div>
    <div className="stat"><div><span>Arbeitstage</span><strong>{days.length}</strong><small>Tage mit Berichten</small></div></div>
   </div>
   {days.length>0&&<section className="panel"><div className="panel-heading"><h2>Umsatz pro Tag</h2></div><div className="padding evaluation-bars" role="img" aria-label="Umsatz pro Tag">{days.map(([day,value])=><div key={day} className="evaluation-bar"><span>{dateLabel(day)}</span><div><i style={{width:Math.max(2,value/max*100)+'%'}}/></div><b>{money(value)}</b></div>)}</div></section>}
   {groups.map(g=><div key={g.project.id} className="stack"><h3 className="evaluation-project">{g.project.number&&g.project.number!=='ohne Nummer'?g.project.number+' · ':''}{g.project.name}</h3>
    <DailyRevenueOverview reports={g.reports} project={g.project} initialView={mode==='employee'?'employees':'teams'}/>
    <section className="panel"><div className="panel-heading"><h2>Aufmaße zur Kontrolle</h2></div><div className="padding">{g.reports.map(r=><details key={r.id} className="evaluation-report"><summary>{reportLabel({kind:reportKind(r)})} · {reportDateRange(r)} · {r.team||'ohne Besetzung'} · {money(reportTotals([r],g.project.factor).customer)}</summary>
     <div className="table-scroll"><table><thead><tr><th>Pos.</th><th>Bezeichnung</th><th className="numeric">Menge</th><th>EH</th><th className="numeric">Betrag</th></tr></thead><tbody>{r.lines.map(l=><tr key={l.id}><td>{l.number}</td><td>{l.description}{l.remark&&<small>{l.remark}</small>}</td><td className="numeric">{qty2(l.quantity)}</td><td>{l.unit}</td><td className="numeric">{money(Math.round(l.quantity*l.price))}</td></tr>)}</tbody></table></div>
     {r.note&&<p className="muted">{r.note}</p>}</details>)}</div></section></div>)}
   {!ready.length&&<div className="empty"><p>Im gewählten Zeitraum gibt es keine Aufmaße.</p></div>}
  </>}
 </div>;
}
