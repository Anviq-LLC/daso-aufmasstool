import '../portal.css';
import logoSrc from '@/assets/logo.png?inline';

export const metadata={title:'Link nicht mehr aktiv · DaSo Aufmaß'};

export default function InactiveLink(){
 return <main className="portal">
  <header><img src={logoSrc} alt="DaSo Lüftungsbau" width={110}/></header>
  <section className="portal-card">
   <h1>Dieser Link ist nicht mehr aktiv</h1>
   <p>Die Online-Rückmeldung zu Aufmaßen gibt es nicht mehr. Bei Fragen zu einem Aufmaß wenden Sie sich bitte direkt an DaSo Lüftungsbau.</p>
  </section>
 </main>;
}
