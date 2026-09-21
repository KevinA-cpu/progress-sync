import { HDL_ORIGIN, HDL_PROBLEM_PATH } from '../constants/progress';

// The transport refuses any hop off this origin; this decides that whatever a redirect chain ended on is
// still the problem that was asked for, so only the site's own case canonicalization of the path passes.
export function sameProblemPage(finalUrl: string, problemId: string): boolean {
  try {
    const url = new URL(finalUrl);
    return url.origin === HDL_ORIGIN
      && decodeURIComponent(url.pathname).toLowerCase() === `${HDL_PROBLEM_PATH}${problemId}`;
  } catch {
    return false;
  }
}
