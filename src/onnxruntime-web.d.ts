// onnxruntime-web ships its type declarations in `types.d.ts`, but its
// package.json `exports` map has no `types` condition, so TypeScript's
// node-style resolution can't find them under `bundler`/`node16` module
// resolution. Re-point at the bundled declarations explicitly so the dynamic
// imports in browser/modelLoader.ts are typed (issue #6).
/// <reference types="onnxruntime-web/types" />

declare module "onnxruntime-web" {
  export * from "onnxruntime-common";
}
declare module "onnxruntime-web/webgpu" {
  export * from "onnxruntime-web";
}
declare module "onnxruntime-web/wasm" {
  export * from "onnxruntime-web";
}
