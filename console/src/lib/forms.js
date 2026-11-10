import { useCallback, useState } from 'react';

const CHECK_THE_FORM = 'Please check the highlighted details.';

/**
 * A failed save, split into a sentence for the form and messages for the fields they're about. Field paths
 * like "images.2" or "pricePaise" become the form's own names through `rename`.
 */
export function describeFailure(error, rename = {}) {
  const fields = {};
  for (const [path, message] of Object.entries(error.fields ?? {})) {
    const head = path.split('.')[0];
    fields[rename[head] ?? head] ??= message;
  }
  return { message: error.message, fields };
}

/** The state of one form. `field` and `toggle` spread straight onto TextField and Toggle. */
export function useForm(initial, { rename } = {}) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const set = useCallback((name, value) => {
    setValues((current) => ({ ...current, [name]: typeof value === 'function' ? value(current[name]) : value }));
  }, []);

  const field = (name) => ({ name, value: values[name] ?? '', error: errors[name], onChange: (event) => set(name, event.target.value) });
  const toggle = (name) => ({ name, checked: Boolean(values[name]), onChange: (event) => set(name, event.target.checked) });

  /** Shows what the form itself found wrong, before anything is sent. */
  function reject(found) {
    setErrors(found);
    setMessage(CHECK_THE_FORM);
  }

  /** Runs a save, showing the server's answer on the form if it fails. Resolves to true when it worked. */
  async function run(action) {
    setBusy(true);
    setErrors({});
    setMessage('');
    try {
      await action();
      return true;
    } catch (error) {
      const failure = describeFailure(error, rename);
      setErrors(failure.fields);
      setMessage(failure.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { values, errors, message, busy, set, field, toggle, reject, run };
}
