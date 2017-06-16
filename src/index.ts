import xs from 'xstream';
import { run } from '@cycle/run';
import { makeDOMDriver } from '@cycle/dom';
import onionify from 'cycle-onionify';

import { Component, Sources, RootSinks } from './interfaces';
import { App } from './app';

import * as electron from 'electron';
import * as fs from 'fs';

const main : Component = onionify(App);

function electronDriver(req$) {
  const response$$ = req$.map(reqToRes$).flatten();
  response$$.addListener({next: () => {}, error: () => {}, complete: () => {}});
  return response$$;
  function reqToRes$(msg) {
    if (msg.dialog === "open") {
      return xs.create({
        start: listener => {
          electron.remote.dialog.showOpenDialog(electron.remote.getCurrentWindow(), msg.options, e => {
            listener.next(e);
            listener.complete();
          });
        },
        stop: () => {}
      });
    } else if (msg.type === "save") {
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
        stop: () => {}
      })
    } else if (msg.type === "writeFile") {
      return xs.create({
        start: listener => {
          fs.writeFile(msg.fileName, msg.data, (err) => listener.next(err))
          listener.complete()
        },
        stop: () => {}
      });
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
