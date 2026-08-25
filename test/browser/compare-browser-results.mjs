import { readFile } from 'node:fs/promises';
import path from 'node:path';

const RESULT_DIRECTORY = path.resolve('test-results');
const PROJECTS = ['chromium', 'firefox', 'webkit'];
const MAX_RGB_MAE = 4;
const MAX_RGB_P99 = 20;

async function readResult(project) {
  const filename = path.join(RESULT_DIRECTORY, `cross-browser-${project}.json`);
  let encoded;
  try {
    encoded = await readFile(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Missing ${project} result artifact: ${filename}. Run its Playwright project before comparing.`);
    throw error;
  }

  let result;
  try {
    result = JSON.parse(encoded);
  } catch {
    throw new Error(`Invalid ${project} result artifact: ${filename}.`);
  }
  const data = Buffer.from(result.rgbaBase64, 'base64');
  if (!Number.isInteger(result.width) || !Number.isInteger(result.height) || result.width < 1 || result.height < 1 || data.length !== result.width * result.height * 4) {
    throw new Error(`Invalid ${project} result artifact dimensions or RGBA data: ${filename}.`);
  }
  return { project, ...result, data };
}

function percentile99(errors) {
  const sorted = [...errors].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.99) - 1];
}

function compare(reference, candidate) {
  if (candidate.width !== reference.width || candidate.height !== reference.height) {
    throw new Error(`${candidate.project} dimensions ${candidate.width}x${candidate.height} do not match Chromium ${reference.width}x${reference.height}.`);
  }

  const errors = [];
  let total = 0;
  let maximum = -1;
  let worst = { x: 0, y: 0, channel: 'R', reference: 0, actual: 0 };
  for (let offset = 0; offset < reference.data.length; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const error = Math.abs(reference.data[offset + channel] - candidate.data[offset + channel]);
      errors.push(error);
      total += error;
      if (error > maximum) {
        maximum = error;
        worst = {
          x: (offset / 4) % reference.width,
          y: Math.floor(offset / 4 / reference.width),
          channel: 'RGB'[channel],
          reference: reference.data[offset + channel],
          actual: candidate.data[offset + channel],
        };
      }
    }
  }
  const mae = total / errors.length;
  const p99 = percentile99(errors);
  const diagnostic = `${candidate.project} vs chromium: MAE=${mae.toFixed(3)}, P99=${p99}, max=${maximum}, worst=(${worst.x},${worst.y}) ${worst.channel}: chromium=${worst.reference}, ${candidate.project}=${worst.actual}`;
  if (mae > MAX_RGB_MAE || p99 > MAX_RGB_P99) {
    throw new Error(`Cross-browser RGB tolerance exceeded (${diagnostic}; limits: MAE <= ${MAX_RGB_MAE}, P99 <= ${MAX_RGB_P99}).`);
  }
  return diagnostic;
}

const results = await Promise.all(PROJECTS.map(readResult));
const chromium = results[0];
for (const result of results.slice(1)) console.log(compare(chromium, result));
