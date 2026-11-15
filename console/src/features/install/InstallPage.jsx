import { useEffect, useState } from 'react';
import { Banner, Button, PageHeader, Panel } from '../../design/index.jsx';
import { ANDROID_STEPS, IOS_STEPS, isStandalone } from './rules.js';
import { canPromptInstall, onInstallChange, promptInstall } from './live.js';

/** Settings > Install the app: how to put the console on a phone's home screen. Bhava's own words; nothing of a business is here. */
export default function InstallPage() {
  const [, refresh] = useState(0);
  const [outcome, setOutcome] = useState('');
  useEffect(() => onInstallChange(() => refresh((n) => n + 1)), []);
  const installed = isStandalone();
  return (
    <div className="stack">
      <PageHeader eyebrow="Settings" title="Install the app" />
      {installed && <Banner tone="good">Bhava is installed on this phone. You are using it now.</Banner>}
      {outcome === 'accepted' && <Banner tone="good">Bhava is being added to your home screen.</Banner>}
      <Panel title="On an iPhone">
        <ol className="install-steps">{IOS_STEPS.map((step) => <li key={step}>{step}</li>)}</ol>
      </Panel>
      <Panel title="On an Android phone">
        <div className="stack">
          <ol className="install-steps">{ANDROID_STEPS.map((step) => <li key={step}>{step}</li>)}</ol>
          {canPromptInstall() && !installed && <Button onClick={async () => setOutcome(await promptInstall())}>Install</Button>}
        </div>
      </Panel>
      <p className="install-note">The installed app shows your business only while you are online, and it is cleared when you sign out or switch business.</p>
    </div>
  );
}
