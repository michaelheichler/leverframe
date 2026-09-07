

import pc from 'picocolors';
import * as p from '@clack/prompts';

export interface PatchPresenter {
  error(message: string): void;
  warn(message: string): void;
  success(message: string): void;

  detail(message: string): void;

  notice(message: string): void;

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
