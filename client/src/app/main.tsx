import { createRoot } from 'react-dom/client';
import '../shared/styles/global.css';
import { App } from './App';
import { ApplicationStore } from './application-store';

const root = document.getElementById('app');
if (!root) throw new Error('Missing application root');
const application = new ApplicationStore();
createRoot(root).render(<App application={application} />);
