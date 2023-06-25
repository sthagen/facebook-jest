/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
'use strict';

const {promisify} = require('util');

beforeEach(async () => {
  Promise.reject(new Error('REJECTED'));

  await promisify(setTimeout)(0);
});

test('foo #1', () => {});

test('foo #2', () => {});
