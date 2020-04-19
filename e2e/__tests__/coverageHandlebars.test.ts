/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {readFileSync} from 'fs';
import * as path from 'path';
import wrap from 'jest-snapshot-serializer-raw';
import {cleanup, run} from '../Utils';
import runJest from '../runJest';

const dir = path.resolve(__dirname, '../coverage-handlebars');
const coverageDir = path.join(dir, 'coverage');

beforeAll(() => {
  cleanup(coverageDir);
});

it('code coverage for Handlebars', () => {
  run('yarn', dir);
  const result = runJest(dir, ['--coverage', '--no-cache']);

  expect(result.exitCode).toBe(0);
  expect(wrap(result.stdout)).toMatchSnapshot();

  const coverageMapFile = path.join(coverageDir, 'coverage-final.json');
  const coverageMap = JSON.parse(readFileSync(coverageMapFile, 'utf-8'));

  expect(
    Object.keys(coverageMap).map(filename => path.basename(filename)),
  ).toEqual(['greet.hbs']);
});
