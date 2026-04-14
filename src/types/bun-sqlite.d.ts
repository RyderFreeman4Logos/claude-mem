declare module 'bun:sqlite' {
  export class Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get<T = unknown>(...params: unknown[]): T;
    all<T = unknown>(...params: unknown[]): T[];
    values(...params: unknown[]): unknown[][];
  }

  export interface DatabaseOptions {
    create?: boolean;
    readonly?: boolean;
    readwrite?: boolean;
    strict?: boolean;
    safeIntegers?: boolean;
  }

  export class Database {
    constructor(filename?: string, options?: DatabaseOptions);
    readonly filename: string;
    run(query: string, ...params: unknown[]): void;
    prepare(query: string): Statement;
    query(query: string): Statement;
    exec(query: string): void;
    close(): void;
    loadExtension(path: string, entryPoint?: string): void;
    transaction<T extends (...args: any[]) => any>(callback: T): T;
    serialize(): Uint8Array;
  }
}
