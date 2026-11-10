import { Badge } from '../../design/index.jsx';
import { orderStatus } from './status.js';

export function OrderStatusBadge({ status }) {
  const { label, tone } = orderStatus(status);
  return <Badge tone={tone}>{label}</Badge>;
}
