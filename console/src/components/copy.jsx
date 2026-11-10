import { useEffect, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '../design/index.jsx';

/** Copies `text`. Where the browser won't allow it, says so, and the text stays on screen to copy by hand. */
export function CopyButton({ text, label = 'Copy', variant = 'soft' }) {
  const [state, setState] = useState('idle');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1800);
  }

  return (
    <Button variant={variant} onClick={copy}>
      <Copy size={16} strokeWidth={1.8} aria-hidden="true" />
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Press and hold to copy' : label}</span>
    </Button>
  );
}
