/**
 * What stops a brand's build. `step` is where it stopped (BUILD_STEPS, plus submit and report), `field` the brand-kit field at
 * fault when there is one (P-33, P-34), `code` a short word a caller can switch on. The message is plain words for our team and
 * the seller; it never holds a key, a token or a path outside the repository.
 */
export class BuildBrandError extends Error {
  constructor({ step, code, message, field = null, platform = null, problems = [] }) {
    super(message);
    this.name = 'BuildBrandError';
    this.step = step;
    this.code = code;
    this.field = field;
    this.platform = platform;
    /** Every problem found, when a step collects more than one: [{ field, code, message, platform }]. */
    this.problems = problems;
  }
}

/** A step, or a way of doing one, that its track has not filled yet. */
export const notBuilt = (step, what) => new BuildBrandError({ step, code: 'not_built', message: `${what} is not built yet.` });
