/**
 * Everything a check starts is stopped or removed again, in reverse order, whether the check passed, failed or was
 * interrupted. `data` closers (databases, buckets, keys the check made) are skipped under --keep; processes are always stopped.
 *
 *   const cleanup = createCleanup({ keep, log });
 *   cleanup.add('web server', () => web.stop());
 *   cleanup.add('database', () => drop(), { data: true });
 *   await cleanup.run();      // answers the names of the closers that failed
 */
export function createCleanup({ keep = false, log = () => {}, signals = true } = {}) {
  const stack = [];
  let ran = null;
  const run = () => (ran ??= (async () => {
    const failed = [];
    for (const { name, fn, data } of stack.reverse()) {
      if (data && keep) {
        log(`kept: ${name}`);
        continue;
      }
      try {
        await fn();
      } catch {
        failed.push(name);
      }
    }
    return failed;
  })());
  const onSignal = (signal) => {
    log(`${signal}: stopping what this check started`);
    run().finally(() => process.exit(130));
  };
  if (signals) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
  return {
    add(name, fn, { data = false } = {}) {
      stack.push({ name, fn, data });
    },
    run,
    dispose() {
      if (signals) {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      }
    },
  };
}
