/**
 * Type shim for the `node-pty` import specifier.
 *
 * The runtime package is @homebridge/node-pty-prebuilt-multiarch, aliased as
 * "node-pty" in package.json. Its bundled typings use `declare module
 * '@homebridge/node-pty-prebuilt-multiarch'` which TypeScript cannot resolve
 * via the npm alias alone. This shim re-declares the module under the `node-pty`
 * specifier so all source imports of `"node-pty"` resolve correctly.
 *
 * API surface matches node-pty 0.10.x / @homebridge/node-pty-prebuilt-multiarch 0.13.x.
 */
declare module "node-pty" {
  /**
   * An object that can be disposed via a dispose function.
   */
  export interface IDisposable {
    dispose(): void;
  }

  /**
   * An event that can be listened to.
   * @returns an IDisposable to stop listening.
   */
  export interface IEvent<T> {
    (listener: (e: T) => unknown): IDisposable;
  }

  export interface IBasePtyForkOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: { [key: string]: string | undefined };
    encoding?: string | null;
    handleFlowControl?: boolean;
    flowControlPause?: string;
    flowControlResume?: string;
  }

  export interface IPtyForkOptions extends IBasePtyForkOptions {
    uid?: number;
    gid?: number;
  }

  export interface IWindowsPtyForkOptions extends IBasePtyForkOptions {
    useConpty?: boolean;
    useConptyDll?: boolean;
    conptyInheritCursor?: boolean;
  }

  /**
   * An interface representing a pseudoterminal.
   */
  export interface IPty {
    readonly pid: number;
    readonly cols: number;
    readonly rows: number;
    readonly process: string;
    handleFlowControl: boolean;
    readonly onData: IEvent<string>;
    readonly onExit: IEvent<{ exitCode: number; signal?: number }>;
    resize(columns: number, rows: number): void;
    on(event: "data", listener: (data: string) => void): void;
    on(event: "exit", listener: (exitCode: number, signal?: number) => void): void;
    clear(): void;
    write(data: string): void;
    kill(signal?: string): void;
    pause(): void;
    resume(): void;
  }

  /**
   * Forks a process as a pseudoterminal.
   */
  export function spawn(
    file: string,
    args: string[] | string,
    options: IPtyForkOptions | IWindowsPtyForkOptions,
  ): IPty;
}
