export const SDR_VERTEX_SHADER_SOURCE = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;

void main() {
  v_texCoord = a_texCoord;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const SDR_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

in vec2 v_texCoord;
uniform sampler2D u_texY;
uniform sampler2D u_texU;
uniform sampler2D u_texV;
out vec4 outColor;

void main() {
  float y = texture(u_texY, v_texCoord).r;
  float u = texture(u_texU, v_texCoord).r - 0.5;
  float v = texture(u_texV, v_texCoord).r - 0.5;

  float c = max(y - 0.062745098, 0.0) * 1.16438356;
  float r = c + 1.59602678 * v;
  float g = c - 0.39176229 * u - 0.81296764 * v;
  float b = c + 2.01723214 * u;

  outColor = vec4(clamp(vec3(r, g, b), 0.0, 1.0), 1.0);
}
`;

export const SDR_NV12_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

in vec2 v_texCoord;
uniform sampler2D u_texY;
uniform sampler2D u_texUV;
out vec4 outColor;

void main() {
  float y = texture(u_texY, v_texCoord).r;
  vec2 uv = texture(u_texUV, v_texCoord).rg - vec2(0.5, 0.5);

  float c = max(y - 0.062745098, 0.0) * 1.16438356;
  float r = c + 1.59602678 * uv.y;
  float g = c - 0.39176229 * uv.x - 0.81296764 * uv.y;
  float b = c + 2.01723214 * uv.x;

  outColor = vec4(clamp(vec3(r, g, b), 0.0, 1.0), 1.0);
}
`;

export const HDR_VERTEX_SHADER_SOURCE = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;

void main() {
  v_texCoord = a_texCoord;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const HDR_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;
precision highp usampler2D;

in vec2 v_texCoord;
uniform usampler2D u_texY;
uniform usampler2D u_texU;
uniform usampler2D u_texV;
out vec4 outColor;

vec3 pqToLinear(vec3 value) {
  const float m1 = 0.1593017578125;
  const float m2 = 78.84375;
  const float c1 = 0.8359375;
  const float c2 = 18.8515625;
  const float c3 = 18.6875;

  vec3 powered = pow(max(value, vec3(0.0)), vec3(1.0 / m2));
  vec3 numerator = max(powered - vec3(c1), vec3(0.0));
  vec3 denominator = max(vec3(c2) - vec3(c3) * powered, vec3(1e-6));
  return pow(numerator / denominator, vec3(1.0 / m1));
}

vec3 acesTonemap(vec3 value) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((value * (a * value + b)) / (value * (c * value + d) + e), 0.0, 1.0);
}

vec3 linearToSrgb(vec3 value) {
  vec3 lower = value * 12.92;
  vec3 higher = 1.055 * pow(max(value, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  vec3 cutoff = step(vec3(0.0031308), value);
  return mix(lower, higher, cutoff);
}

void main() {
  ivec2 ySize = textureSize(u_texY, 0);
  ivec2 uvSize = textureSize(u_texU, 0);
  ivec2 yCoord = min(ivec2(v_texCoord * vec2(ySize)), ySize - ivec2(1));
  ivec2 uvCoord = min(ivec2(v_texCoord * vec2(uvSize)), uvSize - ivec2(1));

  float yRaw = float(texelFetch(u_texY, yCoord, 0).r & 1023u);
  float uRaw = float(texelFetch(u_texU, uvCoord, 0).r & 1023u);
  float vRaw = float(texelFetch(u_texV, uvCoord, 0).r & 1023u);

  float y = clamp((yRaw - 64.0) / 876.0, 0.0, 1.0);
  float cb = clamp((uRaw - 512.0) / 896.0, -0.5, 0.5);
  float cr = clamp((vRaw - 512.0) / 896.0, -0.5, 0.5);

  vec3 pqRgb = clamp(vec3(
    y + 1.4746 * cr,
    y - 0.164553 * cb - 0.571353 * cr,
    y + 1.8814 * cb
  ), 0.0, 1.0);

  vec3 linearHdr = pqToLinear(pqRgb) * (10000.0 / 203.0);
  vec3 linearSdr = acesTonemap(linearHdr);
  vec3 srgb = linearToSrgb(linearSdr);
  outColor = vec4(srgb, 1.0);
}
`;
