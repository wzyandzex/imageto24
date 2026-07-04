/**
 * Minimal ambient declaration for `pngjs` (issue #37). The package ships no
 * TypeScript types, and the APNG fallback only needs the synchronous PNG read
 * surface. The implementation is lazy-`import()`ed inside the APNG decoder, so
 * non-APNG users never load it.
 */
declare module "pngjs/browser" {
  export class PNG {
    readonly width: number;
    readonly height: number;
    readonly data: Buffer;

    static sync: {
      read(buffer: Buffer): PNG;
    };
  }
}
