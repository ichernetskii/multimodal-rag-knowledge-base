import { expect, it, vi } from 'vitest';
import { UnsavedChanges } from '../src/app/navigation/unsaved-changes';
it('keeps unsaved company settings when navigation is cancelled', () => {
  const confirm = vi.fn(() => false),
    changes = new UnsavedChanges(confirm);
  changes.mark('settings', 'page');
  expect(changes.confirmDiscard()).toBe(false);
  expect(changes.dirty).toBe(true);
  expect(confirm).toHaveBeenCalledOnce();
});
it('closing a dialog does not discard an underlying settings form', () => {
  const changes = new UnsavedChanges(() => true);
  changes.mark('settings', 'page');
  changes.mark('correction', 'dialog');
  expect(changes.confirmDiscard('dialog')).toBe(true);
  expect(changes.dirty).toBe(true);
  changes.clear('settings');
  expect(changes.dirty).toBe(false);
});
it('does not prompt after saving, unmounting or replacing an authorized session', () => {
  const confirm = vi.fn(() => true),
    changes = new UnsavedChanges(confirm);
  changes.mark('settings', 'page');
  changes.clear('settings');
  expect(changes.confirmDiscard()).toBe(true);
  expect(confirm).not.toHaveBeenCalled();
  changes.mark('a', 'page');
  changes.mark('b', 'dialog');
  changes.clear();
  expect(changes.dirty).toBe(false);
});
