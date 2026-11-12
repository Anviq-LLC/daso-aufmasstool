import * as company from '../app/api/company/route';
import * as data from '../app/api/data/route';
import * as files from '../app/api/files/route';
import * as plan from '../app/api/plan/route';
import * as me from '../app/api/me/route';
import * as contractors from '../app/api/contractors/route';
const routes:Record<string,object>={'/api/company':company,'/api/files':files,'/api/plan':plan,'/api/me':me,'/api/contractors':contractors};
export default {fetch(request:Request){const handler=((routes[new URL(request.url).pathname]||data) as Record<string,(r:Request)=>Response|Promise<Response>>)[request.method];return handler?handler(request):new Response('Not found',{status:404});}};
