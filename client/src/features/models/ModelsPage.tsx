import { observer } from 'mobx-react-lite';
import { useApplication } from '../../shared/lib/application-context';
import { PageHeader } from '../../shared/ui/Feedback';
import { Assistant } from '../settings/SettingsPage';
import { Indexes } from '../admin/CompanyPages';
import { Connections } from '../saas/ConnectionsPage';
export const Models = observer(function Models() {
  const app = useApplication();
  return app.navigation.tab === 'connections' ? (
    <Connections />
  ) : (
    <>
      <PageHeader
        title={'Model assignments'}
        description={
          'Choose which models answer questions, search materials, and transcribe recordings for this company.'
        }
      />
      <Assistant />
      <Indexes />
    </>
  );
});
