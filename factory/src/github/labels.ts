import { ghWrite } from './client.js';

export function addLabel(issueNumber: number, label: string, repo: string): void {
  ghWrite(`issue edit ${issueNumber} --add-label "${label}"`, repo);
}

export function removeLabel(issueNumber: number, label: string, repo: string): void {
  ghWrite(`issue edit ${issueNumber} --remove-label "${label}"`, repo);
}

/** Remove one label and add another atomically (single gh invocation) */
export function transitionLabel(
  issueNumber: number,
  fromLabel: string,
  toLabel: string,
  repo: string,
): void {
  ghWrite(
    `issue edit ${issueNumber} --remove-label "${fromLabel}" --add-label "${toLabel}"`,
    repo,
  );
}
