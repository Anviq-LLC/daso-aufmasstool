import type {Report,Stage} from './types';

export const STAGES:{key:Stage;label:string;color:string}[]=[
 {key:'created',label:'Erstellt und abgeschlossen',color:'#fff3b0'},
 {key:'approved',label:'Vom Kunden geprüft und freigegeben',color:'#c9efd3'},
 {key:'approved_changes',label:'Freigegeben mit Änderungen',color:'#7fc596'},
 {key:'paid',label:'Zahlung eingegangen',color:'#c7ddfb'},
];

export function reportStage(r:Report):Stage{return r.stage||(r.review==='approved'?'approved':'created');}
