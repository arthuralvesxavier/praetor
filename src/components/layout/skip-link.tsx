/** First focusable element of the page: jumps to `<main id="conteudo">`. */
export function SkipLink({ targetId = "conteudo" }: { targetId?: string }) {
  return (
    <a
      href={`#${targetId}`}
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:shadow-lg"
    >
      Pular para o conteúdo
    </a>
  );
}
