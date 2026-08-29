/** Desktop must mirror dashboard's node-pty shim because desktop typechecks dashboard source via @fusion/dashboard workspace imports. */
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
