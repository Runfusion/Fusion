/*
FNXC:ReportPipeline 2026-07-19-00:25:
html2canvas ships typings via package "typings", but dashboard app typecheck
(`moduleResolution: "bundler"`, explicit `compilerOptions.types`) fails to resolve
the package module on CI with TS2307. Ambient module keeps capture-screenshot
type-safe without relying on package resolution.

FNXC:ReportPipeline 2026-07-19-12:00:
Omit catch-all index signature on Options — upstream html2canvas@1.4.1 Options is
explicit; Partial<Options> already covers optional fields; index signature hides typos.
*/
declare module "html2canvas" {
  export type Options = {
    backgroundColor?: string | null;
    scale?: number;
    useCORS?: boolean;
    logging?: boolean;
    foreignObjectRendering?: boolean;
    removeContainer?: boolean;
  };

  function html2canvas(
    element: HTMLElement,
    options?: Partial<Options>,
  ): Promise<HTMLCanvasElement>;

  export default html2canvas;
}
