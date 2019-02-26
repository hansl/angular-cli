#!/usr/bin/env node
/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { index2 } from '@angular-devkit/architect';
import { WorkspaceNodeModulesArchitectHost } from '@angular-devkit/architect/node';
import {
  dirname,
  experimental,
  json,
  logging,
  normalize,
  schema,
  tags, terminal,
} from '@angular-devkit/core';
import { NodeJsSyncHost } from '@angular-devkit/core/node';
import * as blessed from 'blessed';
import { existsSync } from 'fs';
import * as minimist from 'minimist';
import * as path from 'path';
import { last } from 'rxjs/operators';
import { MultiProgressBar } from '../src/progress';


function findUp(names: string | string[], from: string) {
  if (!Array.isArray(names)) {
    names = [names];
  }
  const root = path.parse(from).root;

  let currentDir = from;
  while (currentDir && currentDir !== root) {
    for (const name of names) {
      const p = path.join(currentDir, name);
      if (existsSync(p)) {
        return p;
      }
    }

    currentDir = path.dirname(currentDir);
  }

  return null;
}

/**
 * Show usage of the CLI tool, and exit the process.
 */
function usage(logger: logging.Logger, exitCode = 0): never {
  logger.info(tags.stripIndent`
    architect [project][:target][:configuration] [options, ...]

    Run a project target.
    If project/target/configuration are not specified, the workspace defaults will be used.

    Options:
        --help              Show available options for project target.
                            Shows this message instead when ran without the run argument.


    Any additional option is passed the target, overriding existing options.
  `);

  process.exit(exitCode);
  throw 0;  // The node typing sometimes don't have a never type for process.exit().
}

function _targetStringFromTarget({project, target, configuration}: index2.Target) {
  return `${project}:${target}${configuration !== undefined ? ':' + configuration : ''}`;
}


interface BarInfo {
  status?: string;
  builder: index2.BuilderInfo;
  target?: index2.Target;
}


async function _executeTarget(
  screen: blessed.Widgets.Screen,
  architect: index2.Architect,
  target: index2.Target,
) {
  // Create the box layout.
  const box = blessed.box({
    label: '[ ' + _targetStringFromTarget(target) + ' ]',
    parent: screen,
    draggable: true,
    mouse: true,
    keys: true,
    width: '80%',
    height: '90%',
    border: 'line',
    shrink: true,
  });
  const status = blessed.text({
    parent: box,
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    content: '...',
    bg: 'blue',
  });
  const bar = blessed.progressbar({
    parent: box,
    top: 1,
    left: 0,
    right: 0,
    height: 1,
    mouse: true,
    orientation: 'horizontal',
    pch: '#',
    filled: 0,
    value: 0,
    keys: true,
  });
  const log = blessed.scrollabletext({
    parent: box,
    top: 2,
    bottom: -1,
    left: -1,
    right: -1,
    mouse: true,
    scrollable: true,
    label: 'Logs output:',
    border: 'line',
    alwaysScroll: true,
    scrollbar: {
      ch: 'X',
    },
  });

  const resize = blessed.box({
    parent: box,
    right: -1,
    bottom: -1,
    content: '+',
    width: 1,
    height: 1,
    mouse: true,
  });
  let resizing = false;
  resize.on('mousedown', () => {
    resizing = true;
    resize.once('mouseup', () => resizing = false);
  });
  screen.on('mousemove', s => {
    if (resizing) {
      box.position.right = s.x;
      box.position.bottom = s.y;
    }
  });

  const logger = new logging.Logger('architect');
  logger.subscribe(entry => {
    log.append(blessed.text({
      content: entry.message,
    }));
  });

  const run = await architect.scheduleTarget(target, {}, { logger });
  run.progress.subscribe(
    update => {
      if (update.status !== undefined) {
        status.setContent(update.status);
      }
      if (update.current && update.total) {
        bar.setProgress((update.current / update.total * 100) | 0);
      }

      box.render();
    },
  );
  //     const data = bars.get(update.id) || {
  //       id: update.id,
  //       builder: update.builder,
  //       target: update.target,
  //       status: update.status || '',
  //       name: ((update.target ? _targetStringFromTarget(update.target) : update.builder.name)
  //               + ' '.repeat(80)
  //             ).substr(0, 40),
  //     };
  //
  //     if (update.status !== undefined) {
  //       data.status = update.status;
  //     }
  //
  //     switch (update.state) {
  //       case index2.BuilderProgressState.Error:
  //         data.status = 'Error: ' + update.error;
  //         bars.update(update.id, data);
  //         break;
  //
  //       case index2.BuilderProgressState.Stopped:
  //         data.status = 'Done.';
  //         bars.complete(update.id);
  //         bars.update(update.id, data, update.total, update.total);
  //         break;
  //
  //       case index2.BuilderProgressState.Waiting:
  //         bars.update(update.id, data);
  //         break;
  //
  //       case index2.BuilderProgressState.Running:
  //         bars.update(update.id, data, update.current, update.total);
  //         break;
  //     }
  //
  //     bars.render();
  //   },
  // );

  // Wait for full completion of the builder.
  // try {
    const result = await run.output.pipe(last()).toPromise();
  //
  //   if (result.success) {
  //     parentLogger.info(terminal.green('SUCCESS'));
  //   } else {
  //     parentLogger.info(terminal.yellow('FAILURE'));
  //   }
  //
  //   parentLogger.info('\nLogs:');
  //   logs.forEach(l => parentLogger.next(l));
  //
  //   await run.stop();
  //   bars.terminate();
  //
  //   return result.success ? 0 : 1;
  // } catch (err) {
  //   parentLogger.info(terminal.red('ERROR'));
  //   parentLogger.info('\nLogs:');
  //   logs.forEach(l => parentLogger.next(l));
  //
  //   parentLogger.fatal('Exception:');
  //   parentLogger.fatal(err.stack);
  //
  //   return 2;
  // }
  screen.render();
}


async function _runProgram(
  workspace: experimental.workspace.Workspace,
  args: string[],
  registry: schema.CoreSchemaRegistry,
): Promise<number> {
  const architectHost = new WorkspaceNodeModulesArchitectHost(workspace, workspace.root);
  const architect = new index2.Architect(architectHost, registry);
  let resolve: (status: number) => void;

  process.title = 'architect';
  const screen = blessed.screen({
    smartCSR: true,
    dockBorders: true,
    warnings: true,
  });

  screen.key(['q', 'C-q'], () => resolve(0));

  const data = workspace.listProjectNames().reduce((acc: string[][], projectName) => {
    const targets = workspace.getProjectTargets(projectName);

    return [
      ...acc,
      ...Object.keys(targets).reduce((acc: string[][], targetName) => {
        return [
          ...acc,
          [projectName, targetName, ''],
          ...Object.keys(targets[targetName].configurations || {}).map(configName => {
            return [projectName, targetName, configName];
          }),
        ];
      }, []),
    ];
  }, []);

  const targetsBox = blessed.listtable({
    label: '[ Targets ]',
    parent: screen,
    left: 0,
    top: 0,
    width: 'shrink',
    height: 20,
    draggable: true,
    scrollable: true,
    invertSelected: true,
    keys: true,
    mouse: true,
    vi: true,
    style: {
      header: {
        fg: 'blue',
        bold: true,
      },
      cell: {
        fg: 'white',
        selected: {
          bg: 'blue',
        },
      },
    },
    data: [['Project', 'Target', 'Configuration'], ...data],
    scrollbar: {
      ch: '#',
    },
    border: 'line',
  });

  targetsBox.focus();
  targetsBox.on('select', (_, i) => {
    const selection = data[i - 1];
    const target: index2.Target = {
      project: selection[0],
      target: selection[1],
      ...(selection[2] ? { configuration: selection[2] } : 0),
    };
    _executeTarget(screen, architect, target);
  });

  setInterval(() => screen.render(), 100);
  screen.render();

  return await new Promise<number>(r => {
    resolve = r;
  })
  .catch(err => {
    console.error(err.stack);

    return -1;
  })
  .then(status => {
    // Cleanup on aisle 3.
    screen.destroy();

    return status;
  });
}


async function main(args: string[]): Promise<number> {
  /** Parse the command line. */
  const argv = minimist(args, { boolean: ['help'] });

  const registry = new schema.CoreSchemaRegistry();
  registry.addPostTransform(schema.transforms.addUndefinedDefaults);

  const currentPath = normalize(process.cwd());
  const host = new NodeJsSyncHost();
  const workspace = await experimental.workspace.Workspace.fromPath(host, currentPath, registry);

  // return await _executeTarget(logger, workspace, root, argv, registry);

  return await _runProgram(workspace, argv, registry);
}

main(process.argv.slice(2))
  .then(code => {
    process.exit(code);
  }, err => {
    console.error('Error: ' + err.stack || err.message || err);
    process.exit(-1);
  });
