import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api/index.js';
import { statusNotices } from './notices.js';

const REFRESH_MS = 30_000;

/** The three things that decide whether messages can go. Each fails on its own, so one bad answer doesn't hide the others. */
export function useStatusSources() {
  const status = useQuery({ queryKey: ['compliance-status'], queryFn: () => api.compliance.status(), refetchInterval: REFRESH_MS });
  const connection = useQuery({ queryKey: ['instagram-connection'], queryFn: () => api.instagram.connection() });
  const facebook = useQuery({ queryKey: ['facebook-connection'], queryFn: () => api.facebook.connection(), retry: false });
  return { status, connection, facebook };
}

export function useStatusNotices() {
  const { status, connection, facebook } = useStatusSources();
  return statusNotices({ status: status.data, connection: connection.data, facebook: facebook.data });
}
