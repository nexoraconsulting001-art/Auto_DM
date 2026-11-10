import { Badge } from '../../design/index.jsx';
import { describeResult } from './results.js';

export function ResultBadge({ result }) {
  const { label, tone } = describeResult(result);
  return <Badge tone={tone}>{label}</Badge>;
}
