export type VideoFrameFormat = "I420" | "NV12" | "I010";

export type HdrWebglRenderer = {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vertexArray: WebGLVertexArrayObject;
  vertexBuffer: WebGLBuffer;
  yTexture: WebGLTexture;
  uTexture: WebGLTexture;
  vTexture: WebGLTexture;
  width: number;
  height: number;
};

export type SdrWebglRenderer = {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vertexArray: WebGLVertexArrayObject;
  vertexBuffer: WebGLBuffer;
  format: "I420" | "NV12";
  yTexture: WebGLTexture;
  uTexture: WebGLTexture | null;
  vTexture: WebGLTexture | null;
  uvTexture: WebGLTexture | null;
  width: number;
  height: number;
};
