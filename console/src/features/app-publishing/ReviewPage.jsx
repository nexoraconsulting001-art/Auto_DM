import { useQuery } from '@tanstack/react-query';
import { Badge, PageHeader, Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { PLATFORMS, PLATFORM_LABELS, SUBMISSION_STATE, adviceFor } from './rules.js';
import { AreaTabs, Note, Status, StoreScreen, UpgradePrompt, useAppConfig } from './ui.jsx';

function Rejections({ rejections }) {
  return (
    <div role="list" aria-label="Rejections">
      {rejections.map((rejection) => (
        <div key={`${rejection.guideline}-${rejection.rejectedAt}`} className="myapp-row" role="listitem">
          <div className="myapp-row-head">
            <strong>{rejection.playbook.title}</strong>
            <Badge tone="bad">Guideline {rejection.guideline || 'not named'}</Badge>
          </div>
          <span className="myapp-meta">{formatDateTime(rejection.rejectedAt)}</span>
          {rejection.message && <p className="myapp-quote">{rejection.message}</p>}
          <p><strong>What happens next:</strong> {adviceFor(rejection.playbook.code)}</p>
        </div>
      ))}
    </div>
  );
}

function Submission({ item }) {
  const [label] = SUBMISSION_STATE[item.state] ?? [item.state];
  return (
    <Panel title={PLATFORM_LABELS[item.platform]} action={<Status table={SUBMISSION_STATE} value={item.state} />} aria-label={`${PLATFORM_LABELS[item.platform]}: ${label}`}>
      <p className="myapp-meta">
        {item.appVersion ? `Version ${item.appVersion}${item.buildNumber ? ` (${item.buildNumber})` : ''}` : 'No version sent yet'}
        {item.liveVersion ? `. Live version ${item.liveVersion}` : ''}
      </p>
      {item.submittedAt && <p className="myapp-meta">Sent {formatDateTime(item.submittedAt)}{item.decidedAt ? `, decided ${formatDateTime(item.decidedAt)}` : ', waiting for the store'}</p>}
      {item.state === 'in_review' && <Note>The store is reviewing your app. This usually takes a day or two, and we show the result here.</Note>}
      {item.reviewTask && <Note tone="warn">We are fixing the store’s point about guideline {item.reviewTask.guideline || 'not named'}.</Note>}
      {item.state === 'live' && item.storeUrl && /^https:\/\//.test(item.storeUrl) && <p><a href={item.storeUrl} target="_blank" rel="noopener noreferrer">Open your app in the store</a></p>}
      {item.rejections.length > 0 && <Rejections rejections={item.rejections} />}
      {item.presubmit && (
        <details>
          <summary>Checks before sending: {item.presubmit.passed ? 'all passed' : 'some failed'}</summary>
          <ul className="myapp-problems">
            {item.presubmit.checks.map((check) => (
              <li key={check.code}>
                {check.passed ? 'Passed' : 'Failed'}: {check.code.replace(/_/g, ' ')}{check.guideline ? ` (guideline ${check.guideline})` : ''}{check.detail ? `. ${check.detail}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}

export default function ReviewPage() {
  const config = useAppConfig();
  const submissions = useQuery({ queryKey: ['app-publishing', 'submissions'], queryFn: () => api.appPublishing.submissions() });
  return (
    <>
      <PageHeader title="Review status" />
      <AreaTabs current="/my-app/review" />
      <StoreScreen query={submissions} label="Loading your review status" errorTitle="We couldn’t load your review status">
        {(data) => (
          <div className="myapp-stack">
            {PLATFORMS.map((platform) => {
              if (config.data && !config.data[platform].entitled) return <UpgradePrompt key={platform} platform={platform} what="store review" />;
              const item = data.items.find((i) => i.platform === platform);
              return item ? <Submission key={platform} item={item} /> : null;
            })}
            {!data.items.length && <p className="field-hint">Nothing has been sent to a store yet. Build your app first, and it appears here.</p>}
          </div>
        )}
      </StoreScreen>
    </>
  );
}
