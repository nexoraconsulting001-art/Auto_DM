import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Sheet } from '../design/index.jsx';

const FeedbackContext = createContext(null);
const TOAST_MS = 4000;

/**
 * Two things every screen needs and none should build: a short "Saved" that survives moving to another page,
 * and an "Are you sure?" before anything that can't be undone. confirm() resolves to true or false.
 */
export function FeedbackProvider({ children }) {
  const dialog = useRef(null);
  const answer = useRef(null);
  const timer = useRef(null);
  const [question, setQuestion] = useState(null);
  const [note, setNote] = useState('');

  const toast = useCallback((text) => {
    clearTimeout(timer.current);
    setNote(text);
    timer.current = setTimeout(() => setNote(''), TOAST_MS);
  }, []);

  const confirm = useCallback((details) => new Promise((resolve) => {
    answer.current = resolve;
    setQuestion(details);
  }), []);

  useEffect(() => {
    if (question && !dialog.current.open) dialog.current.showModal();
  }, [question]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const finish = (value) => {
    if (dialog.current?.open) dialog.current.close();
    answer.current?.(value);
    answer.current = null;
    setQuestion(null);
  };

  const value = useMemo(() => ({ toast, confirm }), [toast, confirm]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <div className="toast-area" role="status" aria-live="polite">
        {note && <div className="toast">{note}</div>}
      </div>
      <Sheet ref={dialog} title={question?.title ?? 'Are you sure?'} onClose={() => finish(false)}>
        {question?.text && <p className="sheet-text">{question.text}</p>}
        <div className="sheet-actions">
          <Button variant="outline" onClick={() => finish(false)}>{question?.cancel ?? 'Keep it'}</Button>
          <Button variant={question?.tone ?? 'danger'} onClick={() => finish(true)}>{question?.confirm ?? 'Delete'}</Button>
        </div>
      </Sheet>
    </FeedbackContext.Provider>
  );
}

export const useFeedback = () => useContext(FeedbackContext);
