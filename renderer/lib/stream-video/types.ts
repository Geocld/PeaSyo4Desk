export type VideoFrameFormat = "I420" | "NV12" | "I010" | "P010";

export type HdrWebglRenderer = {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vertexArray: WebGLVertexArrayObject;
  vertexBuffer: WebGLBuffer;
  format: "I010" | "P010";
  yTexture: WebGLTexture;
  uTexture: WebGLTexture | null;
  vTexture: WebGLTexture | null;
  uvTexture: WebGLTexture | null;
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

export type FsrWebglRenderer = {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vertexArray: WebGLVertexArrayObject;
  vertexBuffer: WebGLBuffer;
  sourceTexture: WebGLTexture;
  resolutionLocation: WebGLUniformLocation | null;
  sharpnessLocation: WebGLUniformLocation | null;
  width: number;
  height: number;
};
