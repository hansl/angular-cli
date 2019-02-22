/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { BuilderContext, BuilderOutput, createBuilder } from '@angular-devkit/architect/src/index2';
import { getSystemPath, json, normalize, resolve } from '@angular-devkit/core';
import * as net from 'net';
import { Observable, from, of } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import * as webpack from 'webpack';
import * as WebpackDevServer from 'webpack-dev-server';
import { ArchitectPlugin } from '../plugins/architect';
import { WebpackFactory, WebpackLoggingCallback } from '../webpack/index2';
import { Schema as WebpackDevServerBuilderSchema } from './schema';

const webpackMerge = require('webpack-merge');


export type DevServerBuildResult = BuilderOutput & {
  port: number;
  family: string;
  address: string;
};

export function runWebpackDevServer(
  config: webpack.Configuration,
  context: BuilderContext,
  options: {
    devServerConfig?: WebpackDevServer.Configuration,
    logging?: WebpackLoggingCallback,
    webpackFactory?: WebpackFactory,
  } = {},
): Observable<BuilderOutput> {
  const createWebpack = options.webpackFactory || (config => of(webpack(config)));
  const log: WebpackLoggingCallback = options.logging
    || ((stats, config) => context.logger.info(stats.toString(config.stats)));

  config = webpackMerge(config, {
    plugins: [
      new ArchitectPlugin(context),
    ],
  });

  const devServerConfig = options.devServerConfig || config.devServer || {};
  if (devServerConfig.stats) {
    config.stats = devServerConfig.stats as webpack.Stats.ToStringOptionsObject;
  }
  // Disable stats reporting by the devserver, we have our own logger.
  devServerConfig.stats = false;

  return createWebpack(config).pipe(
    switchMap(webpackCompiler => new Observable(obs => {
      const server = new WebpackDevServer(webpackCompiler, devServerConfig);
      let result: DevServerBuildResult;

      webpackCompiler.hooks.done.tap('build-webpack', (stats) => {
        // Log stats.
        log(stats, config);

        obs.next({
          success: !stats.hasErrors(),
          ...result,
        } as DevServerBuildResult);
      });

      server.listen(
        devServerConfig.port === undefined ? 8080 : devServerConfig.port,
        devServerConfig.host === undefined ? 'localhost' : devServerConfig.host,
        function (this: net.Server, err) {
          if (err) {
            obs.error(err);
          } else {
            result = {
              success: true,
              port: this.address().port,
              family: this.address().family,
              address: this.address().address,
            };
          }
        },
      );

      // Teardown logic. Close the server when unsubscribed from.
      return () => server.close();
    })),
  );
}


export default createBuilder<
  json.JsonObject & WebpackDevServerBuilderSchema, DevServerBuildResult
>((options, context) => {
  const configPath = resolve(normalize(context.workspaceRoot), normalize(options.webpackConfig));

  return from(import(getSystemPath(configPath))).pipe(
    switchMap((config: webpack.Configuration) => runWebpackDevServer(config, context)),
  );
});
