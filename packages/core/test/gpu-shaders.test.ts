import { readFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const source = await readFile(new URL('../src/gpu-shaders.ts', import.meta.url), 'utf8');
const reductionSource = await readFile(new URL('../src/gpu-reduction-shaders.ts', import.meta.url), 'utf8');
const engineSource = await readFile(new URL('../src/gpu-filter.ts', import.meta.url), 'utf8');

function shader(name: string) {
  const match = source.match(new RegExp('export const ' + name + ': string = `([\\s\\S]*?)`;'));
  assert.ok(match, `${name} must be exported as a shader string from gpu-shaders.ts`);
  return match[1];
}

function reductionShader(name: string) {
  const match = reductionSource.match(new RegExp('export const ' + name + ': string = `([\\s\\S]*?)`;'));
  assert.ok(match, `${name} must be exported as a shader string from gpu-reduction-shaders.ts`);
  return match[1];
}

const vertex = shader('FULLSCREEN_VERTEX_SHADER');
const upload = shader('SOURCE_SHADER');
const reduction = shader('BLOCK_REDUCTION_FRAGMENT_SHADER');
const post = shader('POST_SHADER');
const blit = shader('DISPLAY_SHADER');
const tileSum = reductionShader('TILE_SUM_SHADER');
const blockReduction = reductionShader('BLOCK_REDUCTION_SHADER');

test('all seven shader exports exist', () => {
  // Only BLOCK_REDUCTION_FRAGMENT_SHADER, DISPLAY_SHADER, SOURCE_SHADER, POST_SHADER - FULLSCREEN_VERTEX_SHADER doesn't end with _SHADER
  const gpuShaderExportsAll = (source.match(/export const \w+/g) ?? []).length;
  assert.equal(gpuShaderExportsAll, 5, 'gpu-shaders.ts must export exactly 5 symbols');
  const reductionExports = (reductionSource.match(/export const \w+/g) ?? []).length;
  assert.equal(reductionExports, 2, 'gpu-reduction-shaders.ts must export exactly 2 symbols');
});

test('every shader starts with #version 300 es', () => {
  for (const s of [vertex, upload, reduction, post, blit, tileSum, blockReduction]) {
    assert.ok(s.startsWith('#version 300 es'), 'shader must start with #version 300 es');
  }
});

test('no WebGL1 syntax in any shader', () => {
  for (const s of [vertex, upload, reduction, post, blit, tileSum, blockReduction]) {
    assert.doesNotMatch(s, /\btexture2D\b/);
    assert.doesNotMatch(s, /\bgl_FragColor\b/);
    assert.doesNotMatch(s, /\bvarying\b/);
    assert.doesNotMatch(s, /\battribute\b/);
  }
});

test('vertex shader uses WebGL2 in/out syntax', () => {
  assert.match(vertex, /in vec2 position;/);
  assert.match(vertex, /out vec2 vUv;/);
  assert.match(vertex, /gl_Position = vec4\(position, 0\.0, 1\.0\)/);
});

test('SOURCE_SHADER converts sRGB to linear without background compositing', () => {
  assert.match(upload, /vec3 srgbEotf\(vec3 color\)/);
  assert.match(upload, /0\.04045/);
  assert.match(upload, /pow\(\(color \+ 0\.055\) \/ 1\.055, vec3\(2\.4\)\)/);
  assert.match(upload, /p\.y \+ 0\.5\) \/ sourceResolution\.y/);
  assert.match(upload, /outColor = vec4\(sourceLinear, source\.a\)/);
  assert.doesNotMatch(upload, /background/);
  assert.doesNotMatch(upload, /composited/);
});

test('BLOCK_REDUCTION_FRAGMENT_SHADER uses WebGL2 texture() not texture2D()', () => {
  assert.match(reduction, /\btexture\(sceneTexture, uv\)/);
  assert.doesNotMatch(reduction, /\btexture2D\b/);
  assert.match(reduction, /for \(int ty = 0; ty < 4; ty \+= 1\)/);
  assert.match(reduction, /for \(int tx = 0; tx < 4; tx \+= 1\)/);
  assert.match(reduction, /outColor = vec4\(total \/ 16\.0, 1\.0\)/);
});

test('POST_SHADER has new uniforms and helpers', () => {
  assert.match(post, /\bposterization\b/);
  assert.match(post, /\bribLowLuminanceValueScale\b/);
  assert.match(post, /\bribHighLuminanceValueScale\b/);
  assert.match(post, /\bribLowLuminanceSaturationScale\b/);
  assert.match(post, /\bribHighLuminanceSaturationScale\b/);
  assert.match(post, /\brgbToHsv\b/);
  assert.match(post, /\bhsvToRgb\b/);
  assert.match(post, /exp2\(mix\(8\.0, 2\.0, posterization\)\)/);
  assert.match(post, /blockAlpha <= 0\.0/);
  assert.match(post, /outColor = blockAlpha <= 0\.0 \? vec4\(0\.0\) : vec4\(outputSrgb, blockAlpha\)/);
});

test('POST_SHADER does not have removed uniforms or strength mix', () => {
  assert.doesNotMatch(post, /\bstrength\b/);
  assert.doesNotMatch(post, /\bribLowLuminanceColor\b/);
  assert.doesNotMatch(post, /\bribHighLuminanceColor\b/);
  assert.doesNotMatch(post, /mix\(scene, effect, strength\)/);
  assert.doesNotMatch(post, /outputLinear/);
  assert.doesNotMatch(post, /\bbackground\b/);
});

test('POST_SHADER returns vec3(0.0) outside scene bounds', () => {
  assert.match(post, /return vec3\(0\.0\);/);
  assert.doesNotMatch(post, /return background;/);
});

test('POST_SHADER retains bloom, rib-center, and fringe equation references', () => {
  assert.match(post, /vec3 localBloom = \([\s\S]*?\) \* 0\.25;/);
  assert.match(post, /max\(max\(effect\.r, effect\.g\), effect\.b\)/);
  assert.match(post, /effect \+= \(localBloom - effect\) \* highlight \* bloom;/);
  assert.match(post, /vec2 ribCenterPoint = p - ribNormal \* signedRibPhase;/);
  assert.match(post, /vec2 ribCenterBlock = floor\(ribCenterPoint \/ blockSize\);/);
  assert.match(post, /vec3 ribBlockColor = sampleBlock\(ribCenterBlock\)\.rgb;/);
  assert.match(post, /float ribLuminance = luminance\(ribBlockColor\);/);
  assert.match(post, /ribWidth \* 0\.5 - ribEdgeSoftness,[\s\S]*?ribWidth \* 0\.5 \+ ribEdgeSoftness/);
  assert.match(post, /vec3 gradientDelta = abs\(probePlus - probeMinus\);/);
  assert.match(post, /max\(gradientDelta\.r, max\(gradientDelta\.g, gradientDelta\.b\)\)/);
  assert.match(post, /vec3 sourceRgbSplit = vec3\(sourcePlus\.r, scene\.g, sourceMinus\.b\) - scene;/);
  assert.match(post, /vec3 blockRgbSplit = vec3\(blockPlus\.r, blockColor\.g, blockMinus\.b\) - blockColor;/);
  assert.match(post, /vec3 rgbSplit = sourceRgbSplit \+ blockRgbSplit \* blockFringeGain;/);
  assert.match(post, /1\.0 - smoothstep\(fringeRibEdgeLow, fringeRibEdgeHigh,[\s\S]*?abs\(ribDistance - ribWidth \* 0\.5\)\)/);
  assert.match(post, /effect = mix\(effect, tint, fringeGate \* fringeTintMix\);/);
});

test('POST_SHADER uses HSV rib derivation instead of color mix', () => {
  assert.match(post, /vec3 ribHsv = rgbToHsv\(ribBlockColor\);/);
  assert.match(post, /ribHsv\.y = clamp\(ribHsv\.y \* ribSatScale, 0\.0, 1\.0\);/);
  assert.match(post, /ribHsv\.z = clamp\(ribHsv\.z \* ribValueScale, 0\.0, 1\.0\);/);
  assert.match(post, /vec3 ribColor = hsvToRgb\(ribHsv\);/);
  assert.doesNotMatch(post, /vec3 ribColor = mix\(ribLowLuminanceColor, ribHighLuminanceColor, luminanceResponse\)/);
});

test('POST_SHADER has contrast and posterization before bloom', () => {
  const contrastIdx = post.indexOf('if (contrastEnabled)');
  const posterizationIdx = post.indexOf('if (posterization > 0.0)');
  const bloomIdx = post.indexOf('if (bloomEnabled)');
  assert.ok(contrastIdx >= 0, 'must have contrastEnabled block');
  assert.ok(posterizationIdx >= 0, 'must have posterization block');
  assert.ok(bloomIdx >= 0, 'must have bloomEnabled block');
  assert.ok(contrastIdx < bloomIdx, 'contrast must come before bloom');
  assert.ok(posterizationIdx < bloomIdx, 'posterization must come before bloom');
});

test('POST_SHADER outputs block-average alpha with srgbOetf', () => {
  assert.match(post, /float blockAlpha = blockSample\.a;/);
  assert.match(post, /vec3 outputSrgb = srgbOetf\(clamp\(effect, vec3\(0\.0\), vec3\(1\.0\)\)\)/);
  assert.match(post, /blockAlpha <= 0\.0 \? vec4\(0\.0\) : vec4\(outputSrgb, blockAlpha\)/);
  assert.doesNotMatch(post, /resampledAlpha/);
});

test('DISPLAY_SHADER composites over preview background', () => {
  assert.match(blit, /\bpreviewBackground\b/);
  assert.match(blit, /\bshowOriginal\b/);
  assert.match(blit, /\bsourceTexture\b/);
  assert.match(blit, /\bresultTexture\b/);
  assert.match(blit, /mix\(vec4\(previewBackground, 1\.0\), vec4\(src\.rgb, 1\.0\), src\.a\)/);
  assert.match(blit, /showOriginal \? texture\(sourceTexture, vec2\(vUv\.x, 1\.0 - vUv\.y\)\) : texture\(resultTexture, vUv\)/);
});

test('TILE_SUM_SHADER uses texelFetch, linear * alpha accumulation, and 1/256 scaling', () => {
  assert.match(tileSum, /\btexelFetch\b/);
  assert.match(tileSum, /linear \* texel\.a/);
  assert.match(tileSum, /outColor = vec4\(sumRgb, sumAlpha\) \/ 256\.0/);
});

test('BLOCK_REDUCTION_SHADER has zero-alpha guard, tile sum rescaling, and direct path', () => {
  assert.match(blockReduction, /sumAlpha <= 0\.0/);
  assert.match(blockReduction, /outColor = vec4\(sumRgb \/ sumAlpha, sumAlpha \/ blockArea\)/);
  assert.match(blockReduction, /float blockArea = float\(\(blockEnd\.x - blockOrigin\.x\) \* \(blockEnd\.y - blockOrigin\.y\)\)/);
  assert.match(blockReduction, /ts\.rgb \* 256\.0/);
  assert.match(blockReduction, /ts\.a \* 256\.0/);
  assert.match(blockReduction, /bs <= 16/);
});

test('gpu-filter.ts imports the new shader names', () => {
  assert.match(engineSource, /import \{[\s\S]*?SOURCE_SHADER[\s\S]*?\} from '\.\/gpu-shaders\.ts'/);
  assert.match(engineSource, /import \{[\s\S]*?POST_SHADER[\s\S]*?\} from '\.\/gpu-shaders\.ts'/);
  assert.match(engineSource, /import \{[\s\S]*?DISPLAY_SHADER[\s\S]*?\} from '\.\/gpu-shaders\.ts'/);
  assert.doesNotMatch(engineSource, /UPLOAD_COMPOSITE_FRAGMENT_SHADER/);
  assert.doesNotMatch(engineSource, /POST_FRAGMENT_SHADER/);
  assert.doesNotMatch(engineSource, /BLIT_FRAGMENT_SHADER/);
});

test('gpu-filter.ts blit command passes new uniforms', () => {
  assert.match(engineSource, /sourceTexture: regl\.prop\('sourceTexture'\)/);
  assert.match(engineSource, /resultTexture: regl\.prop\('resultTexture'\)/);
  assert.match(engineSource, /previewBackground: regl\.prop\('previewBackground'\)/);
  assert.match(engineSource, /showOriginal: regl\.prop\('showOriginal'\)/);
  assert.doesNotMatch(engineSource, /completedSrgbTexture/);
});

test('gpu-filter.ts post command passes the new uniforms', () => {
  assert.match(engineSource, /posterization: regl\.prop\('posterization'\)/);
  assert.match(engineSource, /ribLowLuminanceValueScale: regl\.prop\('ribLowLuminanceValueScale'\)/);
  assert.match(engineSource, /ribHighLuminanceValueScale: regl\.prop\('ribHighLuminanceValueScale'\)/);
  assert.match(engineSource, /ribLowLuminanceSaturationScale: regl\.prop\('ribLowLuminanceSaturationScale'\)/);
  assert.match(engineSource, /ribHighLuminanceSaturationScale: regl\.prop\('ribHighLuminanceSaturationScale'\)/);
  assert.doesNotMatch(engineSource, /ribLowLuminanceColor: regl\.prop/);
  assert.doesNotMatch(engineSource, /ribHighLuminanceColor: regl\.prop/);
});

test('all shader modules have valid export structure', () => {
  assert.match(source, /export const FULLSCREEN_VERTEX_SHADER: string = `/);
  assert.match(source, /export const SOURCE_SHADER: string = `/);
  assert.match(source, /export const BLOCK_REDUCTION_FRAGMENT_SHADER: string = `/);
  assert.match(source, /export const POST_SHADER: string = `/);
  assert.match(source, /export const DISPLAY_SHADER: string = `/);
  assert.match(reductionSource, /export const TILE_SUM_SHADER: string = `/);
  assert.match(reductionSource, /export const BLOCK_REDUCTION_SHADER: string = `/);
});
// ── Acceptance criteria: Task 6 — rib-dominant photo-adaptive post pipeline ──
test('rib luminance and HSV derive from block color, not scene source', () => {
  assert.match(post, /ribCenterBlock/);
  assert.match(post, /sampleBlock\(ribCenterBlock\)/);
  assert.doesNotMatch(post, /rgbToHsv\(ribSource\)/);
  assert.doesNotMatch(post, /ribSource = sampleScene\(ribCenterPoint\)/);
});

test('four-neighbor bloom uses exactly 4 sampleBlock calls with cardinal offsets', () => {
  assert.match(post, /sampleBlock\(block \+ vec2\(1\.0, 0\.0\)\)/);
  assert.match(post, /sampleBlock\(block - vec2\(1\.0, 0\.0\)\)/);
  assert.match(post, /sampleBlock\(block \+ vec2\(0\.0, 1\.0\)\)/);
  assert.match(post, /sampleBlock\(block - vec2\(0\.0, 1\.0\)\)/);
});

test('fringe has dual gate: gradientGate * ribEdgeGate with mix', () => {
  assert.match(post, /gradientGate/);
  assert.match(post, /ribEdgeGate/);
  assert.match(post, /fringeGate = gradientGate \* mix\(fringeMinimumRibEdgeContribution, 1\.0, ribEdgeGate\)/);
});

test('no strength uniform or scene-effect mix', () => {
  assert.doesNotMatch(post, /\bstrength\b/);
  assert.doesNotMatch(post, /mix\(scene, effect/);
});

test('no fixed rib luminance colors', () => {
  assert.doesNotMatch(post, /\bribLowLuminanceColor\b/);
  assert.doesNotMatch(post, /\bribHighLuminanceColor\b/);
});

test('alpha contract: zero-alpha guard and srgb output with block-average alpha', () => {
  assert.match(post, /blockAlpha <= 0\.0 \? vec4\(0\.0\)/);
  assert.match(post, /vec4\(outputSrgb, blockAlpha\)/);
});

test('HSV value and saturation scale uniforms are present and used', () => {
  assert.match(post, /\bribLowLuminanceValueScale\b/);
  assert.match(post, /\bribHighLuminanceValueScale\b/);
  assert.match(post, /\bribLowLuminanceSaturationScale\b/);
  assert.match(post, /\bribHighLuminanceSaturationScale\b/);
  assert.match(post, /ribHsv\.y \* ribSatScale/);
  assert.match(post, /ribHsv\.z \* ribValueScale/);
});
