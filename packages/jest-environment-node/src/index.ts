/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {Context, Script, createContext, runInContext} from 'vm';
import type {Config, Global} from '@jest/types';
import {ModuleMocker} from 'jest-mock';
import {installCommonGlobals} from 'jest-util';
import {
  JestFakeTimers as LegacyFakeTimers,
  LolexFakeTimers,
} from '@jest/fake-timers';
import type {JestEnvironment} from '@jest/environment';
import {lt as semverLt} from 'semver';

type Timer = {
  id: number;
  ref: () => Timer;
  unref: () => Timer;
};

class NodeEnvironment implements JestEnvironment {
  context: Context | null;
  fakeTimers: LegacyFakeTimers<Timer> | null;
  fakeTimersLolex: LolexFakeTimers | null;
  global: Global.Global;
  moduleMocker: ModuleMocker | null;

  constructor(config: Config.ProjectConfig) {
    this.context = createContext();
    const global = (this.global = runInContext(
      'this',
      Object.assign(this.context, config.testEnvironmentOptions),
    ));
    global.global = global;
    global.clearInterval = clearInterval;
    global.clearTimeout = clearTimeout;
    global.setInterval = setInterval;
    global.setTimeout = setTimeout;
    global.ArrayBuffer = ArrayBuffer;
    // TextEncoder (global or via 'util') references a Uint8Array constructor
    // different than the global one used by users in tests. This makes sure the
    // same constructor is referenced by both.
    global.Uint8Array = Uint8Array;

    // URL and URLSearchParams are global in Node >= 10
    if (typeof URL !== 'undefined' && typeof URLSearchParams !== 'undefined') {
      global.URL = URL;
      global.URLSearchParams = URLSearchParams;
    }
    // TextDecoder and TextDecoder are global in Node >= 11
    if (
      typeof TextEncoder !== 'undefined' &&
      typeof TextDecoder !== 'undefined'
    ) {
      global.TextEncoder = TextEncoder;
      global.TextDecoder = TextDecoder;
    }
    // queueMicrotask is global in Node >= 11
    if (typeof queueMicrotask !== 'undefined') {
      global.queueMicrotask = queueMicrotask;
    }
    installCommonGlobals(global, config.globals);
    this.moduleMocker = new ModuleMocker(global);

    const timerIdToRef = (id: number) => ({
      id,
      ref() {
        return this;
      },
      unref() {
        return this;
      },
    });

    const timerRefToId = (timer: Timer): number | undefined =>
      (timer && timer.id) || undefined;

    const timerConfig = {
      idToRef: timerIdToRef,
      refToId: timerRefToId,
    };

    this.fakeTimers = new LegacyFakeTimers({
      config,
      global,
      moduleMocker: this.moduleMocker,
      timerConfig,
    });

    this.fakeTimersLolex = new LolexFakeTimers({config, global});
  }

  async setup(): Promise<void> {}

  async teardown(): Promise<void> {
    if (this.fakeTimers) {
      this.fakeTimers.dispose();
    }
    if (this.fakeTimersLolex) {
      this.fakeTimersLolex.dispose();
    }
    this.context = null;
    this.fakeTimers = null;
    this.fakeTimersLolex = null;
  }

  // TS infers the return type to be `any`, since that's what `runInContext`
  // returns.
  runScript<T = unknown>(script: Script): T | null {
    if (this.context) {
      return script.runInContext(this.context);
    }
    return null;
  }

  getVmContext(): Context | null {
    return this.context;
  }
}

// node 10 had a bug in `vm.compileFunction` that was fixed in https://github.com/nodejs/node/pull/23206.
// Let's just pretend the env doesn't support the function.
// Make sure engine requirement is high enough when we drop node 8 so we can remove this condition
if (semverLt(process.version, '10.14.2')) {
  delete NodeEnvironment.prototype.getVmContext;
}

export = NodeEnvironment;
