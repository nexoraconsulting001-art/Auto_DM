import React, { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OfflineBanner, formatWhen, useStrings } from '@bhava/app-core';
import { Badge, Button, Card, Divider, ListRow, Screen, Section, Sheet, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { PagedState, Refusal, usePaged, useWritable } from '../compliance/kit.js';

const KEY = ['connect', 'fb-posts'];
const caption = (text, fallback) => String(text ?? '').trim().slice(0, 80) || fallback;

/** A sheet of the account's Instagram posts, to say which one a Facebook post is a copy of. */
function PickReel({ visible, onClose, onPick }) {
  const { api } = useServices();
  const { t } = useStrings();
  const media = usePaged(['connect', 'ig-media'], (query) => api.instagram.media(query), { type: 'all', limit: 24 }, { enabled: visible });
  return (
    <Sheet testID="fb-pick" visible={visible} onClose={onClose} title={t('connect.fbPosts.pickTitle')} closeLabel={t('common.close')}>
      <PagedState query={media} testID="fb-pick-list" emptyTitle={t('connect.fbPosts.noReels')}>
        {media.items.map((item) => (
          <ListRow key={item.id} testID={`fb-pick-${item.id}`} title={caption(item.caption, t(`connect.fbPosts.kind.${item.type}`))} subtitle={t(`connect.fbPosts.kind.${item.type}`)} onPress={() => onPick(item.id)} />
        ))}
      </PagedState>
    </Sheet>
  );
}

/**
 * Facebook copies of reels (PRD 6.10): a reel cross-posted to the Page gets the same DMs when people comment on
 * Facebook, once its copy is linked. Suggestions are matched by caption and time and wait for a person to confirm.
 */
export default function FacebookPostsScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const writable = useWritable();
  const [picking, setPicking] = useState(null);
  const suggestions = useQuery({ queryKey: [...KEY, 'suggestions'], queryFn: () => api.facebook.suggestions() });
  const links = usePaged([...KEY, 'links'], (query) => api.facebook.links(query), { limit: 50 });
  const posts = usePaged([...KEY, 'list'], (query) => api.facebook.posts(query), { limit: 25 });
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });
  const save = useMutation({ mutationFn: ({ postId, igMediaId }) => api.facebook.saveLink(postId, { igMediaId }), onSuccess: async () => { setPicking(null); await refresh(); } });
  const remove = useMutation({ mutationFn: (postId) => api.facebook.removeLink(postId), onSuccess: refresh });
  const confirmed = new Map(links.items.filter((link) => link.status === 'confirmed').map((link) => [link.fbPostId, link]));
  const open = (suggestions.data?.items ?? []).filter((item) => !confirmed.has(item.fbPostId));

  return (
    <Screen testID="screen-facebook-posts" title={t('connect.fbPosts.title')}>
      <OfflineBanner offline={!writable} />
      <Text variant="small">{t('connect.fbPosts.intro')}</Text>
      <Refusal error={save.error ?? remove.error} testID="fb-refusal" />
      {open.length > 0 ? (
        <Section title={t('connect.fbPosts.suggested')}>
          <Card>
            {open.map((item, i) => (
              <View key={`${item.fbPostId}-${item.igMediaId}`} testID={`fb-suggestion-${item.fbPostId}`} style={{ gap: theme.space[2] }}>
                {i > 0 ? <Divider /> : null}
                <Text variant="small">{t('connect.fbPosts.match', { post: item.fbPostId, reel: item.igMediaId, score: Math.round(item.score * 100) })}</Text>
                <View style={{ flexDirection: 'row', gap: theme.space[2] }}>
                  <Button testID={`fb-suggestion-${item.fbPostId}-confirm`} kind="secondary" label={t('connect.fbPosts.confirm')} disabled={!writable} busy={save.isPending && save.variables?.postId === item.fbPostId} onPress={() => save.mutate({ postId: item.fbPostId, igMediaId: item.igMediaId })} />
                  <Button testID={`fb-suggestion-${item.fbPostId}-other`} kind="quiet" label={t('connect.fbPosts.other')} disabled={!writable} onPress={() => setPicking(item.fbPostId)} />
                </View>
              </View>
            ))}
          </Card>
        </Section>
      ) : null}
      <Section title={t('connect.fbPosts.posts')}>
        <Card>
          <PagedState query={posts} testID="fb-posts" emptyTitle={t('connect.fbPosts.empty')} emptyBody={t('connect.fbPosts.emptyBody')}>
            {posts.items.map((post, i) => {
              const linked = post.linkedIgMediaId ?? confirmed.get(post.id)?.igMediaId ?? null;
              return (
                <View key={post.id} testID={`fb-post-${post.id}`} style={{ gap: theme.space[1], paddingVertical: theme.space[2] }}>
                  {i > 0 ? <Divider /> : null}
                  <Text variant="body" numberOfLines={3}>{caption(post.message, t('connect.fbPosts.noText'))}</Text>
                  <Text variant="meta">{formatWhen(t, post.postedAt, { locale })}</Text>
                  {linked ? <Badge testID={`fb-post-${post.id}-linked`} label={t('connect.fbPosts.linked', { reel: linked })} tone="good" /> : null}
                  <View style={{ flexDirection: 'row', gap: theme.space[2] }}>
                    {linked ? (
                      <Button testID={`fb-post-${post.id}-unlink`} kind="quiet" label={t('connect.fbPosts.unlink')} disabled={!writable} busy={remove.isPending && remove.variables === post.id} onPress={() => remove.mutate(post.id)} />
                    ) : (
                      <Button testID={`fb-post-${post.id}-link`} kind="secondary" label={t('connect.fbPosts.link')} disabled={!writable} onPress={() => setPicking(post.id)} />
                    )}
                  </View>
                </View>
              );
            })}
          </PagedState>
        </Card>
      </Section>
      <PickReel visible={Boolean(picking)} onClose={() => setPicking(null)} onPick={(igMediaId) => save.mutate({ postId: picking, igMediaId })} />
    </Screen>
  );
}
