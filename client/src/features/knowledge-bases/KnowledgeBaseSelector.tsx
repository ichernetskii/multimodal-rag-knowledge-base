import { observer } from 'mobx-react-lite';
import { useApplication } from '../../shared/lib/application-context';
export const KnowledgeBaseSelector = observer(function KnowledgeBaseSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const app = useApplication();
  return (
    <label className="scope-selector">
      База знаний
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Все доступные</option>
        {app.bases.items.map((base) => (
          <option key={base.id} value={base.id}>
            {base.name}
          </option>
        ))}
      </select>
    </label>
  );
});
