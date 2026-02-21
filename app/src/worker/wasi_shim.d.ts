// type declarations for @bjorn3/browser_wasi_shim@0.4.2
// the npm package ships no TypeScript types

declare module "@bjorn3/browser_wasi_shim" {
  export class File {
    data: Uint8Array;
    constructor(data: Uint8Array | ArrayBuffer);
  }

  export class Directory {
    contents: Map<string, File | Directory>;
    constructor(contents: Map<string, File | Directory>);
  }

  export class OpenFile {
    constructor(file: File);
  }

  export class PreopenDirectory {
    constructor(name: string, contents: Map<string, File | Directory>);
  }

  export class ConsoleStdout {
    static lineBuffered(callback: (line: string) => void): ConsoleStdout;
  }

  type Fd = OpenFile | PreopenDirectory | ConsoleStdout;

  export class WASI {
    wasiImport: Record<string, WebAssembly.ImportValue>;
    constructor(args: string[], env: string[], fds: Fd[]);
    start(instance: WebAssembly.Instance): number;
  }
}
