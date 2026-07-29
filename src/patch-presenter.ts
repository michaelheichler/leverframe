// src/patch-presenter.ts — a narrow presentation port for the patch commands.
//
// src/patch-reconcile.ts owns the application decisions (what to check, what
// to run, what the outcome means); it should not be coupled to a specific
// prompt library to report them. This interface is the seam: production code
// gets the `@clack/prompts` + `picocolors` implementation below, and callers
// (including tests) can substitute a plain-object recorder instead of
// mocking `@clack/prompts`.

import pc from 'picocolors';
import * as p from '@clack/prompts';

export interface PatchPresenter {
  error(message: string): void;
  warn(message: string): void;
  success(message: string): void;
  /** Dim, secondary detail line (e.g. per-patch-site results). */
  detail(message: string): void;
  /** Non-interactive notice, printed to stderr rather than through the prompt UI. */
  notice(message: string): void;
  /** Yes/no confirmation; resolves false for both "no" and a cancelled prompt. */
  confirm(message: string): Promise<boolean>;
}

export const clackPatchPresenter: PatchPresenter = {
  error(message) {
    p.log.error(message);
  },
  warn(message) {
    p.log.warn(message);
  },
  success(message) {
    p.log.success(message);
  },
  detail(message) {
    p.log.info(pc.dim(message));
  },
  notice(message) {
    console.error(pc.dim(message));
  },
  async confirm(message) {
    const answer = await p.confirm({ message, initialValue: false });
    return !p.isCancel(answer) && answer === true;
  },
};
