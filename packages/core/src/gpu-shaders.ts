export const FULLSCREEN_VERTEX_SHADER: string = `#version 300 es
in vec2 position;
out vec2 vUv;

void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

export const SOURCE_SHADER: string = `#version 300 es
precision highp float;

uniform sampler2D sourceTexture;
uniform vec2 sourceResolution;

out vec4 outColor;

vec3 srgbEotf(vec3 color) {
  vec3 low = color / 12.92;
  vec3 high = pow((color + 0.055) / 1.055, vec3(2.4));
  return mix(high, low, step(color, vec3(0.04045)));
}

void main() {
  vec2 p = floor(gl_FragCoord.xy);
  vec2 sourceUv = vec2((p.x + 0.5) / sourceResolution.x,
    (p.y + 0.5) / sourceResolution.y);
  vec4 source = texture(sourceTexture, sourceUv);
  vec3 sourceLinear = srgbEotf(source.rgb);
  outColor = vec4(sourceLinear, source.a);
}
`;

export const BLOCK_REDUCTION_FRAGMENT_SHADER: string = `#version 300 es
precision highp float;

uniform sampler2D sceneTexture;
uniform vec2 sceneResolution;
uniform float blockSize;
uniform float contrast;
uniform bool contrastEnabled;

out vec4 outColor;

vec3 sampleScene(vec2 pixel) {
  vec2 uv = vec2((pixel.x + 0.5) / sceneResolution.x,
    (sceneResolution.y - 0.5 - pixel.y) / sceneResolution.y);
  return texture(sceneTexture, uv).rgb;
}

vec3 applyContrast(vec3 color) {
  float c = contrast * 2.55;
  float factor = (259.0 * (c + 255.0)) / (255.0 * (259.0 - c));
  return clamp(factor * (color - 0.5) + 0.5, 0.0, 1.0);
}

void main() {
  vec2 origin = floor(gl_FragCoord.xy) * blockSize;
  vec3 total = vec3(0.0);
  for (int ty = 0; ty < 4; ty += 1) {
    for (int tx = 0; tx < 4; tx += 1) {
      vec2 tap = origin + vec2(float(tx), float(ty)) * (blockSize / 4.0) + blockSize / 8.0;
      tap = clamp(tap, vec2(0.0), sceneResolution - 1.0);
      vec3 color = sampleScene(tap);
      total += contrastEnabled ? applyContrast(color) : color;
    }
  }
  outColor = vec4(total / 16.0, 1.0);
}
`;

export const POST_SHADER: string = `#version 300 es
precision highp float;

uniform sampler2D sceneTexture;
uniform sampler2D blocksTexture;
uniform vec2 sceneResolution;
uniform vec2 blockResolution;
uniform float blockSize;
uniform float bloom;
uniform bool bloomEnabled;
uniform float bloomHighlightLow;
uniform float bloomHighlightHigh;
uniform float ribAngle;
uniform float ribPitch;
uniform float ribLowLuminanceWidth;
uniform float ribHighLuminanceWidth;
uniform float ribLowLuminanceDarkness;
uniform float ribHighLuminanceDarkness;
uniform float ribLuminanceLow;
uniform float ribLuminanceHigh;
uniform float ribLuminanceGamma;
uniform float ribEdgeSoftness;
uniform bool ribsEnabled;
uniform float fringeDistance;
uniform float fringeProbeDistance;
uniform float fringeIntensity;
uniform float fringeTintMix;
uniform float fringeEdgeLow;
uniform float fringeEdgeHigh;
uniform float fringeRibEdgeLow;
uniform float fringeRibEdgeHigh;
uniform float fringeMinimumRibEdgeContribution;
uniform float blockFringeGain;
uniform vec3 negativeFringeTint;
uniform vec3 positiveFringeTint;
uniform bool rgbFringeEnabled;
uniform float contrast;
uniform bool contrastEnabled;
uniform float posterization;
uniform float ribLowLuminanceValueScale;
uniform float ribHighLuminanceValueScale;
uniform float ribLowLuminanceSaturationScale;
uniform float ribHighLuminanceSaturationScale;

out vec4 outColor;

float luminance(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

vec3 sampleScene(vec2 pixel) {
  if (any(lessThan(pixel, vec2(0.0))) || any(greaterThanEqual(pixel, sceneResolution))) {
    return vec3(0.0);
  }
  vec2 uv = vec2((pixel.x + 0.5) / sceneResolution.x,
    (sceneResolution.y - 0.5 - pixel.y) / sceneResolution.y);
  return texture(sceneTexture, uv).rgb;
}

vec4 sampleBlock(vec2 block) {
  if (any(lessThan(block, vec2(0.0))) || any(greaterThanEqual(block, blockResolution))) {
    return vec4(0.0);
  }
  return texture(blocksTexture, (block + 0.5) / blockResolution);
}

vec3 srgbOetf(vec3 color) {
  vec3 low = color * 12.92;
  vec3 high = 1.055 * pow(color, vec3(1.0 / 2.4)) - 0.055;
  return mix(high, low, step(color, vec3(0.0031308)));
}

vec3 rgbToHsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsvToRgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec2 framebufferPixel = floor(gl_FragCoord.xy);
  vec2 p = vec2(framebufferPixel.x, sceneResolution.y - 1.0 - framebufferPixel.y);
  vec2 block = floor(p / blockSize);
  vec3 scene = sampleScene(p);
  vec4 blockSample = sampleBlock(block);
  vec3 blockColor = blockSample.rgb;
  float blockAlpha = blockSample.a;
  vec3 effect = blockColor;

  if (contrastEnabled) {
    float c = contrast * 2.55;
    float factor = (259.0 * (c + 255.0)) / (255.0 * (259.0 - c));
    effect = clamp(factor * (effect - 0.5) + 0.5, 0.0, 1.0);
  }

  if (posterization > 0.0) {
    vec3 hsv = rgbToHsv(effect);
    float levels = round(exp2(mix(8.0, 2.0, posterization)));
    hsv.y = floor(hsv.y * levels) / levels;
    hsv.z = floor(hsv.z * levels) / levels;
    effect = hsvToRgb(hsv);
  }

  if (bloomEnabled) {
    vec3 localBloom = (
      sampleBlock(block + vec2(1.0, 0.0)).rgb +
      sampleBlock(block - vec2(1.0, 0.0)).rgb +
      sampleBlock(block + vec2(0.0, 1.0)).rgb +
      sampleBlock(block - vec2(0.0, 1.0)).rgb
    ) * 0.25;
    float highlight = smoothstep(bloomHighlightLow, bloomHighlightHigh,
      max(max(effect.r, effect.g), effect.b));
    effect += (localBloom - effect) * highlight * bloom;
  }

  float angle = radians(ribAngle);
  // p uses top-left source coordinates, where positive angles rotate clockwise.
  vec2 ribNormal = vec2(cos(angle), sin(angle));
  float projected = dot(p, ribNormal);
  float signedRibPhase = mod(projected + ribPitch * 0.5, ribPitch) - ribPitch * 0.5;
  float ribDistance = abs(signedRibPhase);
  vec2 ribCenterPoint = p - ribNormal * signedRibPhase;
  vec2 ribCenterBlock = floor(ribCenterPoint / blockSize);
  vec3 ribBlockColor = sampleBlock(ribCenterBlock).rgb;
  float ribLuminance = luminance(ribBlockColor);
  float luminanceResponse = pow(smoothstep(ribLuminanceLow, ribLuminanceHigh, ribLuminance), ribLuminanceGamma);
  float ribWidth = mix(ribLowLuminanceWidth, ribHighLuminanceWidth, luminanceResponse);
  float ribDarkness = mix(ribLowLuminanceDarkness, ribHighLuminanceDarkness, luminanceResponse);
  float ribMask = 1.0 - smoothstep(ribWidth * 0.5 - ribEdgeSoftness,
    ribWidth * 0.5 + ribEdgeSoftness, ribDistance);
  vec3 ribHsv = rgbToHsv(ribBlockColor);
  float ribValueScale = mix(ribLowLuminanceValueScale, ribHighLuminanceValueScale, luminanceResponse);
  float ribSatScale = mix(ribLowLuminanceSaturationScale, ribHighLuminanceSaturationScale, luminanceResponse);
  ribHsv.y = clamp(ribHsv.y * ribSatScale, 0.0, 1.0);
  ribHsv.z = clamp(ribHsv.z * ribValueScale, 0.0, 1.0);
  vec3 ribColor = hsvToRgb(ribHsv);
  float enabled = ribsEnabled ? 1.0 : 0.0;
  effect = mix(effect, ribColor, ribMask * ribDarkness * enabled);

  if (rgbFringeEnabled) {
    vec2 fringeDirection = ribNormal;
    vec3 sourceMinus = sampleScene(p - fringeDirection * fringeDistance);
    vec3 sourcePlus = sampleScene(p + fringeDirection * fringeDistance);
    vec3 probeMinus = sampleScene(p - fringeDirection * fringeProbeDistance);
    vec3 probePlus = sampleScene(p + fringeDirection * fringeProbeDistance);
    vec3 gradientDelta = abs(probePlus - probeMinus);
    float gradientMagnitude = max(gradientDelta.r, max(gradientDelta.g, gradientDelta.b));
    float gradientGate = smoothstep(fringeEdgeLow, fringeEdgeHigh, gradientMagnitude);
    float ribEdgeGate = 1.0 - smoothstep(fringeRibEdgeLow, fringeRibEdgeHigh,
      abs(ribDistance - ribWidth * 0.5));
    float fringeGate = gradientGate * mix(fringeMinimumRibEdgeContribution, 1.0, ribEdgeGate);
    vec2 fringeBlockOffset = fringeDirection * fringeDistance / blockSize;
    vec3 blockMinus = sampleBlock(block - fringeBlockOffset).rgb;
    vec3 blockPlus = sampleBlock(block + fringeBlockOffset).rgb;
    vec3 sourceRgbSplit = vec3(sourcePlus.r, scene.g, sourceMinus.b) - scene;
    vec3 blockRgbSplit = vec3(blockPlus.r, blockColor.g, blockMinus.b) - blockColor;
    vec3 rgbSplit = sourceRgbSplit + blockRgbSplit * blockFringeGain;
    vec3 tint = signedRibPhase < 0.0 ? negativeFringeTint : positiveFringeTint;
    effect += rgbSplit * fringeGate * fringeIntensity;
    effect = mix(effect, tint, fringeGate * fringeTintMix);
  }

  vec3 outputSrgb = srgbOetf(clamp(effect, vec3(0.0), vec3(1.0)));
  outColor = blockAlpha <= 0.0 ? vec4(0.0) : vec4(outputSrgb, blockAlpha);
}
`;

export const DISPLAY_SHADER: string = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D sourceTexture;
uniform sampler2D resultTexture;
uniform vec3 previewBackground;
uniform bool showOriginal;
out vec4 outColor;
void main() {
  // sourceTexture is stored top-left-origin; result FBO is GL bottom-up, so flip V for the source only.
  vec4 src = showOriginal ? texture(sourceTexture, vec2(vUv.x, 1.0 - vUv.y)) : texture(resultTexture, vUv);
  outColor = mix(vec4(previewBackground, 1.0), vec4(src.rgb, 1.0), src.a);
}
`;