/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { BuilderContext, createBuilder } from '@angular-devkit/architect/src/index2';
import {
  WebpackLoggingCallback,
  runWebpack,
} from '@angular-devkit/build-webpack/src/webpack/index2';
import {
  Path,
  experimental,
  getSystemPath,
  join,
  json,
  logging,
  normalize,
  resolve,
  schema,
  virtualFs,
} from '@angular-devkit/core';
import { NodeJsSyncHost } from '@angular-devkit/core/node';
import * as fs from 'fs';
import { EMPTY, from, of } from 'rxjs';
import { concatMap, last, map, switchMap } from 'rxjs/operators';
import * as ts from 'typescript'; // tslint:disable-line:no-implicit-dependencies
import { WebpackConfigOptions } from '../angular-cli-files/models/build-options';
import {
  getAotConfig,
  getBrowserConfig,
  getCommonConfig,
  getNonAotConfig,
  getStatsConfig,
  getStylesConfig,
} from '../angular-cli-files/models/webpack-configs';
import { readTsconfig } from '../angular-cli-files/utilities/read-tsconfig';
import { requireProjectModule } from '../angular-cli-files/utilities/require-project-module';
import {
  statsErrorsToString,
  statsToString,
  statsWarningsToString,
} from '../angular-cli-files/utilities/stats';
import { NormalizedBrowserBuilderSchema, defaultProgress, normalizeBrowserSchema } from '../utils';
import { Schema as BrowserBuilderSchema } from './schema';

import webpack = require('webpack');
const SpeedMeasurePlugin = require('speed-measure-webpack-plugin');
const webpackMerge = require('webpack-merge');


function _deleteOutputDir(root: Path, outputPath: Path, host: virtualFs.Host) {
  const resolvedOutputPath = resolve(root, outputPath);
  if (resolvedOutputPath === root) {
    throw new Error('Output path MUST not be project root directory!');
  }

  return host.exists(resolvedOutputPath).pipe(
    concatMap(exists => exists ? host.delete(resolvedOutputPath) : EMPTY),
    last(null, null),
  );
}


export function createBrowserLoggingCallback(
  verbose: boolean,
  logger: logging.LoggerApi,
): WebpackLoggingCallback {
  return (stats, config) => {
    // config.stats contains our own stats settings, added during buildWebpackConfig().
    const json = stats.toJson(config.stats);
    if (verbose) {
      logger.info(stats.toString(config.stats));
    } else {
      logger.info(statsToString(json, config.stats));
    }

    if (stats.hasWarnings()) {
      logger.warn(statsWarningsToString(json, config.stats));
    }
    if (stats.hasErrors()) {
      logger.error(statsErrorsToString(json, config.stats));
    }
  };
}

export function buildWebpackConfig(
  root: Path,
  projectRoot: Path,
  host: virtualFs.Host<fs.Stats>,
  options: NormalizedBrowserBuilderSchema,
  logger: logging.LoggerApi,
): webpack.Configuration {
  // Ensure Build Optimizer is only used with AOT.
  if (options.buildOptimizer && !options.aot) {
    throw new Error(`The 'buildOptimizer' option cannot be used without 'aot'.`);
  }

  let wco: WebpackConfigOptions<NormalizedBrowserBuilderSchema>;

  const tsConfigPath = getSystemPath(normalize(resolve(root, normalize(options.tsConfig))));
  const tsConfig = readTsconfig(tsConfigPath);

  const projectTs = requireProjectModule(getSystemPath(projectRoot), 'typescript') as typeof ts;

  const supportES2015 = tsConfig.options.target !== projectTs.ScriptTarget.ES3
    && tsConfig.options.target !== projectTs.ScriptTarget.ES5;

  wco = {
    root: getSystemPath(root),
    logger: logger.createChild('webpackConfigOptions'),
    projectRoot: getSystemPath(projectRoot),
    buildOptions: options,
    tsConfig,
    tsConfigPath,
    supportES2015,
  };

  wco.buildOptions.progress = defaultProgress(wco.buildOptions.progress);

  const webpackConfigs: {}[] = [
    getCommonConfig(wco),
    getBrowserConfig(wco),
    getStylesConfig(wco),
    getStatsConfig(wco),
  ];

  if (wco.buildOptions.main || wco.buildOptions.polyfills) {
    const typescriptConfigPartial = wco.buildOptions.aot
      ? getAotConfig(wco, host)
      : getNonAotConfig(wco, host);
    webpackConfigs.push(typescriptConfigPartial);
  }

  const webpackConfig = webpackMerge(webpackConfigs);

  if (options.profile) {
    const smp = new SpeedMeasurePlugin({
      outputFormat: 'json',
      outputTarget: getSystemPath(join(root, 'speed-measure-plugin.json')),
    });

    return smp.wrap(webpackConfig);
  }

  return webpackConfig;
}


export async function buildBrowserWebpackConfigFromWorkspace(
  options: BrowserBuilderSchema,
  projectName: string,
  workspace: experimental.workspace.Workspace,
  host: virtualFs.Host<fs.Stats>,
  logger: logging.LoggerApi,
): Promise<webpack.Configuration> {
  // TODO: Use a better interface for workspace access.
  const projectRoot = resolve(workspace.root, normalize(workspace.getProject(projectName).root));
  const sourceRoot = workspace.getProject(projectName).sourceRoot;

  const normalizedOptions = normalizeBrowserSchema(
    host,
    workspace.root,
    projectRoot,
    sourceRoot ? resolve(workspace.root, normalize(sourceRoot)) : undefined,
    options,
  );

  return buildWebpackConfig(workspace.root, projectRoot, host, normalizedOptions, logger);
}


export async function buildBrowserWebpackConfigFromContext(
  options: BrowserBuilderSchema,
  context: BuilderContext,
  host: virtualFs.Host<fs.Stats>,
): Promise<webpack.Configuration> {
  const registry = new schema.CoreSchemaRegistry();
  registry.addPostTransform(schema.transforms.addUndefinedDefaults);

  const workspace = await experimental.workspace.Workspace.fromPath(
    host,
    normalize(context.workspaceRoot),
    registry,
  );

  const projectName = context.target ? context.target.project : workspace.getDefaultProjectName();

  if (!projectName) {
    throw new Error('Must either have a target from the context or a default project.');
  }

  return buildBrowserWebpackConfigFromWorkspace(
    options,
    projectName,
    workspace,
    host,
    context.logger,
  );
}


export default createBuilder<json.JsonObject & BrowserBuilderSchema>((options, context) => {
  const host = new NodeJsSyncHost();

  return from(buildBrowserWebpackConfigFromContext(options, context, host)).pipe(
    switchMap(config => {
      if (options.deleteOutputPath) {
        return _deleteOutputDir(
          normalize(context.workspaceRoot),
          normalize(options.outputPath),
          host,
        ).pipe(map(() => config));
      } else {
        return of(config);
      }
    }),
    switchMap(config => runWebpack(config, context, {
      logging: createBrowserLoggingCallback(!!options.verbose, context.logger),
    })),
  );
});
//
//
// export class BrowserBuilder implements Builder<BrowserBuilderSchema> {
//
//   constructor(public context: BuilderContext) { }
//
//   protected createWebpackBuilder(context: BuilderContext): WebpackBuilder {
//     return new WebpackBuilder(context);
//   }
//
//   protected createLoggingFactory(): (verbose: boolean) => LoggingCallback  {
//     return getBrowserLoggingCb;
//   }
//
//   run(builderConfig: BuilderConfiguration<BrowserBuilderSchema>): Observable<BuildEvent> {
//     const root = this.context.workspace.root;
//     const projectRoot = resolve(root, builderConfig.root);
//     const host = new virtualFs.AliasHost(this.context.host as virtualFs.Host<fs.Stats>);
//     const webpackBuilder = this.createWebpackBuilder({ ...this.context, host });
//     const getLoggingCb = this.createLoggingFactory();
//
//     const options = normalizeBrowserSchema(
//       host,
//       root,
//       resolve(root, builderConfig.root),
//       builderConfig.sourceRoot,
//       builderConfig.options,
//     );
//
//     return of(null).pipe(
//       concatMap(() => options.deleteOutputPath
//         ? this.(root, normalize(options.outputPath), this.context.host)
//         : of(null)),
//       concatMap(() => {
//         let webpackConfig;
//         try {
//           webpackConfig = this.buildWebpackConfig(root, projectRoot, host, options);
//         } catch (e) {
//           return throwError(e);
//         }
//
//         return webpackBuilder.runWebpack(webpackConfig, getLoggingCb(options.verbose || false));
//       }),
//       concatMap(buildEvent => {
//         if (buildEvent.success && !options.watch && options.serviceWorker) {
//           return new Observable(obs => {
//             augmentAppWithServiceWorker(
//               this.context.host,
//               root,
//               projectRoot,
//               resolve(root, normalize(options.outputPath)),
//               options.baseHref || '/',
//               options.ngswConfigPath,
//             ).then(
//               () => {
//                 obs.next({ success: true });
//                 obs.complete();
//               },
//               (err: Error) => {
//                 obs.error(err);
//               },
//             );
//           });
//         } else {
//           return of(buildEvent);
//         }
//       }),
//     );
//   }
//
//
//   private _deleteOutputDir(root: Path, outputPath: Path, host: virtualFs.Host) {
//     const resolvedOutputPath = resolve(root, outputPath);
//     if (resolvedOutputPath === root) {
//       throw new Error('Output path MUST not be project root directory!');
//     }
//
//     return host.exists(resolvedOutputPath).pipe(
//       concatMap(exists => exists
//         // TODO: remove this concat once host ops emit an event.
//         ? concat(host.delete(resolvedOutputPath), of(null)).pipe(last())
//         // ? of(null)
//         : of(null)),
//     );
//   }
// }
//
//
// export default BrowserBuilder;
