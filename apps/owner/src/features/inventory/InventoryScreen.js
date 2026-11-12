import React, { useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { MANAGERS } from '@bhava/app-core/access';
import { Badge, Button, Card, Choices, Field, ListRow, Screen, Section, Sheet, Text } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { ADJUST_WAYS, stockBody, stockForm } from '../orders/kit/forms.js';
import { parseWhole } from '../orders/kit/rules.js';
import { ActionMessages, NumberField, Offline, PagedList, useAction, useAllowed, useForm, useProblem, usePaged, useWritable } from '../orders/kit/ui.js';

const STOCK = ['inventory'];
const SHOW = ['all', 'low', 'out'];

/**
 * Stock (PRD 9.12): every product and variant with what is on hand, held for unpaid orders and free to sell. A line is
 * set, moved by an amount, or no longer counted, with its own low-stock level. The database refuses a hold beyond what
 * is on hand, so the numbers shown are always the server's.
 */
export default function InventoryScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const navigation = useNavigation();
  const [show, setShow] = useState('all');
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [line, setLine] = useState(null);
  const query = usePaged(['inventory', 'list', { show, search }], (page) => api.inventory.list({ show, ...(search ? { search } : {}), ...page }));
  return (
    <Screen testID="screen-inventory" title={t('inventory.title')}>
      <Offline />
      <Field testID="inventory-search" label={t('inventory.search')} value={typed} onChangeText={setTyped} onSubmitEditing={() => setSearch(typed.trim().slice(0, 80))} returnKeyType="search" autoCorrect={false} />
      <Choices testID="inventory-show" label={t('inventory.show')} value={show} onChange={setShow} options={SHOW.map((value) => ({ value, label: t(`inventory.show.${value}`) }))} />
      <PagedList
        testID="inventory-list"
        query={query}
        rowKey={(row) => `${row.productId}-${row.variantId ?? 0}`}
        emptyTitle={t(show === 'all' && !search ? 'inventory.empty' : 'inventory.emptyFiltered')}
        renderRow={(row) => (
          <ListRow
            testID={`stock-${row.productId}-${row.variantId ?? 0}`}
            title={[row.name, row.option].filter(Boolean).join(' · ')}
            subtitle={row.stock === null ? t('inventory.uncounted') : t('inventory.numbers', { stock: row.stock, reserved: row.reserved, available: row.available })}
            end={row.stock !== null && row.available === 0 ? <Badge tone="bad" label={t('inventory.out')} /> : row.low ? <Badge tone="warn" label={t('inventory.low')} /> : null}
            onPress={() => setLine(row)}
          />
        )}
      />
      <Button testID="inventory-movements" kind="secondary" label={t('inventory.movements')} onPress={() => navigation.navigate('inventory.movements')} />
      <DefaultLevel />
      {line ? <AdjustSheet key={`${line.productId}-${line.variantId ?? 0}`} line={line} onClose={() => setLine(null)} /> : null}
    </Screen>
  );
}

function AdjustSheet({ line, onClose }) {
  const { api } = useServices();
  const { t } = useStrings();
  const navigation = useNavigation();
  const writable = useWritable();
  const form = useForm(stockForm(line));
  const problem = useProblem(form.problems);
  const action = useAction([STOCK]);
  const { values, set } = form;

  async function save() {
    const built = stockBody(values, line);
    form.setProblems(built.problems ?? {});
    if (built.problems) return;
    const done = await action.run('adjust', () => api.inventory.adjust(built.body), { done: 'inventory.saved' });
    if (done) onClose();
  }

  return (
    <Sheet
      testID="inventory-adjust"
      visible
      onClose={onClose}
      closeLabel={t('common.cancel')}
      dismissable={!action.busy}
      title={[line.name, line.option].filter(Boolean).join(' · ')}
      footer={<Button testID="inventory-adjust-save" label={t('common.save')} disabled={!writable} busy={action.busy === 'adjust'} onPress={() => { save(); }} />}
    >
      <Text variant="small">{line.stock === null ? t('inventory.uncounted') : t('inventory.numbers', { stock: line.stock, reserved: line.reserved, available: line.available })}</Text>
      {line.sku ? <Text variant="meta">{t('inventory.sku', { sku: line.sku })}</Text> : null}
      <Choices testID="inventory-way" label={t('inventory.way')} value={values.way} onChange={set('way')} options={ADJUST_WAYS.map((value) => ({ value, label: t(`inventory.way.${value}`) }))} />
      {values.way !== 'unlimited' ? <NumberField testID="inventory-amount" signed={values.way === 'move'} label={t(values.way === 'set' ? 'inventory.amount.set' : 'inventory.amount.move')} value={values.amount} onChangeText={set('amount')} error={problem('amount', { stock: line.stock ?? 0 })} /> : null}
      <NumberField testID="inventory-low-at" label={t('inventory.lowAt')} hint={t('inventory.lowAtHint')} value={values.lowAt} onChangeText={set('lowAt')} error={problem('lowAt')} />
      <Field testID="inventory-note" label={t('inventory.note')} value={values.note} onChangeText={set('note')} maxLength={200} />
      <ActionMessages action={action} testID="inventory-adjust-action" />
      <Button testID="inventory-history" kind="quiet" label={t('inventory.history')} onPress={() => { onClose(); navigation.navigate('inventory.movements', { productId: line.productId }); }} />
    </Sheet>
  );
}

/** The business's usual low-stock level. Everyone here sees it; owners and managers change it. */
function DefaultLevel() {
  const { api } = useServices();
  const { t } = useStrings();
  const allowed = useAllowed();
  const writable = useWritable();
  const settings = useQuery({ queryKey: ['inventory', 'settings'], queryFn: () => api.inventorySettings.get() });
  const action = useAction([['inventory']]);
  const [typed, setTyped] = useState(null);
  const [problem, setProblem] = useState('');
  if (!settings.data) return null;
  const value = typed ?? String(settings.data.lowStockThreshold);
  const canChange = allowed(MANAGERS);

  async function save() {
    const n = parseWhole(value, { min: 0, max: 1_000_000 });
    if (n === null) return setProblem(t('inventory.problem.low'));
    setProblem('');
    const done = await action.run('level', () => api.inventorySettings.update({ lowStockThreshold: n }), { done: 'inventory.levelSaved' });
    if (done) setTyped(null);
    return done;
  }

  return (
    <Section title={t('inventory.level')} testID="inventory-level">
      <Card>
        <Text variant="small">{t('inventory.levelIntro')}</Text>
        <NumberField testID="inventory-level-value" label={t('inventory.lowAt')} value={value} onChangeText={canChange ? setTyped : () => {}} error={problem || undefined} />
        <ActionMessages action={action} testID="inventory-level-action" />
        {canChange ? <Button testID="inventory-level-save" kind="secondary" label={t('common.save')} disabled={!writable} busy={action.busy === 'level'} onPress={() => { save(); }} /> : <Text variant="meta">{t('inventory.levelManagers')}</Text>}
      </Card>
    </Section>
  );
}
