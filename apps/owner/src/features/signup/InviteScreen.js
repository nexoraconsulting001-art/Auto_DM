import React, { useState } from 'react';
import { useRoute } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core';
import { Banner, Button, Card, Screen, Text } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { ActionMessages, Offline, useAction } from '../orders/kit/ui.js';

/**
 * The owner's invitation to a business our team set up for them (PRD 5.6: F-26 to F-31). The link carries a one-time token;
 * opening it, once signed in, makes this person the business's owner. An old, used or withdrawn link is refused with the
 * server's own words, and nothing is kept of the token.
 */
export default function InviteScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const route = useRoute();
  const token = String(route?.params?.token ?? '');
  const action = useAction([['setup']]);
  const [opened, setOpened] = useState(null);
  const valid = /^[\w-]{20,200}$/.test(token);
  return (
    <Screen testID="screen-invite" title={t('signup.invite.title')}>
      <Offline />
      <ActionMessages action={action} testID="invite-action" />
      {!valid ? <Banner tone="bad" testID="invite-invalid">{t('signup.invite.invalid')}</Banner> : null}
      {opened ? (
        <Card testID="invite-done">
          <Text variant="title">{t('signup.invite.done', { name: opened.businessName })}</Text>
          <Text variant="small">{t('signup.invite.doneBody')}</Text>
        </Card>
      ) : (
        <Card testID="invite-card">
          <Text variant="body">{t('signup.invite.body')}</Text>
          <Button testID="invite-accept" label={t('signup.invite.accept')} disabled={!valid || !action.writable} busy={action.busy === 'invite'} onPress={async () => {
            const result = await action.run('invite', () => api.setup.openInvite({ token }));
            if (result && typeof result === 'object') setOpened(result);
          }} />
        </Card>
      )}
    </Screen>
  );
}
