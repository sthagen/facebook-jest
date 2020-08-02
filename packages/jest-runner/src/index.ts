/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {Config} from '@jest/types';
import type {SerializableError, TestResult} from '@jest/test-result';
import exit = require('exit');
import chalk = require('chalk');
import Emittery = require('emittery');
import throat from 'throat';
import Worker, {PromiseWithCustomMessage} from 'jest-worker';
import {deepCyclicCopy} from 'jest-util';
import runTest from './runTest';
import type {SerializableResolver, worker} from './testWorker';
import type {
  OnTestFailure as JestOnTestFailure,
  OnTestStart as JestOnTestStart,
  OnTestSuccess as JestOnTestSuccess,
  Test as JestTest,
  TestEvents as JestTestEvents,
  TestFileEvent as JestTestFileEvent,
  TestRunnerContext as JestTestRunnerContext,
  TestRunnerOptions as JestTestRunnerOptions,
  TestWatcher as JestTestWatcher,
  WatcherState,
} from './types';

const TEST_WORKER_PATH = require.resolve('./testWorker');

interface WorkerInterface extends Worker {
  worker: typeof worker;
}

namespace TestRunner {
  export type Test = JestTest;
  export type OnTestFailure = JestOnTestFailure;
  export type OnTestStart = JestOnTestStart;
  export type OnTestSuccess = JestOnTestSuccess;
  export type TestWatcher = JestTestWatcher;
  export type TestRunnerContext = JestTestRunnerContext;
  export type TestRunnerOptions = JestTestRunnerOptions;
  export type TestFileEvent = JestTestFileEvent;
}

/* eslint-disable-next-line no-redeclare */
class TestRunner {
  private readonly _globalConfig: Config.GlobalConfig;
  private readonly _context: JestTestRunnerContext;
  private readonly eventEmitter = new Emittery.Typed<JestTestEvents>();
  readonly __PRIVATE_UNSTABLE_API_supportsEventEmitters__: boolean = true;

  readonly isSerial?: boolean;

  constructor(
    globalConfig: Config.GlobalConfig,
    context?: JestTestRunnerContext,
  ) {
    this._globalConfig = globalConfig;
    this._context = context || {};
  }

  async runTests(
    tests: Array<JestTest>,
    watcher: JestTestWatcher,
    onStart: JestOnTestStart | undefined,
    onResult: JestOnTestSuccess | undefined,
    onFailure: JestOnTestFailure | undefined,
    options: JestTestRunnerOptions,
  ): Promise<void> {
    return await (options.serial
      ? this._createInBandTestRun(tests, watcher, onStart, onResult, onFailure)
      : this._createParallelTestRun(
          tests,
          watcher,
          onStart,
          onResult,
          onFailure,
        ));
  }

  private async _createInBandTestRun(
    tests: Array<JestTest>,
    watcher: JestTestWatcher,
    onStart?: JestOnTestStart,
    onResult?: JestOnTestSuccess,
    onFailure?: JestOnTestFailure,
  ) {
    process.env.JEST_WORKER_ID = '1';
    const mutex = throat(1);
    return tests.reduce(
      (promise, test) =>
        mutex(() =>
          promise
            .then(async () => {
              if (watcher.isInterrupted()) {
                throw new CancelRun();
              }
              let sendMessageToJest: JestTestFileEvent;

              // Remove `if(onStart)` in Jest 27
              if (onStart) {
                await onStart(test);
                return runTest(
                  test.path,
                  this._globalConfig,
                  test.context.config,
                  test.context.resolver,
                  this._context,
                  undefined,
                );
              } else {
                // `deepCyclicCopy` used here to avoid mem-leak
                sendMessageToJest = (eventName, args) =>
                  this.eventEmitter.emit(
                    eventName,
                    deepCyclicCopy(args, {keepPrototype: false}),
                  );

                await this.eventEmitter.emit('test-file-start', [test]);
                return runTest(
                  test.path,
                  this._globalConfig,
                  test.context.config,
                  test.context.resolver,
                  this._context,
                  sendMessageToJest,
                );
              }
            })
            .then(result => {
              if (onResult) {
                return onResult(test, result);
              } else {
                return this.eventEmitter.emit('test-file-success', [
                  test,
                  result,
                ]);
              }
            })
            .catch(err => {
              if (onFailure) {
                return onFailure(test, err);
              } else {
                return this.eventEmitter.emit('test-file-failure', [test, err]);
              }
            }),
        ),
      Promise.resolve(),
    );
  }

  private async _createParallelTestRun(
    tests: Array<JestTest>,
    watcher: JestTestWatcher,
    onStart?: JestOnTestStart,
    onResult?: JestOnTestSuccess,
    onFailure?: JestOnTestFailure,
  ) {
    const resolvers: Map<string, SerializableResolver> = new Map();
    for (const test of tests) {
      if (!resolvers.has(test.context.config.name)) {
        resolvers.set(test.context.config.name, {
          config: test.context.config,
          serializableModuleMap: test.context.moduleMap.toJSON(),
        });
      }
    }

    const worker = new Worker(TEST_WORKER_PATH, {
      exposedMethods: ['worker'],
      forkOptions: {stdio: 'pipe'},
      maxRetries: 3,
      numWorkers: this._globalConfig.maxWorkers,
      setupArgs: [
        {
          serializableResolvers: Array.from(resolvers.values()),
        },
      ],
    }) as WorkerInterface;

    if (worker.getStdout()) worker.getStdout().pipe(process.stdout);
    if (worker.getStderr()) worker.getStderr().pipe(process.stderr);

    const mutex = throat(this._globalConfig.maxWorkers);

    // Send test suites to workers continuously instead of all at once to track
    // the start time of individual tests.
    const runTestInWorker = (test: JestTest) =>
      mutex(async () => {
        if (watcher.isInterrupted()) {
          return Promise.reject();
        }

        // Remove `if(onStart)` in Jest 27
        if (onStart) {
          await onStart(test);
        } else {
          await this.eventEmitter.emit('test-file-start', [test]);
        }

        const promise = worker.worker({
          config: test.context.config,
          context: {
            ...this._context,
            changedFiles:
              this._context.changedFiles &&
              Array.from(this._context.changedFiles),
            sourcesRelatedToTestsInChangedFiles:
              this._context.sourcesRelatedToTestsInChangedFiles &&
              Array.from(this._context.sourcesRelatedToTestsInChangedFiles),
          },
          globalConfig: this._globalConfig,
          path: test.path,
        }) as PromiseWithCustomMessage<TestResult>;

        if (promise.UNSTABLE_onCustomMessage) {
          // TODO: Get appropriate type for `onCustomMessage`
          promise.UNSTABLE_onCustomMessage(([event, payload]: any) => {
            this.eventEmitter.emit(event, payload);
          });
        }

        return promise;
      });

    const onError = async (err: SerializableError, test: JestTest) => {
      // Remove `if(onFailure)` in Jest 27
      if (onFailure) {
        await onFailure(test, err);
      } else {
        await this.eventEmitter.emit('test-file-failure', [test, err]);
      }
      if (err.type === 'ProcessTerminatedError') {
        console.error(
          'A worker process has quit unexpectedly! ' +
            'Most likely this is an initialization error.',
        );
        exit(1);
      }
    };

    const onInterrupt = new Promise((_, reject) => {
      watcher.on('change', (state: WatcherState) => {
        if (state.interrupted) {
          reject(new CancelRun());
        }
      });
    });

    const runAllTests = Promise.all(
      tests.map(test =>
        runTestInWorker(test)
          .then(result => {
            if (onResult) {
              return onResult(test, result);
            } else {
              return this.eventEmitter.emit('test-file-success', [
                test,
                result,
              ]);
            }
          })
          .catch(error => onError(error, test)),
      ),
    );

    const cleanup = async () => {
      const {forceExited} = await worker.end();
      if (forceExited) {
        console.error(
          chalk.yellow(
            'A worker process has failed to exit gracefully and has been force exited. ' +
              'This is likely caused by tests leaking due to improper teardown. ' +
              'Try running with --runInBand --detectOpenHandles to find leaks.',
          ),
        );
      }
    };
    return Promise.race([runAllTests, onInterrupt]).then(cleanup, cleanup);
  }

  on = this.eventEmitter.on.bind(this.eventEmitter);
}

class CancelRun extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'CancelRun';
  }
}

export = TestRunner;
