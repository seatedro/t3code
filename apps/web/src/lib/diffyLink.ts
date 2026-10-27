// Fork: agents link pull requests as diffy://github.com/<owner>/<repo>/pull/<n> to open them in
// the Diffy app. react-markdown drops unknown schemes, so chat keeps exactly this shape.
const DIFFY_PULL_REQUEST_HREF = /^diffy:\/\/github\.com\/[^/@:]+\/[^/]+\/pull\/\d+(?:[/?#]|$)/i;

export function isDiffyPullRequestHref(href: string): boolean {
  return DIFFY_PULL_REQUEST_HREF.test(href);
}
