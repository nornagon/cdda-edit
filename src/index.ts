import xs from 'xstream';
import { run } from '@cycle/run';
import { makeDOMDriver } from '@cycle/dom';
import onionify from 'cycle-onionify';

import { Component, Sources, RootSinks, ElectronMessage } from './interfaces';
import { App } from './app';

import * as electron from 'electron';
import * as fs from 'fs';

const main : Component = onionify(App);

function electronDriver(req$: xs<ElectronMessage>): xs<any> {
  const response$$ = req$.map(reqToRes$).flatten();
  response$$.addListener({next: () => {/*noop*/}, error: () => {/*noop*/}, complete: () => {/*noop*/}});
  return response$$;
  function reqToRes$(msg: ElectronMessage): xs<any> {
    if (msg.type === 'dialog') {
      if (msg.dialog === "open") {
        return xs.create({
          start: listener => {
            electron.remote.dialog.showOpenDialog(electron.remote.getCurrentWindow(), msg.options, e => {
              listener.next(e);
              listener.complete();
            });
          },
          stop: () => {/*noop*/}
        });
      } else if (msg.dialog === "save") {
        return xs.create({
          start: listener => {
            electron.remote.dialog.showSaveDialog(electron.remote.getCurrentWindow(), msg.options, fileName => {
              fs.writeFile(fileName, msg.data, err => {
                if (err) {
                  listener.error(err);
                } else {
                  listener.complete();
                }
              })
            })
          },
          stop: () => {/*noop*/}
        })
      } else {
        return xs.empty();
      }
    } else {
      return xs.empty();
    }
  }
}

const drivers : any = {
  DOM: makeDOMDriver('#app'),
  electron: electronDriver,
};
export const driverNames : string[] = Object.keys(drivers);

// Cycle apps (main functions) are allowed to return any number of sinks streams
// This sets defaults for all drivers that are not used by the app
const defaultSinks : (s : Sources) => RootSinks = sources => ({
  ...driverNames.map(n => ({ [n]: xs.never() })).reduce(Object.assign, {}),
  ...main(sources)
});

run(defaultSinks, drivers);
