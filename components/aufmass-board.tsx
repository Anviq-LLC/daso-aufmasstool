'use client';
import {useEffect,useState} from 'react';
import {Loader2} from 'lucide-react';
import {NativeSelect} from '@/components/ui/native-select';
import {STAGES,reportStage} from '@/lib/stage';
import {dateLabel,reportTotals,money} from '@/lib/business';
import {reportLabel} from '@/lib/time-reports';
import type {Data,Stage} from '@/lib/types';

export function AufmassBoard({onChanged}:{onChanged:()=>void}){
 const [data,setData]=useState<Data|null>(null),[error,setError]=useState(''),[drag,setDrag]=useState('');
 async function load(){try{const r=await fetch('/api/data',{cache:'no-store'}),j=await r.json() as Data&{error:string};if(!r.ok)throw Error(j.error);setData(j);}catch(e){setError(e instanceof Error?e.message:'Daten konnten nicht geladen werden.');}}
 useEffect(()=>{load();},[]);
 async function move(id:string,projectId:string,stage:Stage){
  setError('');
  const r=await fetch('/api/data',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'setStage',projectId,id,stage})});
  if(!r.ok){setError(((await r.json().catch(()=>({}))) as {error?:string}).error||'Status konnte nicht gespeichert werden.');return;}
  await load();onChanged();
 }
 if(!data)return error?<div className="message error">{error}</div>:<div className="loading"><Loader2 className="spin"/>Daten werden geladen …</div>;
 const projects=new Map(data.projects.map(p=>[p.id,p])),reports=data.reports.filter(r=>r.state==='ready'&&projects.has(r.projectId)).sort((a,b)=>b.date.localeCompare(a.date));
 return <>
  {error&&<div className="message error" role="alert">{error}</div>}
  <div className="stage-board">{STAGES.map(s=>{const list=reports.filter(r=>reportStage(r)===s.key);return <section key={s.key} className="stage-col" style={{background:s.color}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const r=reports.find(x=>x.id===drag);setDrag('');if(r&&reportStage(r)!==s.key)move(r.id,r.projectId,s.key);}}>
   <h3>{s.label} <span>{list.length}</span></h3>
   {list.map(r=>{const p=projects.get(r.projectId)!;return <article key={r.id} className="stage-card" draggable onDragStart={()=>setDrag(r.id)}>
    <strong>{p.number&&p.number!=='ohne Nummer'?p.number+' · ':''}{p.name}</strong>
    <small>{reportLabel(r)} · {dateLabel(r.date)}{r.team?' · '+r.team:''}</small>
    <small>{money(reportTotals([r],p.factor).customer)}</small>
    <NativeSelect aria-label="Status" value={reportStage(r)} onChange={e=>move(r.id,r.projectId,e.target.value as Stage)}>{STAGES.map(o=><option key={o.key} value={o.key}>{o.label}</option>)}</NativeSelect>
   </article>;})}
  </section>;})}</div>
 </>;
}
