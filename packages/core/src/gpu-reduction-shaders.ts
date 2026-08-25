/**
 * First-pass tile-sum shader: each fragment covers a 16×16 pixel tile,
 * accumulates linear RGB × alpha + alpha sum, outputs scaled by 1/256
 * to fit in an RGBA8 texture without clamping (back-scaled by 256 in
 * BLOCK_REDUCTION_SHADER).
 */
export const TILE_SUM_SHADER: string = `#version 300 es
precision highp float;

uniform sampler2D sceneTexture;
uniform vec2 sceneResolution;

out vec4 outColor;

void main() {
    ivec2 tileOrigin = ivec2(gl_FragCoord.xy) * 16;
    vec3 sumRgb = vec3(0.0);
    float sumAlpha = 0.0;

    for (int y = 0; y < 16; y++) {
        for (int x = 0; x < 16; x++) {
            ivec2 pixel = tileOrigin + ivec2(x, y);
            if (pixel.x < int(sceneResolution.x) && pixel.y < int(sceneResolution.y)) {
                vec4 texel = texelFetch(sceneTexture, pixel, 0);
                vec3 linear = texel.rgb;
                sumRgb += linear * texel.a;
                sumAlpha += texel.a;
            }
        }
    }

    // Scale by 1/256 (16×16) to stay within RGBA8 [0,1] range.
    // BLOCK_REDUCTION_SHADER multiplies by 256.0 on read.
    outColor = vec4(sumRgb, sumAlpha) / 256.0;
}
`;

/**
 * Second-pass block-reduction shader: reduces a block of pixels (blockSize²)
 * to a single average. For blocks ≤ 16² reads source directly; for larger
 * blocks reads pre-computed tile sums and falls back to source on tile
 * boundaries. Outputs unpremultiplied linear RGB + average alpha.
 */
export const BLOCK_REDUCTION_SHADER: string = `#version 300 es
precision highp float;

uniform sampler2D sceneTexture;
uniform sampler2D tileSumTexture;
uniform vec2 sceneResolution;
uniform float blockSize;

out vec4 outColor;

void main() {
    ivec2 blockIdx = ivec2(gl_FragCoord.xy);
    int bs = int(blockSize);
    ivec2 blockOrigin = blockIdx * bs;
    ivec2 srcRes = ivec2(sceneResolution);
    ivec2 blockEnd = min(blockOrigin + bs, srcRes);

    vec3 sumRgb = vec3(0.0);
    float sumAlpha = 0.0;

    if (bs <= 16) {
        for (int y = blockOrigin.y; y < blockEnd.y; y++) {
            for (int x = blockOrigin.x; x < blockEnd.x; x++) {
                vec4 texel = texelFetch(sceneTexture, ivec2(x, y), 0);
                vec3 linear = texel.rgb;
                sumRgb += linear * texel.a;
                sumAlpha += texel.a;
            }
        }
    } else {
        ivec2 tileStart = blockOrigin / 16;
        ivec2 tileEnd = (blockEnd - 1) / 16;

        for (int ty = tileStart.y; ty <= tileEnd.y; ty++) {
            for (int tx = tileStart.x; tx <= tileEnd.x; tx++) {
                ivec2 tileMin = ivec2(tx * 16, ty * 16);
                ivec2 tileMax = min(tileMin + 16, srcRes);

                if (tileMin.x >= blockOrigin.x && tileMin.y >= blockOrigin.y &&
                    tileMax.x <= blockEnd.x && tileMax.y <= blockEnd.y) {
                    // Tile sum is stored normalized (1/256) to fit RGBA8; rescale to recover the raw sum.
                    vec4 ts = texelFetch(tileSumTexture, ivec2(tx, ty), 0);
                    sumRgb += ts.rgb * 256.0;
                    sumAlpha += ts.a * 256.0;
                } else {
                    ivec2 loopStart = max(tileMin, blockOrigin);
                    ivec2 loopEnd = min(tileMax, blockEnd);
                    for (int y = loopStart.y; y < loopEnd.y; y++) {
                        for (int x = loopStart.x; x < loopEnd.x; x++) {
                            vec4 texel = texelFetch(sceneTexture, ivec2(x, y), 0);
                            vec3 linear = texel.rgb;
                            sumRgb += linear * texel.a;
                            sumAlpha += texel.a;
                        }
                    }
                }
            }
        }
    }

    if (sumAlpha <= 0.0) {
        outColor = vec4(0.0);
        return;
    }

    // Denominator is the actual block area, so blocks clipped by the image
    // edge keep full alpha when every covered pixel is opaque.
    float blockArea = float((blockEnd.x - blockOrigin.x) * (blockEnd.y - blockOrigin.y));
    outColor = vec4(sumRgb / sumAlpha, sumAlpha / blockArea);
}
`;