import { EmptyState, PageHeader } from '../design/index.jsx';

/** What a feature's page shows until its track builds it. Replace the element in the feature's routes; keep the registration. */
export function NotBuilt({ title, children }) {
  return (
    <>
      <PageHeader eyebrow="Bhava Console" title={title} />
      <EmptyState title="This screen isn’t built yet">{children}</EmptyState>
    </>
  );
}
