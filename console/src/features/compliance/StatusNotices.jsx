import { Link } from 'react-router-dom';
import { Banner, Button } from '../../design/index.jsx';
import './compliance.css';

export function NoticeList({ notices }) {
  if (!notices.length) return null;
  return (
    <div className="notice-list">
      {notices.map((notice) => (
        <Banner key={notice.key} tone={notice.tone}>
          <span className="notice">
            <span className="notice-text">{notice.text}</span>
            {notice.action && <Button as={Link} variant="outline" className="notice-action" to={notice.action.to}>{notice.action.label}</Button>}
          </span>
        </Banner>
      ))}
    </div>
  );
}
