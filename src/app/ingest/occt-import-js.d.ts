/** Minimal typing for occt-import-js (the package ships none). */
declare module 'occt-import-js' {
  export interface OcctParams {
    linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot';
    linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value';
    linearDeflection?: number;
    angularDeflection?: number;
  }
  export interface OcctRawNode {
    name: string;
    meshes: number[];
    children: OcctRawNode[];
  }
  export interface OcctRawMesh {
    name?: string;
    color?: [number, number, number];
    attributes: { position: { array: ArrayLike<number> }; normal?: { array: ArrayLike<number> } };
    index: { array: ArrayLike<number> };
  }
  export interface OcctRawResult {
    success: boolean;
    root: OcctRawNode;
    meshes: OcctRawMesh[];
  }
  export interface OcctModule {
    ReadStepFile(content: Uint8Array, params: OcctParams | null): OcctRawResult;
    ReadIgesFile(content: Uint8Array, params: OcctParams | null): OcctRawResult;
  }
  export interface OcctFactoryOptions {
    locateFile?: (name: string) => string;
  }
  const factory: (options?: OcctFactoryOptions) => Promise<OcctModule>;
  export default factory;
}
