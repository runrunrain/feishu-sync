import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownView } from '../components/preview/MarkdownView';

/** Bundled for Node so desktop and shared pages use exactly the same renderer. */
export function render(markdown: string, resolveHref: (href: string) => string | null, resolveImage: (src: string) => string | null): string {
  return renderToStaticMarkup(<MarkdownView content={markdown} staticMode resolveHref={resolveHref} resolveImage={resolveImage} remoteImages="confirm" />);
}
