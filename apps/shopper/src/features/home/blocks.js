import React, { useEffect, useState } from 'react';
import { Card, Text } from '@bhava/ui';

/** A sale's clock, counted down to the time the server sent. It only reads that time and goes away when it passes. */
export function Countdown({ text, endsAt, testID }) {
  const end = Date.parse(endsAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!Number.isFinite(end) || end <= now) return null;
  const left = Math.floor((end - now) / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const days = Math.floor(left / 86400);
  const clock = `${days ? `${days}d ` : ''}${pad(Math.floor((left % 86400) / 3600))}:${pad(Math.floor((left % 3600) / 60))}:${pad(left % 60)}`;
  return (
    <Card testID={testID}>
      {text ? <Text variant="title">{text}</Text> : null}
      <Text variant="page" testID={testID ? `${testID}-clock` : undefined}>{clock}</Text>
    </Card>
  );
}
