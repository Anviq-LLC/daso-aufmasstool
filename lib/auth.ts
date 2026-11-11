import {env} from 'cloudflare:workers';
import {db} from '@/db/raw';
export type Identity={id:string;email:string;role:'Planer'|'Obermonteur'|'Buchhaltung';name:string};
type Jwk=JsonWebKey&{kid:string};
type Settings=Record<string,string|undefined>;
const b64=(s:string)=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const json=(s:string)=>JSON.parse(new TextDecoder().decode(b64(s)));
let cached:{url:string;keys:Jwk[];at:number}|undefined;
async function signingKeys(team:string,override?:string){
 if(override)return(JSON.parse(override) as {keys:Jwk[]}).keys;
 const url=`https://${team}/cdn-cgi/access/certs`;
 if(cached?.url===url&&Date.now()-cached.at<3600000)return cached.keys;
 const res=await fetch(url);if(!res.ok)throw Error('Anmeldung nicht prüfbar.');
 const keys=((await res.json()) as {keys:Jwk[]}).keys;cached={url,keys,at:Date.now()};return keys;
}
// The email only counts when Cloudflare Access signed it for this application; plain headers can be forged on workers.dev.
async function accessEmail(request:Request){
 const s=env as unknown as Settings,token=request.headers.get('cf-access-jwt-assertion');
 if(!token||!s.CF_ACCESS_TEAM_DOMAIN||!s.CF_ACCESS_AUD)return'';
 const [h,p,sig]=token.split('.');if(!sig)return'';
 try{
  const head=json(h),body=json(p),jwk=(await signingKeys(s.CF_ACCESS_TEAM_DOMAIN,s.CF_ACCESS_JWKS)).find(k=>k.kid===head.kid);
  if(head.alg!=='RS256'||!jwk)return'';
  const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,b64(sig),new TextEncoder().encode(h+'.'+p)))return'';
  if(!([] as string[]).concat(body.aud).includes(s.CF_ACCESS_AUD)||body.iss!=='https://'+s.CF_ACCESS_TEAM_DOMAIN||!(body.exp*1000>Date.now())||typeof body.email!=='string')return'';
  return body.email.trim().toLowerCase();
 }catch{return'';}
}
// Browsers always send Origin or Sec-Fetch-Site on cross-site writes; schedulers and tests send neither.
function crossSiteWrite(request:Request){
 if(['GET','HEAD','OPTIONS'].includes(request.method))return false;
 const site=request.headers.get('sec-fetch-site'),origin=request.headers.get('origin');
 if(site)return site!=='same-origin'&&site!=='none';
 return !!origin&&origin!==new URL(request.url).origin;
}
// Users and roles are managed in Montageplanung. A user listed there as Monteur has no access here.
async function planUser(email:string):Promise<{role:Identity['role'];name:string}|'none'|null>{
 const plan=(env as unknown as {PLAN_DB?:D1Database}).PLAN_DB;if(!plan)return null;
 const row=await plan.prepare('SELECT name,access_role FROM users WHERE email = ?').bind(email).first<{name:string;access_role:string}>();
 if(!row)return null;
 const role=({planer:'Planer',obermonteur:'Obermonteur',buchhaltung:'Buchhaltung'} as Record<string,Identity['role']>)[row.access_role];
 return role?{role,name:row.name}:'none';
}
export async function identity(request:Request):Promise<Identity>{
 if(crossSiteWrite(request))throw Error('Anfrage von einer fremden Seite abgelehnt.');
 const email=await accessEmail(request);
 if(!email){const s=env as unknown as Settings;if(s.DASO_DEV_IDENTITY==='1'&&!s.CF_ACCESS_AUD)return{id:'local',email:'',role:'Planer',name:'Lokale Prüfung'};throw Error('Bitte anmelden.');}
 const owner=(env as unknown as Settings).DASO_OWNER_EMAIL?.trim().toLowerCase();
 if(owner&&email===owner)return{id:email,email,role:'Planer',name:email};
 const planned=await planUser(email);
 if(planned==='none')throw Error('Zugriff ist nur für freigeschaltete Obermonteure und Planer möglich.');
 if(planned)return{id:email,email,role:planned.role,name:planned.name||email};
 const row=await db().prepare("SELECT data FROM records WHERE id = ? AND kind = 'access'").bind('access:'+email).first<{data:string}>();
 const access=row?JSON.parse(row.data):null;
 if(!access||!['Planer','Obermonteur'].includes(access.role)||access.disabled)throw Error('Zugriff ist nur für freigeschaltete Obermonteure und Planer möglich.');
 return{id:email,email,role:access.role,name:access.name||email};
}
export async function actor(request:Request,writeOk=false){const user=await identity(request);if(user.role==='Buchhaltung'&&request.method!=='GET'&&!writeOk)throw Error('Buchhaltung darf nur lesen und den Status setzen.');return user.email||user.name;}
export async function office(request:Request){const user=await identity(request);if(user.role==='Obermonteur')throw Error('Den Status dürfen nur Planer und Buchhaltung ändern.');return user;}
export async function planner(request:Request){const user=await identity(request);if(user.role!=='Planer')throw Error('Diese Einstellung darf nur ein Planer ändern.');return user;}
