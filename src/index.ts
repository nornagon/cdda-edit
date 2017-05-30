import xs from 'xstream';
import { run } from '@cycle/run';
import { makeDOMDriver } from '@cycle/dom';
import onionify from 'cycle-onionify';

import { Component, Sources, RootSinks } from './interfaces';
import { App } from './app';

import * as electron from 'electron';

const main : Component = onionify(App);

function electronDriver(req$) {
  const response$$ = req$.map(reqToRes$).flatten();
  response$$.addListener({next: () => {}, error: () => {}, complete: () => {}});
  return response$$;
  function reqToRes$(msg) {
    if (msg.dialog === "open") {
      return xs.create({
        start: listener => {
          electron.remote.dialog.showOpenDialog(electron.remote.getCurrentWindow(), msg.options, e => listener.next(e));
        },
        stop: () => {}
      });
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
