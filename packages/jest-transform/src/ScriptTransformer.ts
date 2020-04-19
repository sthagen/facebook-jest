/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {createHash} from 'crypto';
import * as path from 'path';
import type {Config} from '@jest/types';
import {createDirectory, interopRequireDefault, isPromise} from 'jest-util';
import * as fs from 'graceful-fs';
import {transformSync as babelTransform} from '@babel/core';
// @ts-ignore: should just be `require.resolve`, but the tests mess that up
import babelPluginIstanbul from 'babel-plugin-istanbul';
import {fromSource as sourcemapFromSource} from 'convert-source-map';
import HasteMap = require('jest-haste-map');
import stableStringify = require('fast-json-stable-stringify');
import slash = require('slash');
import {sync as writeFileAtomic} from 'write-file-atomic';
import {sync as realpath} from 'realpath-native';
import {addHook} from 'pirates';
import type {
  Options,
  TransformResult,
  TransformedSource,
  Transformer,
} from './types';
import shouldInstrument from './shouldInstrument';
import handlePotentialSyntaxError from './enhanceUnexpectedTokenMessage';

type ProjectCache = {
  configString: string;
  ignorePatternsRegExp?: RegExp;
  transformRegExp?: Array<[RegExp, string, Record<string, unknown>]>;
  transformedFiles: Map<string, TransformResult>;
};

// Use `require` to avoid TS rootDir
const {version: VERSION} = require('../package.json');

// This data structure is used to avoid recalculating some data every time that
// we need to transform a file. Since ScriptTransformer is instantiated for each
// file we need to keep this object in the local scope of this module.
const projectCaches = new Map<string, ProjectCache>();

// To reset the cache for specific changesets (rather than package version).
const CACHE_VERSION = '1';

async function waitForPromiseWithCleanup(
  promise: Promise<any>,
  cleanup: () => void,
) {
  try {
    await promise;
  } finally {
    cleanup();
  }
}

export default class ScriptTransformer {
  private _cache: ProjectCache;
  private _config: Config.ProjectConfig;
  private _transformCache: Map<Config.Path, Transformer>;
  private _transformConfigCache: Map<Config.Path, unknown>;

  constructor(config: Config.ProjectConfig) {
    this._config = config;
    this._transformCache = new Map();
    this._transformConfigCache = new Map();

    const configString = stableStringify(this._config);
    let projectCache = projectCaches.get(configString);

    if (!projectCache) {
      projectCache = {
        configString,
        ignorePatternsRegExp: calcIgnorePatternRegExp(this._config),
        transformRegExp: calcTransformRegExp(this._config),
        transformedFiles: new Map(),
      };

      projectCaches.set(configString, projectCache);
    }

    this._cache = projectCache;
  }

  private _getCacheKey(
    fileData: string,
    filename: Config.Path,
    instrument: boolean,
    supportsDynamicImport: boolean,
    supportsStaticESM: boolean,
  ): string {
    const configString = this._cache.configString;
    const transformer = this._getTransformer(filename);

    if (transformer && typeof transformer.getCacheKey === 'function') {
      return createHash('md5')
        .update(
          transformer.getCacheKey(fileData, filename, configString, {
            config: this._config,
            instrument,
            rootDir: this._config.rootDir,
            supportsDynamicImport,
            supportsStaticESM,
          }),
        )
        .update(CACHE_VERSION)
        .digest('hex');
    } else {
      return createHash('md5')
        .update(fileData)
        .update(configString)
        .update(instrument ? 'instrument' : '')
        .update(filename)
        .update(CACHE_VERSION)
        .digest('hex');
    }
  }

  private _getFileCachePath(
    filename: Config.Path,
    content: string,
    instrument: boolean,
    supportsDynamicImport: boolean,
    supportsStaticESM: boolean,
  ): Config.Path {
    const baseCacheDir = HasteMap.getCacheFilePath(
      this._config.cacheDirectory,
      'jest-transform-cache-' + this._config.name,
      VERSION,
    );
    const cacheKey = this._getCacheKey(
      content,
      filename,
      instrument,
      supportsDynamicImport,
      supportsStaticESM,
    );
    // Create sub folders based on the cacheKey to avoid creating one
    // directory with many files.
    const cacheDir = path.join(baseCacheDir, cacheKey[0] + cacheKey[1]);
    const cacheFilenamePrefix = path
      .basename(filename, path.extname(filename))
      .replace(/\W/g, '');
    const cachePath = slash(
      path.join(cacheDir, cacheFilenamePrefix + '_' + cacheKey),
    );
    createDirectory(cacheDir);

    return cachePath;
  }

  private _getTransformPath(filename: Config.Path) {
    const transformRegExp = this._cache.transformRegExp;
    if (!transformRegExp) {
      return undefined;
    }

    for (let i = 0; i < transformRegExp.length; i++) {
      if (transformRegExp[i][0].test(filename)) {
        const transformPath = transformRegExp[i][1];
        this._transformConfigCache.set(transformPath, transformRegExp[i][2]);

        return transformPath;
      }
    }

    return undefined;
  }

  private _getTransformer(filename: Config.Path) {
    let transform: Transformer | null = null;
    if (!this._config.transform || !this._config.transform.length) {
      return null;
    }

    const transformPath = this._getTransformPath(filename);
    if (transformPath) {
      const transformer = this._transformCache.get(transformPath);
      if (transformer != null) {
        return transformer;
      }

      transform = require(transformPath);

      if (!transform) {
        throw new TypeError('Jest: a transform must export something.');
      }
      const transformerConfig = this._transformConfigCache.get(transformPath);
      if (typeof transform.createTransformer === 'function') {
        transform = transform.createTransformer(transformerConfig);
      }
      if (typeof transform.process !== 'function') {
        throw new TypeError(
          'Jest: a transform must export a `process` function.',
        );
      }
      this._transformCache.set(transformPath, transform);
    }
    return transform;
  }

  private _instrumentFile(
    filename: Config.Path,
    content: string,
    supportsDynamicImport: boolean,
    supportsStaticESM: boolean,
  ): string {
    const result = babelTransform(content, {
      auxiliaryCommentBefore: ' istanbul ignore next ',
      babelrc: false,
      caller: {
        name: '@jest/transform',
        supportsDynamicImport,
        supportsStaticESM,
      },
      configFile: false,
      filename,
      plugins: [
        [
          babelPluginIstanbul,
          {
            compact: false,
            // files outside `cwd` will not be instrumented
            cwd: this._config.rootDir,
            exclude: [],
            extension: false,
            useInlineSourceMaps: false,
          },
        ],
      ],
    });

    if (result) {
      const {code} = result;

      if (code) {
        return code;
      }
    }

    return content;
  }

  private _getRealPath(filepath: Config.Path): Config.Path {
    try {
      return realpath(filepath) || filepath;
    } catch (err) {
      return filepath;
    }
  }

  // We don't want to expose transformers to the outside - this function is just
  // to warm up `this._transformCache`
  preloadTransformer(filepath: Config.Path): void {
    this._getTransformer(filepath);
  }

  // TODO: replace third argument with TransformOptions in Jest 26
  transformSource(
    filepath: Config.Path,
    content: string,
    instrument: boolean,
    supportsDynamicImport = false,
    supportsStaticESM = false,
  ): TransformResult {
    const filename = this._getRealPath(filepath);
    const transform = this._getTransformer(filename);
    const cacheFilePath = this._getFileCachePath(
      filename,
      content,
      instrument,
      supportsDynamicImport,
      supportsStaticESM,
    );
    let sourceMapPath: Config.Path | null = cacheFilePath + '.map';
    // Ignore cache if `config.cache` is set (--no-cache)
    let code = this._config.cache ? readCodeCacheFile(cacheFilePath) : null;

    const shouldCallTransform = transform && this.shouldTransform(filename);

    // That means that the transform has a custom instrumentation
    // logic and will handle it based on `config.collectCoverage` option
    const transformWillInstrument =
      shouldCallTransform && transform && transform.canInstrument;

    // If we handle the coverage instrumentation, we should try to map code
    // coverage against original source with any provided source map
    const mapCoverage = instrument && !transformWillInstrument;

    if (code) {
      // This is broken: we return the code, and a path for the source map
      // directly from the cache. But, nothing ensures the source map actually
      // matches that source code. They could have gotten out-of-sync in case
      // two separate processes write concurrently to the same cache files.
      return {
        code,
        mapCoverage,
        originalCode: content,
        sourceMapPath,
      };
    }

    let transformed: TransformedSource = {
      code: content,
      map: null,
    };

    if (transform && shouldCallTransform) {
      const processed = transform.process(content, filename, this._config, {
        instrument,
        supportsDynamicImport,
        supportsStaticESM,
      });

      if (typeof processed === 'string') {
        transformed.code = processed;
      } else if (processed != null && typeof processed.code === 'string') {
        transformed = processed;
      } else {
        throw new TypeError(
          "Jest: a transform's `process` function must return a string, " +
            'or an object with `code` key containing this string.',
        );
      }
    }

    if (!transformed.map) {
      try {
        //Could be a potential freeze here.
        //See: https://github.com/facebook/jest/pull/5177#discussion_r158883570
        const inlineSourceMap = sourcemapFromSource(transformed.code);

        if (inlineSourceMap) {
          transformed.map = inlineSourceMap.toJSON();
        }
      } catch (e) {
        const transformPath = this._getTransformPath(filename);
        console.warn(
          `jest-transform: The source map produced for the file ${filename} ` +
            `by ${transformPath} was invalid. Proceeding without source ` +
            'mapping for that file.',
        );
      }
    }

    if (!transformWillInstrument && instrument) {
      code = this._instrumentFile(
        filename,
        transformed.code,
        supportsDynamicImport,
        supportsStaticESM,
      );
    } else {
      code = transformed.code;
    }

    if (transformed.map) {
      const sourceMapContent =
        typeof transformed.map === 'string'
          ? transformed.map
          : JSON.stringify(transformed.map);
      writeCacheFile(sourceMapPath, sourceMapContent);
    } else {
      sourceMapPath = null;
    }

    writeCodeCacheFile(cacheFilePath, code);

    return {
      code,
      mapCoverage,
      originalCode: content,
      sourceMapPath,
    };
  }

  private _transformAndBuildScript(
    filename: Config.Path,
    options: Options,
    instrument: boolean,
    fileSource?: string,
  ): TransformResult {
    const {
      isCoreModule,
      isInternalModule,
      supportsDynamicImport,
      supportsStaticESM,
    } = options;
    const content = stripShebang(
      fileSource || fs.readFileSync(filename, 'utf8'),
    );

    let code = content;
    let sourceMapPath: string | null = null;
    let mapCoverage = false;

    const willTransform =
      !isInternalModule &&
      !isCoreModule &&
      (this.shouldTransform(filename) || instrument);

    try {
      if (willTransform) {
        const transformedSource = this.transformSource(
          filename,
          content,
          instrument,
          supportsDynamicImport,
          supportsStaticESM,
        );

        code = transformedSource.code;
        sourceMapPath = transformedSource.sourceMapPath;
        mapCoverage = transformedSource.mapCoverage;
      }

      return {
        code,
        mapCoverage,
        originalCode: content,
        sourceMapPath,
      };
    } catch (e) {
      throw handlePotentialSyntaxError(e);
    }
  }

  transform(
    filename: Config.Path,
    options: Options,
    fileSource?: string,
  ): TransformResult {
    let scriptCacheKey = undefined;
    let instrument = false;

    if (!options.isCoreModule) {
      instrument =
        options.coverageProvider === 'babel' &&
        shouldInstrument(filename, options, this._config);
      scriptCacheKey = getScriptCacheKey(filename, instrument);
      const result = this._cache.transformedFiles.get(scriptCacheKey);
      if (result) {
        return result;
      }
    }

    const result = this._transformAndBuildScript(
      filename,
      options,
      instrument,
      fileSource,
    );

    if (scriptCacheKey) {
      this._cache.transformedFiles.set(scriptCacheKey, result);
    }

    return result;
  }

  transformJson(
    filename: Config.Path,
    options: Options,
    fileSource: string,
  ): string {
    const {
      isCoreModule,
      isInternalModule,
      supportsDynamicImport,
      supportsStaticESM,
    } = options;
    const willTransform =
      !isInternalModule && !isCoreModule && this.shouldTransform(filename);

    if (willTransform) {
      const {code: transformedJsonSource} = this.transformSource(
        filename,
        fileSource,
        false,
        supportsDynamicImport,
        supportsStaticESM,
      );
      return transformedJsonSource;
    }

    return fileSource;
  }

  requireAndTranspileModule<ModuleType = unknown>(
    moduleName: string,
    callback?: (module: ModuleType) => void,
  ): ModuleType;
  requireAndTranspileModule<ModuleType = unknown>(
    moduleName: string,
    callback?: (module: ModuleType) => Promise<void>,
  ): Promise<ModuleType>;
  requireAndTranspileModule<ModuleType = unknown>(
    moduleName: string,
    callback?: (module: ModuleType) => void | Promise<void>,
  ): ModuleType | Promise<ModuleType> {
    // Load the transformer to avoid a cycle where we need to load a
    // transformer in order to transform it in the require hooks
    this.preloadTransformer(moduleName);

    let transforming = false;
    const revertHook = addHook(
      (code, filename) => {
        try {
          transforming = true;
          return (
            // we might wanna do `supportsDynamicImport` at some point
            this.transformSource(filename, code, false, false, false).code ||
            code
          );
        } finally {
          transforming = false;
        }
      },
      {
        exts: this._config.moduleFileExtensions.map(ext => `.${ext}`),
        ignoreNodeModules: false,
        matcher: filename => {
          if (transforming) {
            // Don't transform any dependency required by the transformer itself
            return false;
          }
          return this.shouldTransform(filename);
        },
      },
    );
    const module: ModuleType = require(moduleName);

    if (!callback) {
      revertHook();

      return module;
    }

    try {
      const cbResult = callback(module);

      if (isPromise(cbResult)) {
        return waitForPromiseWithCleanup(cbResult, revertHook).then(
          () => module,
        );
      }
    } finally {
      revertHook();
    }

    return module;
  }

  /**
   * @deprecated use `this.shouldTransform` instead
   */
  // @ts-ignore: Unused and private - remove in Jest 25
  private _shouldTransform(filename: Config.Path): boolean {
    return this.shouldTransform(filename);
  }

  shouldTransform(filename: Config.Path): boolean {
    const ignoreRegexp = this._cache.ignorePatternsRegExp;
    const isIgnored = ignoreRegexp ? ignoreRegexp.test(filename) : false;

    return (
      !!this._config.transform && !!this._config.transform.length && !isIgnored
    );
  }
}

// TODO: do we need to define the generics twice?
export function createTranspilingRequire(
  config: Config.ProjectConfig,
): <TModuleType = unknown>(
  resolverPath: string,
  applyInteropRequireDefault?: boolean,
) => TModuleType {
  const transformer = new ScriptTransformer(config);

  return function requireAndTranspileModule<TModuleType = unknown>(
    resolverPath: string,
    applyInteropRequireDefault: boolean = false,
  ): TModuleType {
    const transpiledModule = transformer.requireAndTranspileModule<TModuleType>(
      resolverPath,
    );

    return applyInteropRequireDefault
      ? interopRequireDefault(transpiledModule).default
      : transpiledModule;
  };
}

const removeFile = (path: Config.Path) => {
  try {
    fs.unlinkSync(path);
  } catch (e) {}
};

const stripShebang = (content: string) => {
  // If the file data starts with a shebang remove it. Leaves the empty line
  // to keep stack trace line numbers correct.
  if (content.startsWith('#!')) {
    return content.replace(/^#!.*/, '');
  } else {
    return content;
  }
};

/**
 * This is like `writeCacheFile` but with an additional sanity checksum. We
 * cannot use the same technique for source maps because we expose source map
 * cache file paths directly to callsites, with the expectation they can read
 * it right away. This is not a great system, because source map cache file
 * could get corrupted, out-of-sync, etc.
 */
function writeCodeCacheFile(cachePath: Config.Path, code: string) {
  const checksum = createHash('md5').update(code).digest('hex');
  writeCacheFile(cachePath, checksum + '\n' + code);
}

/**
 * Read counterpart of `writeCodeCacheFile`. We verify that the content of the
 * file matches the checksum, in case some kind of corruption happened. This
 * could happen if an older version of `jest-runtime` writes non-atomically to
 * the same cache, for example.
 */
function readCodeCacheFile(cachePath: Config.Path): string | null {
  const content = readCacheFile(cachePath);
  if (content == null) {
    return null;
  }
  const code = content.substr(33);
  const checksum = createHash('md5').update(code).digest('hex');
  if (checksum === content.substr(0, 32)) {
    return code;
  }
  return null;
}

/**
 * Writing to the cache atomically relies on 'rename' being atomic on most
 * file systems. Doing atomic write reduces the risk of corruption by avoiding
 * two processes to write to the same file at the same time. It also reduces
 * the risk of reading a file that's being overwritten at the same time.
 */
const writeCacheFile = (cachePath: Config.Path, fileData: string) => {
  try {
    writeFileAtomic(cachePath, fileData, {encoding: 'utf8', fsync: false});
  } catch (e) {
    if (cacheWriteErrorSafeToIgnore(e, cachePath)) {
      return;
    }

    e.message =
      'jest: failed to cache transform results in: ' +
      cachePath +
      '\nFailure message: ' +
      e.message;
    removeFile(cachePath);
    throw e;
  }
};

/**
 * On Windows, renames are not atomic, leading to EPERM exceptions when two
 * processes attempt to rename to the same target file at the same time.
 * If the target file exists we can be reasonably sure another process has
 * legitimately won a cache write race and ignore the error.
 */
const cacheWriteErrorSafeToIgnore = (
  e: Error & {code: string},
  cachePath: Config.Path,
) =>
  process.platform === 'win32' &&
  e.code === 'EPERM' &&
  fs.existsSync(cachePath);

const readCacheFile = (cachePath: Config.Path): string | null => {
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  let fileData;
  try {
    fileData = fs.readFileSync(cachePath, 'utf8');
  } catch (e) {
    e.message =
      'jest: failed to read cache file: ' +
      cachePath +
      '\nFailure message: ' +
      e.message;
    removeFile(cachePath);
    throw e;
  }

  if (fileData == null) {
    // We must have somehow created the file but failed to write to it,
    // let's delete it and retry.
    removeFile(cachePath);
  }
  return fileData;
};

const getScriptCacheKey = (filename: Config.Path, instrument: boolean) => {
  const mtime = fs.statSync(filename).mtime;
  return filename + '_' + mtime.getTime() + (instrument ? '_instrumented' : '');
};

const calcIgnorePatternRegExp = (config: Config.ProjectConfig) => {
  if (
    !config.transformIgnorePatterns ||
    config.transformIgnorePatterns.length === 0
  ) {
    return undefined;
  }

  return new RegExp(config.transformIgnorePatterns.join('|'));
};

const calcTransformRegExp = (config: Config.ProjectConfig) => {
  if (!config.transform.length) {
    return undefined;
  }

  const transformRegexp: Array<[RegExp, string, Record<string, unknown>]> = [];
  for (let i = 0; i < config.transform.length; i++) {
    transformRegexp.push([
      new RegExp(config.transform[i][0]),
      config.transform[i][1],
      config.transform[i][2],
    ]);
  }

  return transformRegexp;
};
